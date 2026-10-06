import {
  allRoutes,
  collectRoutes,
  controllersIn,
  isFromModule,
  guardsOf,
  hasGuard,
  hasInterceptor,
  importsOf,
  interceptorsOf,
  parseSource,
  referenceOf,
  routesOf,
} from './controller-decorators';
import type { ControllerInfo } from './controller-decorators';
import * as ts from 'typescript';

/**
 * Сторож самого общего разбора декораторов (`LEGACY-290`, `T108`).
 *
 * Потребители (`roles-guard-wiring`, `swagger-bearer-auth`, `cache-headers-wiring`,
 * `public-cache-caller-independent`, `route-order`, `deploy-smoke`, `langless-public-routes`,
 * `dto-api-property`) каждый прогоняют свои краевые входы на синтетическом
 * контроллере; здесь — те же входы у самого разбора, чтобы поломка общего модуля
 * краснела и в нём, а не только у тех, кто успел о ней узнать.
 */

const IMPORTS = "import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';\n";

const controllersFor = (code: string): ControllerInfo[] =>
  controllersIn(parseSource(IMPORTS + code), 'x.controller.ts');

describe('isFromModule: путь импорта против модуля кандидата', () => {
  it.each([
    ['@nestjs/common', '@nestjs/common', true],
    ['@nestjs/common/decorators/http/route-params.decorator', '@nestjs/common', true],
    ['@nestjs/common/index.js', '@nestjs/common', true],
    ['../decorators/language.decorator', 'language.decorator', true],
    ['../decorators/language.decorator.js', 'language.decorator', true],
    ['../decorators/language.decorator.ts', 'language.decorator', true],
    ['../decorators/language.decorator/index', 'language.decorator', true],
    ['@nestjs/common-x', '@nestjs/common', false],
    ['@nestjs/commonish', '@nestjs/common', false],
    ['../my-language.decorator', 'language.decorator', false],
    ['anything', '', true],
  ])('%s против %s → %s', (from, module, expected) => {
    expect(isFromModule(from, module)).toBe(expected);
  });
});

describe('importsOf и referenceOf: имя по тому, что импортировано', () => {
  const refOf = (code: string, expression: string): ReturnType<typeof referenceOf> => {
    const source = parseSource(`${code}\nconst x = ${expression};`);
    const statement = source.statements[source.statements.length - 1] as ts.VariableStatement;
    return referenceOf(
      statement.declarationList.declarations[0].initializer as ts.Expression,
      importsOf(source),
    );
  };

  it('псевдоним — экспортируемое имя и модуль', () => {
    expect(refOf("import { A as B } from '../a';", 'B')).toMatchObject({
      name: 'A',
      module: '../a',
    });
  });

  it('пространство имён — имя справа и модуль слева', () => {
    expect(refOf("import * as ns from '@nestjs/common';", 'ns.Get')).toMatchObject({
      name: 'Get',
      module: '@nestjs/common',
    });
  });

  it('new X() и вызов X(...) разворачиваются в X', () => {
    expect(refOf("import { X } from '../x';", 'new X()').name).toBe('X');
    expect(refOf("import { X } from '../x';", "X('jwt')").name).toBe('X');
  });

  it('вызов не-фабрики — не имя гварда: buildGuards() и [A].concat(x) не разобрать', () => {
    expect(refOf('', 'buildGuards()').name).toBe('');
    expect(refOf('', '[A, B].concat(extra)').name).toBe('');
    expect(refOf("import * as p from '@nestjs/passport';", "p.AuthGuard('jwt')").name).toBe(
      'AuthGuard',
    );
  });

  it('свойство именованного импорта несёт его модуль, а не «ниоткуда»', () => {
    expect(refOf("import { nest } from '../evil';", 'nest.UseGuards')).toMatchObject({
      name: 'UseGuards',
      module: '../evil',
    });
  });

  it('импорт по умолчанию — под своим локальным именем', () => {
    expect(refOf("import Y from '../y';", 'Y')).toMatchObject({ name: 'Y', module: '../y' });
  });

  it('не импортированное имя — модуль пуст, выражение, которое не разобрать, — имя пусто', () => {
    expect(refOf('', 'Local')).toMatchObject({ name: 'Local', module: '' });
    expect(refOf('', 'flag ? A : B').name).toBe('');
  });
});

describe('guardsOf и interceptorsOf: все вхождения узла', () => {
  const handlerDecorators = (
    decorators: string,
  ): ControllerInfo['handlers'][number]['decorators'] =>
    controllersFor(`@Controller() class C { @Get() ${decorators} h() {} }`)[0].handlers[0]
      .decorators;

  it('складывает аргументы всех @UseGuards', () => {
    const uses = handlerDecorators('@UseGuards(A) @UseGuards(B, new C(), D("x"))');
    expect(guardsOf(uses).map((ref) => ref.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('раскрывает массив и не склеивает соседние декораторы', () => {
    const uses = handlerDecorators(
      "@UseGuards([A, B]) @ApiOperation({ description: '@UseGuards(Z)' })",
    );
    expect(guardsOf(uses).map((ref) => ref.name)).toEqual(['A', 'B']);
  });

  it('имя сравнивается целиком: JwtAuthGuard не входит в OptionalJwtAuthGuard', () => {
    const uses = handlerDecorators('@UseGuards(OptionalJwtAuthGuard)');
    expect(hasGuard(uses, 'JwtAuthGuard')).toBe(false);
    expect(hasGuard(uses, 'OptionalJwtAuthGuard')).toBe(true);
  });

  it('интерцепторы складываются так же', () => {
    const uses = handlerDecorators('@UseInterceptors(A) @UseInterceptors(FileInterceptor("f"), B)');
    expect(interceptorsOf(uses).map((ref) => ref.name)).toEqual(['A', 'FileInterceptor', 'B']);
    expect(hasInterceptor(uses, 'B')).toBe(true);
  });

  it('UseGuards из чужого пакета — не @nestjs/common', () => {
    const code =
      "import { UseGuards } from '@nestjs/common-x';\n@Controller() class C { @Get() @UseGuards(A) h() {} }";
    const [controller] = controllersIn(parseSource(code), 'x.controller.ts');
    expect(guardsOf(controller.handlers[0].decorators)).toEqual([]);
  });
});

describe('controllersIn и routesOf: маршруты контроллера', () => {
  it('база и путь склеиваются, параметры остаются как :name', () => {
    const { open } = routesOf(
      controllersFor("@Controller('a/') class C { @Get('/b/:id') x() {} @Get() root() {} }"),
    );
    expect(open.map((route) => route.path)).toEqual(['/a/b/:id', '/a']);
  });

  it('ключ path в кавычках — тот же ключ, краткая запись — выражение, а не корень', () => {
    const pathsFor = (options: string): string[] =>
      routesOf(controllersFor(`@Controller(${options}) class C { @Get() h() {} }`)).open.map(
        (route) => route.path,
      );
    expect(pathsFor("{ 'path': 'a' }")).toEqual(['/a']);
    expect(pathsFor('{ path }')).toEqual(['/<path>']);
    expect(pathsFor('{ ...options }')).toEqual(['/<...options>']);
    expect(pathsFor("{ host: 'x' }")).toEqual(['/']);
  });

  it('@Controller({ path }) и массив путей', () => {
    const { open } = routesOf(
      controllersFor("@Controller({ path: 'a' }) class C { @Get(['x', 'y']) h() {} }"),
    );
    expect(open.map((route) => route.path)).toEqual(['/a/x', '/a/y']);
  });

  it('гвард класса закрывает все методы, гвард метода — только его', () => {
    const { closed, open } = routesOf(
      controllersFor(
        "@Controller('a') class C { @Get('x') @UseGuards(JwtAuthGuard) x() {} @Get('y') y() {} }",
      ),
      'JwtAuthGuard',
    );
    expect(closed.map((route) => route.path)).toEqual(['/a/x']);
    expect(open.map((route) => route.path)).toEqual(['/a/y']);
  });

  it('ownerLine — строка с именем метода, а не с декоратором', () => {
    const [route] = routesOf(
      controllersFor(
        "@Controller() class C {\n  @Get('x')\n  @UseGuards(A)\n  async findAll() {}\n}",
      ),
    ).open;
    expect(route.ownerLine).toBe('async findAll() {}');
  });

  it('путь, собранный выражением, остаётся видимым, а не превращается в корень', () => {
    const { open } = routesOf(controllersFor('@Controller() class C { @Get(PATH) h() {} }'));
    expect(open.map((route) => route.path)).toEqual(['/<PATH>']);
  });

  it('файл без класса под @Controller не даёт контроллеров', () => {
    expect(controllersIn(parseSource('export class Plain {}'), 'x.controller.ts')).toEqual([]);
  });

  it('из двух HTTP-декораторов на методе маршрут даёт верхний', () => {
    const { open } = routesOf(
      controllersFor("@Controller() class C { @Get('a') @Get('b') h() {} }"),
    );
    expect(open.map((route) => route.path)).toEqual(['/a']);
  });

  it('метод без HTTP-декоратора маршрутом не считается', () => {
    const { open } = routesOf(controllersFor('@Controller() class C { helper() {} }'));
    expect(open).toEqual([]);
  });
});

/**
 * Пороги на число маршрутов живут у потребителей (`MIN_CLOSED_ROUTES`, `MIN_ROUTES`);
 * здесь только «ничего не выпало и что-то найдено», чтобы не держать третью копию числа.
 */
describe('обход репозитория разбирает дерево целиком', () => {
  it('collectRoutes: ни одного пропущенного файла, есть и закрытые, и открытые', () => {
    const { closed, open, skipped } = collectRoutes('JwtAuthGuard');
    expect(skipped).toEqual([]);
    expect(closed.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
  });

  it('allRoutes: ни одного пропущенного файла', () => {
    const { routes, skipped } = allRoutes();
    expect(skipped).toEqual([]);
    expect(routes.length).toBeGreaterThan(0);
  });
});
