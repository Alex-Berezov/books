import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { Request } from 'express';
import * as Sentry from '@sentry/node';

/**
 * Ключи, значения которых не уезжают во внешний сервис (`LEGACY-115`).
 *
 * 🔴 Маска существует с самого начала, но применялась только к телу запроса,
 * а `headers`, `query` и `params` уходили в событие как есть. В заголовках
 * лежат `Authorization` с рабочим JWT и `Cookie` с сессией, то есть в проекте
 * Sentry оседали действующие токены доступа тех, чей запрос упал с 5xx.
 *
 * ⚠️ Регистр не важен: Express отдаёт имена заголовков в нижнем регистре
 * (`authorization`, `cookie`), а тело запроса приходит в чужом регистре
 * (`Authorization`, `accessToken`), и оба случая закрывает флаг `i`.
 *
 * ⚠️ Совпадение частичное и это намеренно: `accessToken`, `refresh_token`,
 * `set-cookie` и `proxy-authorization` попадают под маску сами.
 */
const SENSITIVE_KEY_PATTERN = /password|token|authorization|secret|cookie/i;

/**
 * Предел глубины обхода в `redactKeys` (`LEGACY-188`). Вход — уровень 1.
 *
 * ⚠️ Четыре, а не пять: все наблюдаемые формы мельче (`{ user: { password } }`
 * и `?filter[token]=` — второй уровень), а меньшая глубина ошибается
 * в безопасную сторону. Непройденный контейнер заменяется меткой и утечь
 * не может; теряется только диагностика. Решение арбитра от 30.08.2026.
 */
const MAX_REDACT_DEPTH = 4;

/**
 * Сколько элементов массива уходит в событие целиком (`LEGACY-188`).
 *
 * ⚠️ Событие Sentry имеет предел размера и обрезается молча, теряя как раз
 * хвост. Явный потолок с меткой об усечении отличает «их было больше»
 * от «столько и было».
 */
const MAX_REDACT_ARRAY_ITEMS = 20;

/**
 * Global exception filter that reports 5xx errors to Sentry.
 * 4xx (400/401/403/404/429) are deliberately ignored to reduce noise.
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(SentryExceptionFilter.name);
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly enabled: boolean,
  ) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost) {
    try {
      if (this.enabled) {
        const ctx = host.switchToHttp();
        const req = ctx.getRequest<Request>();

        const status = this.getStatus(exception);
        const isServerError = status >= 500;
        const isIgnoredClientError = [
          HttpStatus.BAD_REQUEST,
          HttpStatus.UNAUTHORIZED,
          HttpStatus.FORBIDDEN,
          HttpStatus.NOT_FOUND,
          HttpStatus.TOO_MANY_REQUESTS,
        ].includes(status);

        if (isServerError && !isIgnoredClientError) {
          Sentry.withScope((scope) => {
            if (req) {
              const { method, path } = req;
              const routePath = this.getRoutePath(req);
              const safeUrl = this.redactUrl(req.originalUrl);
              scope.setTag('method', method);
              scope.setTag('route', routePath ?? path ?? 'unknown');
              scope.setTag('status_code', String(status));
              scope.setContext('request', {
                url: `${req.protocol}://${req.get('host')}${safeUrl}`,
                method,
                headers: this.redactKeys(req.headers),
                query: this.redactKeys(req.query),
                params: this.redactKeys(req.params),
                body: this.redactKeys(req.body),
                ip: req.ip,
              });
              // Optional lightweight breadcrumbs for request timeline
              const breadcrumbs = [
                { category: 'http', level: 'info', message: `${method} ${safeUrl}` },
                { category: 'http', level: 'error', message: `→ ${status}` },
              ] as const;
              scope.addBreadcrumb(breadcrumbs[0]);
              scope.addBreadcrumb(breadcrumbs[1]);
              const user = this.getUser(req);
              if (user?.userId) {
                scope.setUser({ id: String(user.userId) });
              }
            }
            Sentry.captureException(exception);
          });
        }
      }
    } catch (e) {
      // Never break exception handling due to Sentry issues
      this.logger.debug(`Sentry capture failed: ${String(e)}`);
    }

    // Continue standard Nest exception handling
    return super.catch(exception, host);
  }

  private getStatus(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  /**
   * Общий редактор ключей для всего, что кладётся в контекст события.
   *
   * ⚠️ Любое новое поле контекста обязано проходить через него — это записано
   * правилом в `LEGACY-115`, потому что заголовки миновали маску ровно так:
   * поле добавили рядом с уже замаскированным телом и сочли вопрос закрытым.
   *
   * ⚠️ Проход **рекурсивный** с 30.08.2026 (`LEGACY-188`): вложенное
   * `{ user: { password } }` и `{ items: [{ token }] }` чистятся тоже.
   * До этого проход был по верхнему уровню, и вложенный секрет уезжал
   * во внешний сервис целиком.
   */
  private redactKeys(value: unknown): unknown {
    return this.redactValue(value, 1, new Set<object>());
  }

  /**
   * Один узел обхода: `depth` — уровень самого `value`, вход равен 1.
   *
   * ⚠️ Предел глубины проверяется **только для контейнеров**. Скаляр на любом
   * уровне уже прошёл проверку имени в цикле родителя, поэтому обрезать его
   * незачем — это стоило бы диагностики без выигрыша. Контейнер же обрезается
   * обязательно: его ключи мы не смотрели и поручиться за них не можем.
   *
   * ⚠️ `seen` — множество **текущего пути**, а не всего обхода: объект
   * добавляется перед спуском и снимается после. Глобальное множество сочло
   * бы циклом повторную ссылку на один объект из двух соседних ключей
   * и молча съело бы содержимое второй.
   */
  private redactValue(value: unknown, depth: number, seen: Set<object>): unknown {
    const binary = this.describeBinary(value);
    if (binary) return binary;

    const container = this.getContainer(value);
    if (!container) return value;
    if (depth > MAX_REDACT_DEPTH) return '[MaxDepth]';

    if (seen.has(container)) return '[Circular]';
    seen.add(container);
    try {
      return Array.isArray(container)
        ? this.redactArray(container, depth, seen)
        : this.redactObject(container, depth, seen);
    } finally {
      seen.delete(container);
    }
  }

  /**
   * ⚠️ Ключ, совпавший с маской, заменяется целиком и **внутрь не заходим**:
   * так `authorization` с объектным значением остаётся `[Filtered]`, как было
   * до рекурсии, и ошибка тут в безопасную сторону.
   *
   * 🔴 Клон строится через `Object.create(null)`, а не литералом `{}`. `JSON.parse`
   * заводит `__proto__` обычным собственным ключом, и `Object.keys` его отдаёт;
   * но присваивание `clone['__proto__']` объекту с обычным прототипом уходит
   * в сеттер `Object.prototype.__proto__` — собственного ключа не появляется,
   * значение пропадает, а прототипом клона становится разобранное тело запроса.
   * Тело без прототипа сеттера не имеет, и присваивание кладёт обычный ключ.
   * Снятый спред `{ ...value }` этим не страдал, поэтому переход на цикл был
   * регрессией; найдено ревью 30.08.2026 до коммита.
   */
  private redactObject(
    value: Record<string, unknown>,
    depth: number,
    seen: Set<object>,
  ): Record<string, unknown> {
    const clone = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      clone[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '[Filtered]'
        : this.redactValue(value[key], depth + 1, seen);
    }
    return clone;
  }

  private redactArray(value: unknown[], depth: number, seen: Set<object>): unknown[] {
    const kept = value
      .slice(0, MAX_REDACT_ARRAY_ITEMS)
      .map((item) => this.redactValue(item, depth + 1, seen));
    const dropped = value.length - MAX_REDACT_ARRAY_ITEMS;
    if (dropped > 0) kept.push(`[Truncated: ${dropped} more]`);
    return kept;
  }

  /**
   * Адрес события без значений секретных параметров строки запроса (`LEGACY-189`).
   *
   * 🔴 Редактор ключей сюда неприменим по форме: он маскирует ключи объекта, а
   * `req.originalUrl` — текст. Без этого разбора значение, замаскированное в
   * `query`, тем же событием уезжало открытым в `url` и вторым разом в хлебной
   * крошке, то есть маска на `query` закрывала одно место из трёх.
   *
   * ⚠️ Разбором, а не регуляркой по строке: параметр может повторяться, быть
   * пустым и содержать процентное кодирование. Путь не трогаем — без него
   * событие бесполезно.
   */
  private redactUrl(rawUrl: string): string {
    const queryStart = rawUrl.indexOf('?');
    if (queryStart === -1) return rawUrl;

    const pathPart = rawUrl.slice(0, queryStart);
    const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
    for (const key of Array.from(new Set(params.keys()))) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        params.set(key, '[Filtered]');
      }
    }
    const query = params.toString();
    return query ? `${pathPart}?${query}` : pathPart;
  }

  /** Значение, внутрь которого редактор заходит: массив или простой объект. */
  private getContainer(value: unknown): unknown[] | Record<string, unknown> | undefined {
    // `Array.isArray` сужает `unknown` до `any[]`, а не до `unknown[]` — приведение
    // возвращает проверку типов внутрь элементов, а не отключает её.
    if (Array.isArray(value)) return value as unknown[];
    return this.isPlainObject(value) ? value : undefined;
  }

  /**
   * 🔴 Двоичное тело внутрь редактора не пускается вовсе.
   *
   * На `POST /uploads/direct` тело разбирается сырым `express.raw` с любым типом
   * содержимого, то есть `req.body` там — `Buffer` размером
   * до `UPLOADS_MAX_AUDIO_MB + 10` (по умолчанию 210 МБ).
   * `Array.isArray(Buffer)` ложно, а `isPlainObject` истинно, поэтому редактор
   * разворачивал бы его в объект «ключ на байт» — сотни миллионов ключей, собираемых
   * внутри обработчика исключения, и потолок `MAX_REDACT_ARRAY_ITEMS` сюда не достаёт.
   * Проверка стоит **до** `getContainer` и отдаёт только размер: содержимое файла
   * в событии не нужно, а знать, что тело было двоичным и каким, — нужно.
   * Найдено ревью 30.08.2026 до коммита.
   */
  private describeBinary(value: unknown): string | undefined {
    if (ArrayBuffer.isView(value)) return `[Binary: ${value.byteLength} bytes]`;
    if (value instanceof ArrayBuffer) return `[Binary: ${value.byteLength} bytes]`;
    return undefined;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private getRoutePath(req: Request): string | undefined {
    // Express adds route.path to req; types do not expose it
    const maybeWithRoute = req as unknown as { route?: { path?: unknown } };
    const p = maybeWithRoute.route?.path;
    return typeof p === 'string' ? p : undefined;
  }

  /**
   * Пользователь запроса для атрибуции события (`LEGACY-187`).
   *
   * 🔴 Тип сужен до одного поля намеренно. До 30.08.2026 здесь стояло `id`,
   * а единственная стратегия (`auth/strategies/jwt.strategy.ts`) кладёт
   * в запрос `userId` — как и весь остальной код (`roles.guard.ts`,
   * `rate-limit.guard.ts`, `moderator-roles.service.ts`). Из-за расхождения
   * ветка `setUser` не срабатывала ни разу, и события уходили без атрибуции
   * вовсе. Отсутствие `email` в типе — тоже часть правки: вернуть почту
   * случайным `user.email` в этот вызов теперь нельзя.
   * Решение арбитра от 30.08.2026.
   *
   * 🔴 **Это закрывает канал `setUser`, а не почту вообще.** Второй канал открыт
   * и живёт в этом же файле: `setContext('request', { body: redactKeys(req.body) })`,
   * а `SENSITIVE_KEY_PATTERN` слова `email` не содержит — тело `POST /auth/login`,
   * упавшее в 500, кладёт в событие `{ email: '...', password: '[Filtered]' }`.
   * Расширение маски выходит за границы `LEGACY-187` (её `Location` — только этот
   * вызов) и заведено отдельной записью `LEGACY-332`. Не считать вопрос закрытым.
   */
  private getUser(req: Request): { userId?: string } | undefined {
    const r = req as Request & { user?: { userId?: string } };
    return r.user;
  }
}
