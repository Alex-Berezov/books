import {
  SRC_ROOT,
  collectRoutes,
  controllersIn,
  listControllerFiles,
  parseSource,
  routesOf,
} from './controller-decorators';
import type { ControllerRoute } from './controller-decorators';

/**
 * Сторож связки «`JwtAuthGuard` — `@ApiBearerAuth()`» (`LEGACY-132`).
 *
 * Декоратор не влияет на исполнение запроса вовсе: он влияет только на
 * сгенерированный документ OpenAPI. Поэтому его пропуск не ловят ни типы, ни
 * линт, ни тесты маршрутов — закрытый маршрут просто выглядит в Swagger
 * открытым, а кнопка проверки не подставляет токен и отвечает 401, что читается
 * как поломка маршрута.
 *
 * ⚠️ Проверка двусторонняя, и вторая половина не менее важна первой. Дословная
 * рекомендация записи — «поставить декоратор на класс» — на смешанном
 * контроллере пометила бы токеном и публичные `GET`: та же ложь в документе, с
 * обратным знаком. Из одиннадцати контроллеров, которые правились по этой
 * записи, **ни один** не был защищён целиком (решение арбитра 05.09.2026,
 * `decisions-log.md`), поэтому декоратор ставится ровно туда, где стоит гвард.
 *
 * ⚠️ Маршруты под `OptionalJwtAuthGuard` из второй половины исключены: такой
 * маршрут пускает анонима, но токен на нём осмыслен и меняет ответ, поэтому
 * `@ApiBearerAuth()` там не ложь. Исключение задано **гвардом**, а не списком
 * имён файлов: список пришлось бы дополнять при каждом новом маршруте, и первый
 * же незаполненный случай выглядел бы как нарушение.
 *
 * Разбор берётся из `controller-decorators.ts` — того же сканера, что стережёт
 * `@Roles`/`RolesGuard` (`roles-guard-wiring.spec.ts`) и порядок маршрутов.
 * Второго разбора контроллеров здесь нет намеренно: два сторожа с разными
 * ответами на один вход хуже одного. Гвард узнаётся по импортированному имени,
 * в любом из нескольких `@UseGuards` узла.
 */

/** Ниже этих чисел сломан обход, а не поредел репозиторий. */
const MIN_CONTROLLERS = 40;
const MIN_CLOSED_ROUTES = 150;

const describeRoute = (route: ControllerRoute): string =>
  `${route.file} → ${route.verb.toUpperCase()} ${route.path} (${route.ownerLine})`;

const routeKey = (route: ControllerRoute): string =>
  `${route.file} ${route.verb} ${route.path} ${route.ownerLine}`;

/**
 * Расхождения гварда и `@ApiBearerAuth()` в наборе маршрутов. Отдельно от обхода
 * репозитория, чтобы прогоняться и на синтетическом входе (`L-017`).
 */
const mismatches = (
  jwt: { closed: ControllerRoute[]; open: ControllerRoute[] },
  optional: { closed: ControllerRoute[] },
): { closedWithoutDecorator: string[]; openWithDecorator: string[] } => {
  const optionalKeys = new Set(optional.closed.map(routeKey));
  return {
    closedWithoutDecorator: jwt.closed.filter((route) => !route.bearerAuth).map(describeRoute),
    openWithDecorator: jwt.open
      .filter((route) => route.bearerAuth && !optionalKeys.has(routeKey(route)))
      .map(describeRoute),
  };
};

describe('JwtAuthGuard and @ApiBearerAuth() agree with each other', () => {
  const controllers = listControllerFiles(SRC_ROOT);
  const jwt = collectRoutes('JwtAuthGuard');
  const optional = collectRoutes('OptionalJwtAuthGuard');
  const { closedWithoutDecorator, openWithDecorator } = mismatches(jwt, optional);

  it(`находит не меньше ${MIN_CONTROLLERS} контроллеров`, () => {
    expect(controllers.length).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
  });

  it(`находит не меньше ${MIN_CLOSED_ROUTES} закрытых маршрутов`, () => {
    expect(jwt.closed.length).toBeGreaterThanOrEqual(MIN_CLOSED_ROUTES);
  });

  it('разбирает каждый контроллер — ни один не пропущен молча', () => {
    expect(jwt.skipped).toEqual([]);
  });

  it('не оставляет ни одного закрытого маршрута без @ApiBearerAuth', () => {
    expect(closedWithoutDecorator).toEqual([]);
  });

  it('не помечает @ApiBearerAuth ни одного маршрута без гварда авторизации', () => {
    expect(openWithDecorator).toEqual([]);
  });
});

/**
 * 🔴 Дерево без нарушений зелёное и у слепого разбора: каждый краевой вход
 * прогоняется на синтетическом контроллере (`L-017`, `LEGACY-290`).
 */
describe('детектор расхождения гварда и @ApiBearerAuth краснеет на краевых входах', () => {
  const IMPORTS = [
    "import { Controller, Get, UseGuards } from '@nestjs/common';",
    "import { ApiBearerAuth } from '@nestjs/swagger';",
  ].join('\n');

  const run = (code: string): ReturnType<typeof mismatches> => {
    const controllers = controllersIn(parseSource(`${IMPORTS}\n${code}`), 'fixture.controller.ts');
    return mismatches(
      routesOf(controllers, 'JwtAuthGuard'),
      routesOf(controllers, 'OptionalJwtAuthGuard'),
    );
  };

  it('гвард во втором @UseGuards закрывает маршрут — без @ApiBearerAuth это расхождение', () => {
    const found = run(
      '@Controller() class C { @Get() @UseGuards(A) @UseGuards(JwtAuthGuard) a() {} }',
    );
    expect(found.closedWithoutDecorator).toHaveLength(1);
  });

  it('JwtAuthGuard под псевдонимом импорта — тот же гвард', () => {
    const found = run(
      [
        "import { JwtAuthGuard as G } from '../guards/jwt-auth.guard';",
        '@Controller() class C { @Get() @UseGuards(G) a() {} }',
      ].join('\n'),
    );
    expect(found.closedWithoutDecorator).toHaveLength(1);
  });

  it('чужой гвард под именем JwtAuthGuard — не JwtAuthGuard', () => {
    const found = run(
      [
        "import { Soft as JwtAuthGuard } from '../guards/soft.guard';",
        '@Controller() class C { @Get() @UseGuards(JwtAuthGuard) a() {} }',
      ].join('\n'),
    );
    expect(found.closedWithoutDecorator).toEqual([]);
  });

  it('OptionalJwtAuthGuard не считается JwtAuthGuard, а его @ApiBearerAuth — не ложь', () => {
    const found = run(
      '@Controller() class C { @Get() @ApiBearerAuth() @UseGuards(OptionalJwtAuthGuard) a() {} }',
    );
    expect(found).toEqual({ closedWithoutDecorator: [], openWithDecorator: [] });
  });

  it('@ApiBearerAuth без гварда — ложь в документе', () => {
    const found = run('@Controller() class C { @Get() @ApiBearerAuth() a() {} }');
    expect(found.openWithDecorator).toHaveLength(1);
  });

  it('@ApiBearerAuth под псевдонимом и через пространство имён засчитывается', () => {
    const code = [
      "import { ApiBearerAuth as Bearer } from '@nestjs/swagger';",
      "import * as swagger from '@nestjs/swagger';",
      '@Controller() class C {',
      '  @Get() @Bearer() @UseGuards(JwtAuthGuard) a() {}',
      '  @Get() @swagger.ApiBearerAuth() @UseGuards(JwtAuthGuard) b() {}',
      '}',
    ].join('\n');
    expect(run(code).closedWithoutDecorator).toEqual([]);
  });

  it('@ApiBearerAuth в комментарии и в тексте описания — не декоратор', () => {
    const code = [
      '@Controller() class C {',
      '  // @ApiBearerAuth()',
      "  @Get() @ApiOperation({ description: '@ApiBearerAuth()' }) @UseGuards(JwtAuthGuard) a() {}",
      '}',
    ].join('\n');
    expect(run(code).closedWithoutDecorator).toHaveLength(1);
  });

  it('@ApiBearerAuth и гвард на классе действуют на все методы', () => {
    const found = run(
      '@ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller() class C { @Get() a() {} @Get() b() {} }',
    );
    expect(found).toEqual({ closedWithoutDecorator: [], openWithDecorator: [] });
  });

  it('из двух HTTP-декораторов на одном методе маршрут даёт верхний, как в Nest', () => {
    const found = run(
      "@Controller() class C { @Get('a') @Get('b') @UseGuards(JwtAuthGuard) m() {} }",
    );
    expect(found.closedWithoutDecorator).toHaveLength(1);
    expect(found.closedWithoutDecorator[0]).toContain('GET /a ');
  });
});
