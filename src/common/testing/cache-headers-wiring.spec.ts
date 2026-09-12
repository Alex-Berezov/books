import { APP_INTERCEPTOR } from '@nestjs/core';
import type { MiddlewareConsumer } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { PrivateVaryInterceptor } from '../interceptors/private-vary.interceptor';
import { DefaultCacheControlMiddleware } from '../middleware/default-cache-control.middleware';
import {
  SRC_ROOT,
  VERBS,
  decoratorArgsAll,
  decoratorBlocks,
  decoratorIncludes,
  listControllerFiles,
  readController,
  relativeToSrc,
  stripComments,
} from './controller-decorators';

/**
 * Сторож кэш-заголовков (`LEGACY-107`, `LEGACY-108`, `LEGACY-174`).
 *
 * До 12.09.2026 заголовок ставил только `PublicCacheInterceptor`, навешенный
 * на 23 обработчика из 317; остальные уходили без `Cache-Control` вовсе, и
 * общий кэш был вправе хранить их эвристически (RFC 9111 §4.2.2). Живая проба
 * прода 11.08.2026 показала это на `GET /users/me`, `/users/me/activities`,
 * `/bookshelf`, `/reading-progress`, `/comments/my`.
 *
 * 🔴 Список публичных обработчиков зафиксирован **явно**, а не выведен из
 * наличия интерцептора. Выведенный список рос бы вместе с ним: навесил
 * `PublicCacheInterceptor` на новый контроллер — обработчики сами попали
 * в «ожидаемое» — сторож зелёный. Образец и причина — `PUBLIC_ROUTES`
 * в `test/closed-routes-unauthorized.e2e-spec.ts` (`LEGACY-234`).
 *
 * Поэтому расхождение красит проверку **в обе стороны**: и новый публичный
 * обработчик, заведённый молча, и исчезнувший из разбора.
 */

/** Ниже этих чисел обход считается сломанным, а не репозиторий — поредевшим. */
const MIN_CONTROLLERS = 40;
const MIN_HANDLERS = 250;

/**
 * Обработчики, которым публичный кэш разрешён — обоими способами сразу:
 * под `PublicCacheInterceptor` без `@NoPublicCache()` либо с ручным
 * `@Header('Cache-Control', 'public, …')`. Формат — `<файл> → <метод>`.
 */
const PUBLIC_CACHE_HANDLERS: readonly string[] = [
  'modules/public/public.controller.ts → authorBookCards',
  'modules/public/public.controller.ts → authorBySlug',
  'modules/public/public.controller.ts → authorLetters',
  'modules/public/public.controller.ts → authorsList',
  'modules/public/public.controller.ts → bookCards',
  'modules/public/public.controller.ts → categoriesBySlug',
  'modules/public/public.controller.ts → categoriesList',
  'modules/public/public.controller.ts → categoryBookCards',
  'modules/public/public.controller.ts → findAll',
  'modules/public/public.controller.ts → getPage',
  'modules/public/public.controller.ts → getPageByKey',
  'modules/public/public.controller.ts → overview',
  'modules/public/public.controller.ts → related',
  'modules/public/public.controller.ts → slugRedirect',
  'modules/public/public.controller.ts → tagBookCards',
  'modules/public/public.controller.ts → tagsBySlug',
  'modules/public/public.controller.ts → tagsList',
  // Второй способ: ручной `@Header('Cache-Control', 'public, max-age=3600')`.
  // Обе схемы отчёта агента публичны по смыслу — это статические JSON Schema,
  // одинаковые для всех, — и от заголовков запроса не зависят.
  'modules/rights-agent/rights-agent.controller.ts → getLatestSchema',
  'modules/rights-agent/rights-agent.controller.ts → getSchemaByVersion',
  'modules/seo/seo.controller.ts → resolve',
  'modules/seo/seo.controller.ts → resolveWithLang',
  // Карта сайта и `robots.txt` одинаковы для всех и от запрашивающего
  // не зависят. Публичными их объявили 12.09.2026: до этого своего заголовка
  // у них не было вовсе, а после инверсии умолчания они стали получать
  // `private, no-store` — неверно по смыслу (решение арбитра, вариант A).
  'modules/sitemap/sitemap.controller.ts → robots',
  'modules/sitemap/sitemap.controller.ts → sitemapForLang',
  'modules/sitemap/sitemap.controller.ts → sitemapIndex',
];

type Handler = { id: string; publicCache: boolean };

/**
 * Глаголы берутся из общего модуля, а не переписываются здесь: третья
 * рукописная копия списка — это третий сторож, у которого `@All` или
 * `@Options` может оказаться забытым, и два зелёных сторожа с разными
 * ответами на один вход (`LEGACY-290`).
 */
const hasVerb = (text: string): boolean =>
  VERBS.some((verb) => new RegExp(`@${verb[0].toUpperCase()}${verb.slice(1)}\\s*\\(`).test(text));

/**
 * 🔴 Второй способ объявить ответ общедоступным для кэша — ручной
 * `@Header('Cache-Control', 'public, …')` (`rights-agent.controller.ts:53,61`).
 * Сторож, ключующийся только на интерцептор, его не видит вовсе: поставят
 * завтра `@Header('Cache-Control', 'public, s-maxage=300')` на маршрут,
 * читающий `Accept-Language` или страну, — и ответ уедет в общий кэш мимо
 * всех рубежей при зелёном храповике.
 */
const hasPublicHeader = (text: string): boolean =>
  decoratorArgsAll(text, 'Header').some((args) => {
    // 🔴 Значение берётся именно у ключа `Cache-Control`, а не ищется по всему
    // вызову. Независимая проверка «где-то есть `Cache-Control` и где-то есть
    // `public`» даёт ложное срабатывание на `@Header('X-Cache-Control-Debug',
    // 'public')` и на `@Header('Cache-Control', 'private, no-cache="public"')` —
    // валидной форме RFC 9111 §5.2.2.2, чьё значение приватно.
    const pair = /^@Header\s*\(\s*['"`]Cache-Control['"`]\s*,\s*['"`]([^'"`]*)['"`]/i.exec(args);
    if (!pair) return false;

    const value = pair[1].toLowerCase();
    if (/\bprivate\b/.test(value) || /\bno-store\b/.test(value)) return false;

    // `s-maxage` — директива общего кэша, и слова `public` рядом с ней
    // не требуется: без токена `public` ответ на GET без авторизации всё равно
    // хранится и переиспользуется CDN (RFC 9111 §5.2.2.10).
    return /\bpublic\b/.test(value) || /\bs-maxage\b/.test(value);
  });

/**
 * Имя метода из строки, к которой относился блок декораторов. Сигнатуру целиком
 * брать нельзя: список сравнивается построчно, и добавленный параметр
 * обработчика красил бы сторож, не меняя ничего в кэше.
 */
const methodName = (ownerLine: string): string =>
  ownerLine
    .replace(/^(?:public|private|protected)\s+/, '')
    .replace(/^async\s+/, '')
    .replace(/\s*\(.*$/s, '')
    .trim();

const collect = (): { handlers: Handler[]; controllers: number; skipped: string[] } => {
  const files = listControllerFiles(SRC_ROOT);
  const handlers: Handler[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const blocks = decoratorBlocks(stripComments(readController(file)));
    const classBlock = blocks.find((block) => block.ownerLine.includes('class '));
    // 🔴 Не `continue` молча: контроллер, у которого не разобрался блок класса,
    // выпал бы вместе со всеми своими обработчиками, а пороги ниже это стерпели
    // бы — до семи файлов и 67 обработчиков в запасе. Нераспознанный файл —
    // отдельный исход, а не пропуск (`L-015`); так же поступает `collectRoutes`
    // в том же модуле.
    if (!classBlock) {
      skipped.push(relativeToSrc(file));
      continue;
    }

    const classInterceptor = decoratorIncludes(
      classBlock.text,
      'UseInterceptors',
      'PublicCacheInterceptor',
    );
    const classNoPublicCache = /@NoPublicCache\s*\(/.test(classBlock.text);

    for (const block of blocks) {
      if (block === classBlock || !hasVerb(block.text)) continue;
      const interceptor =
        classInterceptor ||
        decoratorIncludes(block.text, 'UseInterceptors', 'PublicCacheInterceptor');
      const noPublicCache = classNoPublicCache || /@NoPublicCache\s*\(/.test(block.text);
      handlers.push({
        id: `${relativeToSrc(file)} → ${methodName(block.ownerLine)}`,
        publicCache: (interceptor && !noPublicCache) || hasPublicHeader(block.text),
      });
    }
  }

  return { handlers, controllers: files.length, skipped };
};

describe('кэш-заголовки объявлены на каждом маршруте', () => {
  const { handlers, controllers, skipped } = collect();

  it(`разбор находит не меньше ${MIN_CONTROLLERS} контроллеров и ${MIN_HANDLERS} обработчиков`, () => {
    expect(controllers).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
    expect(handlers.length).toBeGreaterThanOrEqual(MIN_HANDLERS);
  });

  it('не пропускает ни одного контроллера из-за неразобранного блока класса', () => {
    expect(skipped).toEqual([]);
  });

  /**
   * 🔴 Сам разбор — тоже сторож, и он обязан уметь ошибаться громко.
   * Регулярка вида `@UseInterceptors\(\[^)]*PublicCacheInterceptor` обрывается
   * на первой `)`, поэтому интерцептор после аргумента со скобками она
   * не видит — обработчик числится непубличным при зелёном храповике.
   * Ровно от этого в `controller-decorators.ts` заведён разбор по балансу
   * скобок (`LEGACY-290`).
   */
  describe('разбор аргументов декоратора', () => {
    it('видит интерцептор после аргумента со скобками', () => {
      const block = "@UseInterceptors(FileInterceptor('file'), PublicCacheInterceptor)";

      expect(decoratorIncludes(block, 'UseInterceptors', 'PublicCacheInterceptor')).toBe(true);
    });

    it('не путает интерцептор с однокоренным соседом', () => {
      const block = '@UseInterceptors(SoftPublicCacheInterceptorX)';

      expect(decoratorIncludes(block, 'UseInterceptors', 'PublicCacheInterceptor')).toBe(false);
    });

    it('видит публичный кэш, объявленный ручным заголовком', () => {
      expect(hasPublicHeader("@Header('Cache-Control', 'public, max-age=3600')")).toBe(true);
    });

    it('не считает публичным приватный ручной заголовок', () => {
      expect(hasPublicHeader("@Header('Cache-Control', 'private, no-store')")).toBe(false);
    });

    /**
     * 🔴 `@Header` повторяем, в отличие от `@UseGuards` и `@UseInterceptors`.
     * Разбор по первому вхождению отвечал про чужой заголовок и не видел
     * нужный — сторож оставался зелёным на публично кэшируемом обработчике.
     */
    it('видит Cache-Control, объявленный не первым заголовком', () => {
      const block = [
        "@Get('feed')",
        "@Header('Content-Type', 'application/xml')",
        "@Header('Cache-Control', 'public, s-maxage=300')",
      ].join('\n');

      expect(hasPublicHeader(block)).toBe(true);
    });

    /**
     * `s-maxage` — директива общего кэша, слова `public` рядом не требуется:
     * ответ хранится и переиспользуется CDN и без него.
     */
    it('считает публичным s-maxage без слова public', () => {
      expect(hasPublicHeader("@Header('Cache-Control', 's-maxage=300')")).toBe(true);
    });

    it('не путает чужой заголовок со схожим именем', () => {
      expect(hasPublicHeader("@Header('X-Cache-Control-Debug', 'public')")).toBe(false);
    });

    /**
     * `no-cache="public"` — валидная форма RFC 9111 §5.2.2.2, чьё значение
     * приватно. Поиск слова `public` по всему вызову объявил бы её публичной.
     */
    it('не считает публичным private с public внутри значения', () => {
      expect(hasPublicHeader(`@Header('Cache-Control', 'private, no-cache="public"')`)).toBe(false);
    });
  });

  /**
   * 🔴 Регистрация — половина правки. Интерцептор, лежащий в файле и никуда
   * не подключённый, выглядит работающим: типы, линт и его собственные юниты
   * зелёные, а ни один ответ заголовка не получает.
   */
  it('PrivateVaryInterceptor подключён глобально', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as unknown[];
    const globals = providers.filter(
      (provider): provider is { provide: unknown; useClass?: unknown } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        (provider as { provide: unknown }).provide === APP_INTERCEPTOR,
    );

    expect(globals.map((provider) => provider.useClass)).toContain(PrivateVaryInterceptor);
  });

  /**
   * 🔴 То же и для middleware, и здесь это важнее: именно он ставит сам
   * `Cache-Control`, и именно он покрывает отказы гвардов (401, 403, 429),
   * до которых интерцепторы не доходят вовсе.
   *
   * Проверяется применение к маршрутам, а не только наличие класса: `configure`,
   * который ничего не применил, — ровно тот отказ, который живая e2e-проба
   * поймала на 401.
   */
  it('DefaultCacheControlMiddleware применён ко всем маршрутам', () => {
    const applied: Array<{ middleware: unknown[]; routes: unknown[] }> = [];
    const consumer = {
      apply: (...middleware: unknown[]) => {
        const entry = { middleware, routes: [] as unknown[] };
        applied.push(entry);
        return {
          forRoutes: (...routes: unknown[]) => {
            entry.routes = routes;
            return consumer;
          },
          exclude: () => ({ forRoutes: (...routes: unknown[]) => (entry.routes = routes) }),
        };
      },
    } as unknown as MiddlewareConsumer;

    new AppModule().configure(consumer);

    const entry = applied.find((item) => item.middleware.includes(DefaultCacheControlMiddleware));
    expect(entry).toBeDefined();
    expect(entry?.routes).toContain('{*path}');
  });

  it('публичный кэш разрешён ровно зафиксированному списку обработчиков', () => {
    const actual = handlers
      .filter((handler) => handler.publicCache)
      .map((handler) => handler.id)
      .sort();

    expect(actual).toEqual([...PUBLIC_CACHE_HANDLERS].sort());
  });
});
