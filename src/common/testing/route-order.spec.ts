import { readFileSync } from 'fs';
import {
  SRC_ROOT,
  controllersIn,
  listControllerFiles,
  parseSource,
  routeDecoratorsOf,
  relativeToSrc,
  routesOf,
  VERBS,
  verbDecoratorName,
} from './controller-decorators';
import type { ControllerInfo } from './controller-decorators';
import { earlier, Rank, registrationOf, stripComments } from './module-registration';

/**
 * Сторож порядка литеральных и динамических маршрутов (`LEGACY-120`, `LEGACY-091`,
 * `LEGACY-201`).
 *
 * В Nest маршрут выбирается по порядку объявления, поэтому литеральный путь
 * обязан стоять выше динамического с тем же числом сегментов: иначе
 * `@Get(':id')` съедает `@Get('check-slug')`, объявленный ниже. Нарушение
 * невидимо для всех остальных проверок — приложение стартует, Swagger показывает
 * оба маршрута, `tsc` и линт молчат, — маршрут просто никогда не вызывается.
 * Обнаружить можно только запросом.
 *
 * До этой спеки порядок удерживался тремя комментариями-предупреждениями
 * (`book.controller.ts`, `public.controller.ts`, `category.controller.ts`).
 * Комментарии оставлены на месте: при чтении файла они дешевле спеки.
 *
 * 🔴 **Между файлами порядок объявления не решает ничего** — решает порядок
 * регистрации модулей. Первая редакция спеки сравнивала маршруты только внутри
 * файла и рапортовала чистый репозиторий, пока `GET /admin/authors` отвечал 404
 * на проде. Вторая замораживала межфайловые пары поимённо: пара считалась
 * дефектом независимо от исхода, потому что исход спеке был не виден.
 *
 * Здесь он виден: очередь регистрации восстанавливается обходом графа модулей
 * (`module-registration.ts`), и краснеет только та пара, где перехваченный путь
 * **действительно проигрывает**. Поэтому замороженного списка больше нет —
 * сегодня таких пар ноль.
 *
 * ⚠️ Перехватом считается не только параметр над литералом, но и параметр над
 * параметром: `:lang/authors` и `:slug/authors` совпадают на любом запросе, и
 * тот из них, кто зарегистрирован позже, не вызывается никогда. Направленная
 * проверка обязана видеть этот случай: пока `PublicModule` регистрировался
 * первым, он выигрывал такие гонки молча, а теперь он последний и проигрывает
 * их так же молча.
 *
 * ⚠️ Маршруты и базу контроллера даёт общий разбор `controller-decorators.ts`
 * (AST, `LEGACY-290`): `@Get` под псевдонимом, `@Controller({ path })`, массив
 * путей и второй глагол на том же методе видны ему так же, как и остальным
 * сторожам. Собственной регулярки на `@Get('...')` здесь больше нет.
 */

/** Ниже этих чисел обход считается сломанным, а не репозиторий — поредевшим. */
const MIN_CONTROLLERS = 40;
const MIN_ROUTES = 250;

/** Сырой счёт по тексту — имена глаголов из общего `VERBS`, а не восьмая копия списка. */
const RAW_VERB_DECORATOR = new RegExp(`@(${VERBS.map(verbDecoratorName).join('|')})\\s*\\(`, 'g');

const segments = (path: string): string[] => path.split('/').filter((s) => s !== '');

type Route = {
  file: string;
  method: string;
  /** Полный путь без ведущего слэша: база контроллера плюс путь обработчика. */
  path: string;
  segments: string[];
  /** Порядок объявления внутри файла. */
  index: number;
  /** Место в очереди регистрации; `undefined` — контроллер не найден в модулях. */
  rank?: Rank;
};

/**
 * Маршруты контроллеров одного файла в порядке объявления — из общего `routesOf`
 * (`LEGACY-290`: склейка базы и пути, массивы путей и разбор `@Controller` живут одним
 * местом) — и число HTTP-декораторов, написанных голым именем глагола (`@Get(`), для
 * точной сверки с сырым текстовым счётом.
 */
const routesIn = (
  file: string,
  controllers: readonly ControllerInfo[],
  rank?: Rank,
): { routes: Route[]; bareDecorators: number } => {
  const routes = routesOf(controllers).open.map((route, index): Route => {
    const path = segments(route.path).join('/');
    return {
      file,
      method: verbDecoratorName(route.verb),
      path,
      segments: segments(path),
      index,
      rank,
    };
  });
  const bareDecorators = controllers
    .flatMap((controller) => controller.handlers)
    .flatMap(routeDecoratorsOf)
    .filter((decorator) => decorator.text === verbDecoratorName(decorator.verb)).length;
  return { routes, bareDecorators };
};

/**
 * Разбор держится на предпосылках, и все они проверяются здесь же, а не
 * подразумеваются: один контроллер на файл (второй склеил бы два независимых
 * порядка объявления в одну нумерацию) и пути строками (путь, собранный
 * выражением, разобрать нельзя, и межфайловая проверка начала бы сравнивать
 * заглушки).
 */
const assumptionsBroken = (short: string, controllers: readonly ControllerInfo[]): string[] => {
  const broken: string[] = [];
  if (controllers.length !== 1) {
    broken.push(`${short}: @Controller встречается ${controllers.length} раз, ожидался один`);
  }
  for (const controller of controllers) {
    if (controller.bases.some((base) => base.startsWith('<'))) {
      broken.push(`${short}: @Controller объявлен не строкой — разбор базы пути не применим`);
    }
    for (const handler of controller.handlers) {
      // Nest регистрирует только верхний HTTP-декоратор метода: второй — мёртвый маршрут,
      // а сырой счёт его видит. Не молча, а поломкой предпосылки.
      if (routeDecoratorsOf(handler).length > 1) {
        broken.push(
          `${short}: у ${handler.name} несколько HTTP-декораторов — живёт только верхний`,
        );
      }
      for (const { paths } of routeDecoratorsOf(handler)) {
        if (paths.some((path) => path.startsWith('<'))) {
          broken.push(`${short}: путь ${handler.name} собран выражением — разбор не применим`);
        }
      }
    }
  }
  return broken;
};

/** `@All` перехватывает любой метод, остальные — только свой. */
const sameMethod = (a: Route, b: Route): boolean =>
  a.method === b.method || a.method === 'All' || b.method === 'All';

/**
 * Маршрут `covering` перехватывает `covered`: столько же сегментов, и каждый
 * сегмент либо совпадает буквально, либо на его месте у `covering` стоит
 * параметр. Литерал параметр не перехватывает — обратное направление ложно.
 * Одинаковые пути — другой дефект, он ловится отдельно.
 */
const swallows = (covering: Route, covered: Route): boolean => {
  if (!sameMethod(covering, covered)) return false;
  if (covering.segments.length !== covered.segments.length) return false;
  if (covering.path === covered.path) return false;

  for (let i = 0; i < covering.segments.length; i += 1) {
    const a = covering.segments[i];
    const b = covered.segments[i];
    if (a === b) continue;
    if (a.startsWith(':')) continue;
    return false;
  }
  return true;
};

/** Внутри файла порядок объявления и решает исход — сравнение направленное. */
const shadowedIn = (routes: readonly Route[]): string[] => {
  const shadowed: string[] = [];
  for (const covered of routes) {
    for (const covering of routes) {
      if (covering.index >= covered.index) continue;
      if (swallows(covering, covered)) {
        shadowed.push(
          `${covered.file}: @${covered.method}('${covered.path}') объявлен ниже ` +
            `@${covering.method}('${covering.path}')`,
        );
      }
    }
  }
  return shadowed;
};

describe('порядок маршрутов: литеральный выше динамического', () => {
  const controllers = listControllerFiles(SRC_ROOT);
  const { ranks, problems } = registrationOf(SRC_ROOT);
  const brokenAssumptions = [...problems];

  const byFile = new Map<string, Route[]>();
  let rawDecoratorOccurrences = 0;
  let bareDecorators = 0;

  for (const file of controllers) {
    const content = readFileSync(file, 'utf8');
    const short = relativeToSrc(file);
    const parsed = controllersIn(parseSource(content, file), short);

    brokenAssumptions.push(...assumptionsBroken(short, parsed));
    // Контроллер обязан быть найден в `controllers` какого-то модуля, иначе его место
    // в очереди регистрации неизвестно и межфайловая проверка молча пропустит весь файл.
    if (!ranks.has(file)) {
      brokenAssumptions.push(
        `${short}: контроллер не найден ни в одном модуле — очередь регистрации неизвестна`,
      );
    }
    // Сырой счёт по тексту — независимый свидетель: разбор не должен терять обработчики.
    rawDecoratorOccurrences += (stripComments(content).match(RAW_VERB_DECORATOR) ?? []).length;
    const found = routesIn(short, parsed, ranks.get(file));
    bareDecorators += found.bareDecorators;
    byFile.set(short, found.routes);
  }

  const allRoutes = [...byFile.values()].flat();

  const shadowed = [...byFile.values()].flatMap(shadowedIn);

  // Между файлами исход решает очередь регистрации модулей. Красным считается
  // только проигрыш: пара, где перехваченный маршрут зарегистрирован раньше
  // перехватчика, работает и дефектом не является.
  const lost = new Set<string>();
  for (const covering of allRoutes) {
    for (const covered of allRoutes) {
      if (covering.file === covered.file) continue;
      if (covering.rank === undefined || covered.rank === undefined) continue;
      if (!swallows(covering, covered)) continue;
      if (!earlier(covering.rank, covered.rank)) continue;
      lost.add(
        `${covered.method} ${covered.file}:'${covered.path}' мёртв — его перехватывает ` +
          `${covering.file}:'${covering.path}', зарегистрированный раньше`,
      );
    }
  }

  // Один и тот же путь, объявленный дважды: второй обработчик мёртв с рождения.
  // Считается и внутри файла, и между файлами — исход одинаково невидим.
  const seen = new Map<string, string>();
  const duplicated: string[] = [];
  for (const route of allRoutes) {
    const key = `${route.method} /${route.path}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, route.file);
      continue;
    }
    duplicated.push(`${key}: ${first} и ${route.file}`);
  }

  it(`находит не меньше ${MIN_CONTROLLERS} контроллеров`, () => {
    expect(controllers.length).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
  });

  it('предпосылки разбора в силе: один @Controller на файл, пути — строками, модуль найден', () => {
    expect(brokenAssumptions).toEqual([]);
  });

  it(`находит не меньше ${MIN_ROUTES} маршрутов`, () => {
    expect(allRoutes.length).toBeGreaterThanOrEqual(MIN_ROUTES);
  });

  /**
   * Точная сверка с сырым счётом по тому же правилу, что и текст: разбор считает только
   * декораторы, написанные голым именем глагола (`@Get(`), — псевдоним и `@common.Get`
   * текст не видит, и в счёт они не идут ни с одной стороны. Потерянный обработчик
   * (например, `Get` из локального реэкспорта, который разбор не признал) и лишний
   * (декоратор, засчитанный дважды) одинаково красят проверку.
   */
  it('видит все обработчики до единого — разбор декораторов ничего не потерял', () => {
    expect(bareDecorators).toBe(rawDecoratorOccurrences);
  });

  it('не оставляет ни одного литерального маршрута под динамическим в своём файле', () => {
    expect(shadowed).toEqual([]);
  });

  it('не оставляет ни одного маршрута, перехваченного параметром из чужого файла', () => {
    expect([...lost].sort()).toEqual([]);
  });

  it('не объявляет один и тот же путь дважды', () => {
    expect(duplicated).toEqual([]);
  });
});

/**
 * 🔴 Дерево без нарушений зелёное и у слепого разбора: краевые входы прогоняются
 * на синтетическом контроллере, чистый вход — рядом (`L-017`, `LEGACY-290`).
 */
describe('детектор порядка краснеет на краевых входах', () => {
  const IMPORTS = "import { Controller, Get, All } from '@nestjs/common';\n";
  const shadowedFor = (code: string): string[] =>
    shadowedIn(
      routesIn('x.controller.ts', controllersIn(parseSource(IMPORTS + code), 'x.controller.ts'))
        .routes,
    );
  const brokenFor = (code: string): string[] =>
    assumptionsBroken('x.controller.ts', controllersIn(parseSource(IMPORTS + code), 'x.ts'));

  it('динамический выше литерального — перехват', () => {
    const code = "@Controller('b') class C { @Get(':id') a() {} @Get('check') b() {} }";
    expect(shadowedFor(code)).toEqual([
      "x.controller.ts: @Get('b/check') объявлен ниже @Get('b/:id')",
    ]);
  });

  it('литеральный выше динамического — чисто', () => {
    expect(
      shadowedFor("@Controller('b') class C { @Get('check') a() {} @Get(':id') b() {} }"),
    ).toEqual([]);
  });

  it('@Get под псевдонимом импорта видна', () => {
    const code = [
      "import { Get as G } from '@nestjs/common';",
      "@Controller('b') class C { @G(':id') a() {} @G('check') b() {} }",
    ].join('\n');
    expect(shadowedFor(code)).toHaveLength(1);
  });

  it('@Get через пространство имён видна', () => {
    const code = [
      "import * as common from '@nestjs/common';",
      "@common.Controller('b') class C { @common.Get(':id') a() {} @common.Get('check') b() {} }",
    ].join('\n');
    expect(shadowedFor(code)).toHaveLength(1);
  });

  it('база из @Controller({ path }) учитывается', () => {
    const code = "@Controller({ path: 'b' }) class C { @Get(':id') a() {} @Get('check') b() {} }";
    expect(shadowedFor(code)).toHaveLength(1);
  });

  it('массив путей раскладывается на маршруты', () => {
    const code = "@Controller('b') class C { @Get([':id', 'x']) a() {} @Get('check') b() {} }";
    // Элемент массива `x` объявлен после `:id` так же, как и `check` ниже.
    expect(shadowedFor(code)).toHaveLength(2);
  });

  it('@All перехватывает любой метод', () => {
    const code = "@Controller('b') class C { @All(':id') a() {} @Get('check') b() {} }";
    expect(shadowedFor(code)).toHaveLength(1);
  });

  it('другой метод литерал не перехватывает', () => {
    expect(
      shadowedFor("@Controller('b') class C { @Get(':id') a() {} @Post('check') b() {} }"),
    ).toEqual([]);
  });

  it('закомментированный маршрут не считается', () => {
    const code = "@Controller('b') class C { @Get(':id') a() {}\n // @Get('check')\n b() {} }";
    expect(shadowedFor(code)).toEqual([]);
  });

  it('предпосылки: два контроллера в файле и путь выражением ломают разбор', () => {
    expect(brokenFor('@Controller() class A {} @Controller() class B {}')[0]).toContain(
      'ожидался один',
    );
    expect(brokenFor("@Controller(BASE) class A { @Get('x') a() {} }")[0]).toContain('не строкой');
    expect(brokenFor('@Controller() class A { @Get(PATH) a() {} }')[0]).toContain(
      'собран выражением',
    );
    expect(brokenFor("@Controller('x') class A { @Get('y') a() {} }")).toEqual([]);
  });

  it('предпосылки: второй HTTP-декоратор на методе — мёртвый маршрут', () => {
    expect(brokenFor("@Controller('x') class A { @Get('a') @Get('b') m() {} }")[0]).toContain(
      'живёт только верхний',
    );
  });

  it('предпосылки: { path } краткой записью и { ...options } — не строка, а не корень', () => {
    expect(brokenFor("@Controller({ path }) class A { @Get('y') a() {} }")[0]).toContain(
      'не строкой',
    );
    expect(brokenFor("@Controller({ ...options }) class A { @Get('y') a() {} }")[0]).toContain(
      'не строкой',
    );
    expect(brokenFor("@Controller({ 'path': 'x' }) class A { @Get('y') a() {} }")).toEqual([]);
  });

  it('декоратор, который разбор не признал маршрутом, выпадает из точного счёта', () => {
    const count = (code: string): number =>
      routesIn('x.controller.ts', controllersIn(parseSource(code), 'x.controller.ts'))
        .bareDecorators;
    // Тот же текст `@Get(` с глаголом из чужого модуля: сырой счёт видит его, разбор — нет.
    expect(
      count(
        "import { Controller } from '@nestjs/common';\nimport { Get } from '../http';\n@Controller() class A { @Get('y') a() {} }",
      ),
    ).toBe(0);
    expect(count(`${IMPORTS}@Controller() class A { @Get('y') a() {} }`)).toBe(1);
  });
});
