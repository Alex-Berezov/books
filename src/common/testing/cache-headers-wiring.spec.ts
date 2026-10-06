import { APP_INTERCEPTOR } from '@nestjs/core';
import type { MiddlewareConsumer } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { PrivateVaryInterceptor } from '../interceptors/private-vary.interceptor';
import { DefaultCacheControlMiddleware } from '../middleware/default-cache-control.middleware';
import {
  NEST_COMMON,
  SRC_ROOT,
  controllersIn,
  hasInterceptor,
  isFrom,
  listControllerFiles,
  parseControllerFile,
  parseSource,
  relativeToSrc,
  routeDecoratorsOf,
  stringValue,
} from './controller-decorators';
import type { ControllerInfo, DecoratorUse } from './controller-decorators';
import { PUBLIC_CACHE_HANDLERS } from './public-cache-handlers';

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

type Handler = { id: string; publicCache: boolean };

/**
 * 🔴 Второй способ объявить ответ общедоступным для кэша — ручной
 * `@Header('Cache-Control', 'public, …')` (`rights-agent.controller.ts:53,61`).
 * Сторож, ключующийся только на интерцептор, его не видит вовсе: поставят
 * завтра `@Header('Cache-Control', 'public, s-maxage=300')` на маршрут,
 * читающий `Accept-Language` или страну, — и ответ уедет в общий кэш мимо
 * всех рубежей при зелёном храповике.
 *
 * `@Header` повторяем, в отличие от `@UseGuards` и `@UseInterceptors`: смотрятся
 * **все** его вхождения, а не первое. Значение берётся именно у ключа
 * `Cache-Control`, а не ищется по всему вызову: `@Header('X-Cache-Control-Debug',
 * 'public')` публичным не считается, а `@Header('Cache-Control', 'private,
 * no-cache="public"')` — валидная форма RFC 9111 §5.2.2.2 с приватным значением.
 *
 * ⚠️ Значение, собранное выражением (`@Header('Cache-Control', CACHE_VALUE)`),
 * разобрать нельзя, и молчать на нём значит пропустить публичный кэш: такой
 * заголовок считается публичным, пока обработчик не внесён в список явно.
 */
const hasPublicHeader = (uses: readonly DecoratorUse[]): boolean =>
  uses
    .filter((use) => isFrom(use, 'Header', NEST_COMMON))
    .some((use) => {
      const [key, valueArg] = use.args;
      const name = stringValue(key);
      if (name !== undefined && name.toLowerCase() !== 'cache-control') return false;

      const value = stringValue(valueArg)?.toLowerCase();
      if (value === undefined) return true;
      if (/\bprivate\b/.test(value) || /\bno-store\b/.test(value)) return false;

      // `s-maxage` — директива общего кэша, и слова `public` рядом с ней
      // не требуется: без токена `public` ответ на GET без авторизации всё равно
      // хранится и переиспользуется CDN (RFC 9111 §5.2.2.10).
      return /\bpublic\b/.test(value) || /\bs-maxage\b/.test(value);
    });

/**
 * Обработчики контроллеров с признаком публичного кэша. Обработчик — метод
 * с HTTP-декоратором (глаголы берутся из общего модуля: третья рукописная
 * копия списка — это третий сторож, у которого `@All` или `@Options` может
 * оказаться забытым, `LEGACY-290`). Интерцептор и `@NoPublicCache()` берутся
 * с метода и с класса, из всех вхождений `@UseInterceptors`.
 */
const handlersOf = (controllers: readonly ControllerInfo[]): Handler[] =>
  controllers.flatMap((controller) => {
    const classInterceptor = hasInterceptor(controller.decorators, 'PublicCacheInterceptor');
    const classNoPublicCache = hasNoPublicCache(controller.decorators);

    return controller.handlers
      .filter((handler) => routeDecoratorsOf(handler).length > 0)
      .map((handler) => {
        const interceptor =
          classInterceptor || hasInterceptor(handler.decorators, 'PublicCacheInterceptor');
        const noPublicCache = classNoPublicCache || hasNoPublicCache(handler.decorators);
        return {
          id: `${controller.file} → ${handler.name}`,
          publicCache: (interceptor && !noPublicCache) || hasPublicHeader(handler.decorators),
        };
      });
  });

/**
 * `@NoPublicCache()` — только импортированный из `no-public-cache.decorator`: одноимённая
 * пустышка из другого модуля метаданных `NO_PUBLIC_CACHE` не ставит, интерцептор отдаёт
 * `public`, а сторож без этой сверки счёл бы обработчик непубличным (то же правило —
 * в `public-cache-caller-independent.spec.ts`).
 */
const hasNoPublicCache = (uses: readonly DecoratorUse[]): boolean =>
  uses.some(
    (use) =>
      use.module !== '' && isFrom(use, 'NoPublicCache', 'decorators/no-public-cache.decorator'),
  );

const collect = (): { handlers: Handler[]; controllers: number; skipped: string[] } => {
  const files = listControllerFiles(SRC_ROOT);
  const parsed = files.map((file) => ({ file, found: parseControllerFile(file) }));
  // 🔴 Не молча: контроллер, у которого не нашёлся класс под `@Controller`, выпал бы
  // вместе со всеми своими обработчиками, а пороги ниже это стерпели бы — до семи
  // файлов и 67 обработчиков в запасе. Нераспознанный файл — отдельный исход,
  // а не пропуск (`L-015`); так же поступает `collectRoutes` в том же модуле.
  const skipped = parsed
    .filter(({ found }) => found.length === 0)
    .map(({ file }) => relativeToSrc(file));

  return {
    handlers: handlersOf(parsed.flatMap(({ found }) => found)),
    controllers: files.length,
    skipped,
  };
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
   * 🔴 Сам разбор — тоже сторож, и он обязан уметь ошибаться громко. Каждый
   * краевой вход прогоняется на синтетическом контроллере; общий разбор —
   * по AST, поэтому скобки внутри аргументов, псевдонимы импорта и повторные
   * вхождения декораторов ему не мешают (`LEGACY-290`).
   */
  describe('разбор декораторов на синтетическом контроллере', () => {
    const IMPORTS =
      "import { Controller, Get, Post, All, Header, UseInterceptors } from '@nestjs/common';\nimport { PublicCacheInterceptor } from '../public-cache.interceptor';";
    const idsOf = (code: string): Handler[] =>
      handlersOf(controllersIn(parseSource(`${IMPORTS}\n${code}`), 'fixture.controller.ts'));
    const publicOf = (code: string): boolean[] => idsOf(code).map((handler) => handler.publicCache);
    const handlerCode = (decorators: string): string =>
      `@Controller() class C { @Get() ${decorators} h() {} }`;

    it('видит интерцептор после аргумента со скобками', () => {
      expect(
        publicOf(handlerCode("@UseInterceptors(FileInterceptor('file'), PublicCacheInterceptor)")),
      ).toEqual([true]);
    });

    it('видит интерцептор во втором @UseInterceptors узла', () => {
      expect(
        publicOf(handlerCode('@UseInterceptors(A) @UseInterceptors(PublicCacheInterceptor)')),
      ).toEqual([true]);
    });

    it('видит интерцептор под псевдонимом импорта', () => {
      const code = [
        "import { PublicCacheInterceptor as P } from '../public-cache.interceptor';",
        handlerCode('@UseInterceptors(P)'),
      ].join('\n');
      expect(publicOf(code)).toEqual([true]);
    });

    it('видит интерцептор, поданный как new X() и в массиве', () => {
      expect(publicOf(handlerCode('@UseInterceptors(new PublicCacheInterceptor())'))).toEqual([
        true,
      ]);
      expect(publicOf(handlerCode('@UseInterceptors([A, PublicCacheInterceptor])'))).toEqual([
        true,
      ]);
    });

    it('не путает интерцептор с однокоренным соседом', () => {
      expect(publicOf(handlerCode('@UseInterceptors(SoftPublicCacheInterceptorX)'))).toEqual([
        false,
      ]);
    });

    it('интерцептор на классе действует на метод, @NoPublicCache() его снимает', () => {
      const code = `import { NoPublicCache } from '../decorators/no-public-cache.decorator';\n@UseInterceptors(PublicCacheInterceptor) @Controller() class C { @Get() a() {} @Get() @NoPublicCache() b() {} }`;
      expect(publicOf(code)).toEqual([true, false]);
    });

    it('одноимённый NoPublicCache из другого модуля кэш не снимает', () => {
      const code = `import { NoPublicCache } from './auth.decorator';\n@UseInterceptors(PublicCacheInterceptor) @Controller() class C { @Get() @NoPublicCache() b() {} }`;
      expect(publicOf(code)).toEqual([true]);
    });

    it('считает обработчиком метод с любым из восьми глаголов', () => {
      const verbs = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];
      const code = `@Controller() class C { ${verbs
        .map((verb) => `@${verb}() h${verb}() {}`)
        .join(' ')} notHandler() {} }`;
      expect(idsOf(code).map((handler) => handler.id)).toEqual(
        verbs.map((verb) => `fixture.controller.ts → h${verb}`),
      );
    });

    it('видит публичный кэш, объявленный ручным заголовком', () => {
      expect(publicOf(handlerCode("@Header('Cache-Control', 'public, max-age=3600')"))).toEqual([
        true,
      ]);
    });

    it('не считает публичным приватный ручной заголовок', () => {
      expect(publicOf(handlerCode("@Header('Cache-Control', 'private, no-store')"))).toEqual([
        false,
      ]);
    });

    /**
     * 🔴 `@Header` повторяем, в отличие от `@UseGuards` и `@UseInterceptors`.
     * Разбор по первому вхождению отвечал про чужой заголовок и не видел
     * нужный — сторож оставался зелёным на публично кэшируемом обработчике.
     */
    it('видит Cache-Control, объявленный не первым заголовком', () => {
      const decorators =
        "@Header('Content-Type', 'application/xml') @Header('Cache-Control', 'public, s-maxage=300')";
      expect(publicOf(handlerCode(decorators))).toEqual([true]);
    });

    it('видит Cache-Control под псевдонимом Header и любым регистром ключа', () => {
      const code = [
        "import { Header as H } from '@nestjs/common';",
        "@Controller() class C { @Get() @H('cache-control', 'public') h() {} }",
      ].join('\n');
      expect(publicOf(code)).toEqual([true]);
    });

    /**
     * `s-maxage` — директива общего кэша, слова `public` рядом не требуется:
     * ответ хранится и переиспользуется CDN и без него.
     */
    it('считает публичным s-maxage без слова public', () => {
      expect(publicOf(handlerCode("@Header('Cache-Control', 's-maxage=300')"))).toEqual([true]);
    });

    it('не путает чужой заголовок со схожим именем', () => {
      expect(publicOf(handlerCode("@Header('X-Cache-Control-Debug', 'public')"))).toEqual([false]);
    });

    /**
     * `no-cache="public"` — валидная форма RFC 9111 §5.2.2.2, чьё значение
     * приватно. Поиск слова `public` по всему вызову объявил бы её публичной.
     */
    it('не считает публичным private с public внутри значения', () => {
      expect(
        publicOf(handlerCode(`@Header('Cache-Control', 'private, no-cache="public"')`)),
      ).toEqual([false]);
    });

    it('значение заголовка, собранное выражением, считается публичным', () => {
      expect(publicOf(handlerCode("@Header('Cache-Control', CACHE_VALUE)"))).toEqual([true]);
    });

    it('текст декоратора в комментарии или строке — не декоратор', () => {
      const code =
        "@Controller() class C { // @UseInterceptors(PublicCacheInterceptor)\n @Get() @ApiOperation({ summary: '@UseInterceptors(PublicCacheInterceptor)' }) h() {} }";
      expect(publicOf(code)).toEqual([false]);
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
