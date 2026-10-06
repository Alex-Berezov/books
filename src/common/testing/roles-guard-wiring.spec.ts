import {
  SRC_ROOT,
  controllersIn,
  hasGuard,
  isFrom,
  listControllerFiles,
  parseControllerFile,
  parseSource,
  readController,
  stripComments,
} from './controller-decorators';
import type { ControllerInfo, DecoratorUse } from './controller-decorators';

/**
 * Сторож связки «`@Roles(...)` — `RolesGuard`» (`LEGACY-110`).
 *
 * Глобального `RolesGuard` в приложении нет: в `APP_GUARD` лежат только
 * `GlobalRateLimitGuard` и `LanguageResolverGuard`. Значит `@Roles(...)` без
 * `RolesGuard` в том же `@UseGuards(...)` не проверяет ничего — метаданные
 * `ROLES_KEY` некому прочитать, и маршрут открыт любому аутентифицированному.
 * Ни типы, ни линт, ни Swagger такой маршрут от закрытого не отличают:
 * декоратор корректен сам по себе, а замок в документации рисует
 * `@ApiBearerAuth()`.
 *
 * ⚠️ Проверка идёт **по обработчикам, а не по файлам**: `RolesGuard`,
 * упомянутый где-то в файле, ничего не говорит о соседнем методе, у которого
 * свой `@UseGuards(...)`. Файловой проверки хватило бы ровно до первого
 * контроллера, где гвард стоит на одном маршруте из трёх.
 *
 * ⚠️ Порог обхода задан не «на глазок», а сверкой с сырым числом вхождений
 * `@Roles(` в тех же файлах. Разбор декораторов может сломаться так, что часть
 * обработчиков просто перестанет считаться, — и мягкая нижняя граница этого
 * не заметит. Сырой счёт остаётся текстовым намеренно: это независимый
 * свидетель, который не зависит от общего разбора.
 *
 * Сам разбор декораторов вынесен в `controller-decorators.ts` (AST, с учётом
 * псевдонимов импорта и всех вхождений `@UseGuards`): тем же разбором
 * собирается список закрытых маршрутов в
 * `test/closed-routes-unauthorized.e2e-spec.ts` (`LEGACY-234`).
 */

/** Ниже этого числа обход считается сломанным, а не репозиторий — поредевшим. */
const MIN_CONTROLLERS = 40;
const MIN_ROLES_HANDLERS = 150;

const hasRoles = (uses: readonly DecoratorUse[]): boolean =>
  uses.some((use) => isFrom(use, 'Roles', ''));

/**
 * Узлы с `@Roles` и среди них те, у кого нет `RolesGuard` ни на себе, ни на классе.
 * Имя гварда сравнивается целиком и по импортированному имени: `SoftRolesGuard`
 * ролей не читает, а `import { RolesGuard as RG }` — это всё тот же `RolesGuard`.
 */
const rolesWiring = (
  controllers: readonly ControllerInfo[],
): { withRoles: number; unguarded: string[] } => {
  let withRoles = 0;
  const unguarded: string[] = [];
  for (const controller of controllers) {
    const classGuarded = hasGuard(controller.decorators, 'RolesGuard');
    if (hasRoles(controller.decorators)) {
      withRoles += 1;
      if (!classGuarded) unguarded.push(`${controller.file} → class ${controller.className}`);
    }
    for (const handler of controller.handlers) {
      if (!hasRoles(handler.decorators)) continue;
      withRoles += 1;
      if (classGuarded || hasGuard(handler.decorators, 'RolesGuard')) continue;
      unguarded.push(`${controller.file} → ${handler.ownerLine}`);
    }
  }
  return { withRoles, unguarded };
};

describe('@Roles is always backed by RolesGuard', () => {
  const controllers = listControllerFiles(SRC_ROOT);

  const parsed = controllers.flatMap(parseControllerFile);
  const { withRoles: handlersWithRoles, unguarded } = rolesWiring(parsed);
  const rawRolesOccurrences = controllers.reduce(
    (sum, file) => sum + (stripComments(readController(file)).match(/@Roles\s*\(/g) ?? []).length,
    0,
  );

  it(`находит не меньше ${MIN_CONTROLLERS} контроллеров`, () => {
    expect(controllers.length).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
  });

  it(`находит не меньше ${MIN_ROLES_HANDLERS} обработчиков с @Roles`, () => {
    expect(handlersWithRoles).toBeGreaterThanOrEqual(MIN_ROLES_HANDLERS);
  });

  it('видит все @Roles до единого — разбор декораторов ничего не потерял', () => {
    expect(handlersWithRoles).toBe(rawRolesOccurrences);
  });

  it('не оставляет ни одного @Roles без RolesGuard', () => {
    expect(unguarded).toEqual([]);
  });
});

/**
 * 🔴 Проверка выше на дереве, где нарушений нет, зелёная и у сломанного разбора:
 * краевой вход должен краснеть на синтетическом контроллере, рядом с чистым
 * (`L-017`). Те же входы стерегут общий модуль у каждого его потребителя.
 */
describe('детектор @Roles без RolesGuard краснеет на каждом краевом входе', () => {
  const IMPORTS = "import { Controller, Get, UseGuards } from '@nestjs/common';";
  const unguardedIn = (code: string): string[] =>
    rolesWiring(controllersIn(parseSource(code), 'fixture.controller.ts')).unguarded;

  it.each([
    ['@Roles без гварда', '@Get() @Roles(Role.Admin) a() {}', 1],
    ['только JwtAuthGuard', '@Get() @UseGuards(JwtAuthGuard) @Roles(Role.Admin) a() {}', 1],
    [
      'SoftRolesGuard — не RolesGuard',
      '@Get() @UseGuards(SoftRolesGuard) @Roles(Role.Admin) a() {}',
      1,
    ],
    [
      '// @Roles в комментарии — не декоратор',
      '@Get() @UseGuards(JwtAuthGuard) a() {} // @Roles(X)',
      0,
    ],
  ])('%s', (_name, member, expected) => {
    expect(unguardedIn(`${IMPORTS}\n@Controller() class C { ${member} }`)).toHaveLength(expected);
  });

  it.each([
    ['RolesGuard на методе', '@Get() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(R) a() {}'],
    [
      'RolesGuard во втором @UseGuards',
      '@Get() @UseGuards(JwtAuthGuard) @UseGuards(RolesGuard) @Roles(R) a() {}',
    ],
    ['new RolesGuard()', '@Get() @UseGuards(new RolesGuard()) @Roles(R) a() {}'],
    ['RolesGuard в массиве', '@Get() @UseGuards([JwtAuthGuard, RolesGuard]) @Roles(R) a() {}'],
  ])('%s — чисто', (_name, member) => {
    expect(unguardedIn(`${IMPORTS}\n@Controller() class C { ${member} }`)).toEqual([]);
  });

  it('RolesGuard под псевдонимом импорта — тот же гвард', () => {
    const code = [
      IMPORTS,
      "import { RolesGuard as RG } from '../guards/roles.guard';",
      '@Controller() class C { @Get() @UseGuards(RG) @Roles(R) a() {} }',
    ].join('\n');
    expect(unguardedIn(code)).toEqual([]);
  });

  it('@Roles под псевдонимом импорта — тот же @Roles', () => {
    const code = [
      IMPORTS,
      "import { Roles as R } from '../decorators/roles.decorator';",
      '@Controller() class C { @Get() @UseGuards(JwtAuthGuard) @R(X) a() {} }',
    ].join('\n');
    expect(unguardedIn(code)).toHaveLength(1);
  });

  it('псевдоним чужого гварда не становится RolesGuard', () => {
    const code = [
      IMPORTS,
      "import { SoftGuard as RolesGuard } from '../guards/soft.guard';",
      '@Controller() class C { @Get() @UseGuards(RolesGuard) @Roles(R) a() {} }',
    ].join('\n');
    // Имя в коде совпало, но импортировано другое: гвард ролей это не он.
    expect(unguardedIn(code)).toHaveLength(1);
  });

  it('UseGuards под псевдонимом и через пространство имён', () => {
    const code = [
      "import * as common from '@nestjs/common';",
      "import { RolesGuard } from '../guards/roles.guard';",
      '@common.Controller() class C {',
      '  @common.Get() @common.UseGuards(RolesGuard) @Roles(R) a() {}',
      '}',
    ].join('\n');
    expect(unguardedIn(code)).toEqual([]);
  });

  it('импорт с расширением не мешает узнать UseGuards', () => {
    const code = [
      "import { Controller, Get } from '@nestjs/common';",
      "import { UseGuards } from '@nestjs/common/index.js';",
      '@Controller() class C { @Get() @UseGuards(RolesGuard) @Roles(R) a() {} }',
    ].join('\n');
    expect(unguardedIn(code)).toEqual([]);
  });

  it('гвард на классе закрывает все методы, а @Roles на классе без гварда — нарушение', () => {
    expect(
      unguardedIn(
        `${IMPORTS}\n@UseGuards(RolesGuard) @Controller() class C { @Get() @Roles(R) a() {} }`,
      ),
    ).toEqual([]);
    expect(
      unguardedIn(`${IMPORTS}\n@Roles(R) @Controller() class C { @Get() a() {} }`),
    ).toHaveLength(1);
  });
});
