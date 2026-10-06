import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import * as ts from 'typescript';
import { stripComments } from './module-registration';

/**
 * Разбор декораторов контроллеров через TypeScript compiler API. Вынесен из
 * `roles-guard-wiring.spec.ts` (`LEGACY-110`), когда тем же разбором
 * понадобилось собрать список закрытых маршрутов (`LEGACY-234`); с 06.10.2026
 * (`T108`, `LEGACY-290`) разбор целиком на AST: текстовый разбор по балансу
 * скобок отвечал на один вход иначе, чем AST-разбор импортов в соседнем
 * стороже, и обоим приходилось верить на слово.
 *
 * Почему по исходникам, а не по метаданным поднятого приложения: сторожу
 * нужно видеть **все** контроллеры репозитория, включая те, что не попали ни
 * в один модуль. Поднятый `AppModule` показывает только подключённое.
 *
 * ⚠️ Имена декораторов, гвардов и интерцепторов сравниваются **по тому, что
 * импортировано**, а не по тексту в коде: `import { UseGuards as G }`,
 * `import * as common from '@nestjs/common'` и `@common.UseGuards(...)`,
 * подпуть пакета, импорт с расширением — всё это один и тот же декоратор.
 * Все вхождения `@UseGuards`/`@UseInterceptors` складываются: Nest исполняет
 * гварды из каждого.
 *
 * ⚠️ Чего разбор не видит и видеть не обязан: гвард, спрятанный в составной
 * декоратор (`applyDecorators`) или в базовый класс, — для сторожа публичного
 * кэша это отдельное нарушение (`public-cache-caller-independent.spec.ts`),
 * для прочих — граница.
 *
 * ⚠️ `stripComments` здесь не переписывается, а берётся из
 * `module-registration.ts`: правка краевого случая (`//` внутри
 * `'https://...'`) иначе уехала бы в одну из копий.
 */

export { stripComments };

export const SRC_ROOT = resolve(__dirname, '../..');

/**
 * Все файлы под `dir`, которые проходят `keep`. Обход один на всех сторожей:
 * восьмая рукописная копия `readdirSync(dir, { withFileTypes: true })` — это
 * восемь мест, где каталог исключают по одному, а расходятся они молча
 * (`LEGACY-290`).
 */
export const listFiles = (dir: string, keep: (posixPath: string) => boolean): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, keep);
    return entry.isFile() && keep(full.replace(/\\/g, '/')) ? [full] : [];
  });

export const listControllerFiles = (dir: string = SRC_ROOT): string[] =>
  listFiles(dir, (path) => path.endsWith('.controller.ts'));

/** Файлы DTO по всему `src`, а не только под `src/modules` (`LEGACY-133`). */
export const listDtoFiles = (dir: string = SRC_ROOT): string[] =>
  listFiles(dir, (path) => path.includes('/dto/') && path.endsWith('.dto.ts'));

export const readController = (file: string): string => readFileSync(file, 'utf8');

export const relativeToSrc = (file: string): string => relative(SRC_ROOT, file).replace(/\\/g, '/');

export const parseSource = (content: string, fileName = 'fixture.controller.ts'): ts.SourceFile =>
  ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);

/**
 * Совпадает ли путь импорта с модулем кандидата: пакет целиком или его
 * подпуть (`@nestjs/common/decorators/...` — так пишет автоимпорт IDE),
 * либо последний сегмент относительного пути; расширение (`.js`, `.ts`)
 * и `/index` не мешают. Подстрокой нельзя — `@nestjs/common` входит
 * в `@nestjs/common-x` (`L-008`). Пустой модуль — любой.
 */
export const isFromModule = (from: string, module: string): boolean => {
  const path = from.replace(/\.[cm]?[jt]s$/, '').replace(/\/index$/, '');
  return (
    module === '' || path === module || path.startsWith(`${module}/`) || path.endsWith(`/${module}`)
  );
};

/** Что импортировано в файле: имя в коде → откуда и под каким экспортируемым именем. */
export type ImportTable = {
  named: Map<string, { module: string; name: string }>;
  /** `import * as common from '@nestjs/common'`: `common` → `@nestjs/common`. */
  namespaces: Map<string, string>;
};

export const importsOf = (source: ts.SourceFile): ImportTable => {
  const table: ImportTable = { named: new Map(), namespaces: new Map() };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    // Имя экспорта по умолчанию не известно без разбора чужого модуля; берётся локальное —
    // `import JwtAuthGuard from './jwt.guard'` остаётся `JwtAuthGuard`, а не безликим `default`.
    if (clause.name) table.named.set(clause.name.text, { module, name: clause.name.text });
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      table.namespaces.set(bindings.name.text, module);
      continue;
    }
    for (const element of bindings.elements) {
      table.named.set(element.name.text, {
        module,
        name: (element.propertyName ?? element.name).text,
      });
    }
  }
  return table;
};

/**
 * Ссылка на имя: откуда оно пришло и как называется **там**, а не в этом файле.
 * `module` пуст у имени, которое не импортировано (объявлено в файле или глобально),
 * `name` пуст у выражения, которое разобрать нельзя (`...GUARDS`, `cond ? A : B`).
 * `text` — как написано в коде, для внятного отказа.
 */
export type Reference = { name: string; module: string; text: string };

/** Выражение без скобок, `as`, `!`, `new` и вызова фабрики класса — одно место на все разборы. */
export const unwrap = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    } else if (ts.isNewExpression(current)) {
      current = current.expression;
    } else if (ts.isCallExpression(current)) {
      // Вызов разворачивается только у фабрики класса с именем с большой буквы
      // (`AuthGuard('jwt')`, `common.AuthGuard('jwt')`). `buildGuards()` и
      // `[A, B].concat(extra)` — не имя гварда: вызов остаётся вызовом, и ссылка на него
      // выходит с пустым именем («не разобрать»), а не с правдоподобным `concat`.
      const callee = current.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          ? callee.name.text
          : '';
      if (!/^[A-Z]/.test(name)) return current;
      current = callee;
    } else return current;
  }
};

/** `JwtAuthGuard`, `new JwtAuthGuard()`, `AuthGuard('jwt')`, `common.UseGuards` — к имени. */
export const referenceOf = (expression: ts.Expression, imports: ImportTable): Reference => {
  const target = unwrap(expression);
  const text = target.getText();
  if (ts.isIdentifier(target)) {
    const imported = imports.named.get(target.text);
    return imported ? { ...imported, text } : { name: target.text, module: '', text };
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    const module = imports.namespaces.get(target.expression.text);
    if (module !== undefined) return { name: target.name.text, module, text };
    // `import { nest } from '../x'` и `@nest.UseGuards(...)`: имя справа пришло из модуля
    // объекта, а не «ниоткуда» — иначе пустой модуль совпал бы с любым (`isFrom`).
    const holder = imports.named.get(target.expression.text);
    if (holder) return { name: target.name.text, module: holder.module, text };
  }
  if (ts.isPropertyAccessExpression(target)) return { name: target.name.text, module: '', text };
  return { name: '', module: '', text };
};

/** Ссылки аргумента вызова: массив раскрывается по элементам, выражение — в одну ссылку. */
export const referencesOf = (expression: ts.Expression, imports: ImportTable): Reference[] => {
  const target = unwrap(expression);
  return ts.isArrayLiteralExpression(target)
    ? target.elements.flatMap((element) => referencesOf(element, imports))
    : [referenceOf(expression, imports)];
};

/**
 * Назван ли `ref` так-то и пришёл ли оттуда-то. Не импортированное имя (`module` пуст)
 * проходит по имени: так устроены и синтетические входы сторожей, и объявленное в файле.
 */
export const isFrom = (ref: Reference, name: string, module: string): boolean =>
  ref.name === name && (ref.module === '' || isFromModule(ref.module, module));

export const NEST_COMMON = '@nestjs/common';
export const NEST_SWAGGER = '@nestjs/swagger';

export type DecoratorUse = Reference & {
  args: readonly ts.Expression[];
  /** Аргументы, разложенные в ссылки на имена (`new X()`, `X('a')`, `[A, B]`). */
  argRefs: Reference[];
};

/** Все декораторы узла — класса, метода или параметра, — с именами по импортам. */
export const decoratorsOf = (node: ts.Node, imports: ImportTable): DecoratorUse[] =>
  (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []).map((decorator) => {
    const expression = decorator.expression;
    const call = ts.isCallExpression(expression);
    const args: readonly ts.Expression[] = call ? expression.arguments : [];
    const ref = referenceOf(call ? expression.expression : expression, imports);
    return {
      ...ref,
      args,
      argRefs: args.flatMap((argument) => referencesOf(argument, imports)),
    };
  });

/** Ссылки на все гварды из **всех** вхождений `@UseGuards(...)` в наборе декораторов. */
export const guardsOf = (uses: readonly DecoratorUse[]): Reference[] =>
  uses.filter((use) => isFrom(use, 'UseGuards', NEST_COMMON)).flatMap((use) => use.argRefs);

/** Ссылки на все интерцепторы из **всех** вхождений `@UseInterceptors(...)`. */
export const interceptorsOf = (uses: readonly DecoratorUse[]): Reference[] =>
  uses.filter((use) => isFrom(use, 'UseInterceptors', NEST_COMMON)).flatMap((use) => use.argRefs);

/**
 * Назван ли гвард в наборе декораторов — сравнение по имени целиком, не подстрокой:
 * `JwtAuthGuard` входит в `OptionalJwtAuthGuard`, который анонима как раз пропускает,
 * а `RolesGuard` — в любой будущий `SoftRolesGuard`, который ролей не читает.
 */
export const hasGuard = (uses: readonly DecoratorUse[], guard: string): boolean =>
  guardsOf(uses).some((ref) => ref.name === guard);

export const hasInterceptor = (uses: readonly DecoratorUse[], interceptor: string): boolean =>
  interceptorsOf(uses).some((ref) => ref.name === interceptor);

/** Строковое значение литерала или `undefined` для всего остального. */
export const stringValue = (expression: ts.Expression | undefined): string | undefined => {
  if (!expression) return undefined;
  const target = unwrap(expression);
  return ts.isStringLiteralLike(target) ? target.text : undefined;
};

/**
 * Восемь глаголов Nest, а не пять расхожих: обработчик, объявленный `@All(...)`
 * или `@Options(...)`, невидимый одному сторожу и видимый другому, — это два
 * зелёных сторожа с разными ответами на один и тот же вход.
 */
export const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'] as const;

export type HttpVerb = (typeof VERBS)[number];

/** Имя декоратора Nest для глагола: `get` → `Get`. Одно место на всех сторожей. */
export const verbDecoratorName = (verb: HttpVerb): string => verb[0].toUpperCase() + verb.slice(1);

/** Глагол маршрута, который объявляет декоратор, или `undefined`, если это не HTTP-декоратор Nest. */
export const verbOf = (use: DecoratorUse): HttpVerb | undefined =>
  VERBS.find((verb) => isFrom(use, verbDecoratorName(verb), NEST_COMMON));

export type HandlerInfo = {
  name: string;
  /** Строка, к которой относился блок декораторов, — для внятного отказа. */
  ownerLine: string;
  node: ts.MethodDeclaration;
  decorators: DecoratorUse[];
};

export type ControllerInfo = {
  /** Путь файла относительно `src`; у синтетического входа — его имя. */
  file: string;
  className: string;
  imports: ImportTable;
  node: ts.ClassDeclaration;
  decorators: DecoratorUse[];
  /** Базовые пути из `@Controller('x')`, `@Controller({ path: 'x' })`, `@Controller(['a', 'b'])`. */
  bases: string[];
  hasBaseClass: boolean;
  handlers: HandlerInfo[];
};

const pathsOf = (expression: ts.Expression | undefined): string[] => {
  if (!expression) return [''];
  const target = unwrap(expression);
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) => pathsOf(element));
  }
  const literal = stringValue(target);
  // Путь, собранный выражением, разобрать нельзя; он остаётся видимым в отказе, а не
  // превращается молча в корень.
  return [literal ?? `<${target.getText()}>`];
};

/**
 * Ключ свойства объектного литерала: `path`, `'path'` и `"path"` — один и тот же ключ.
 * Вычисляемый ключ и `...spread` ключа не имеют — `undefined`.
 */
export const propertyKey = (property: ts.ObjectLiteralElementLike): string | undefined =>
  property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
    ? property.name.text
    : undefined;

const controllerBases = (use: DecoratorUse): string[] => {
  const [first] = use.args;
  const target = first ? unwrap(first) : undefined;
  if (target && ts.isObjectLiteralExpression(target)) {
    const path = target.properties.find((property) => propertyKey(property) === 'path');
    if (path && ts.isPropertyAssignment(path)) return pathsOf(path.initializer);
    // `{ path }` краткой записью и `{ ...options }` — путь собран выражением: он остаётся
    // видимым, а не превращается молча в корень.
    if (path) return [`<${path.getText()}>`];
    const spread = target.properties.find(ts.isSpreadAssignment);
    return spread ? [`<${spread.getText()}>`] : [''];
  }
  return pathsOf(first);
};

const ownerLineOf = (source: ts.SourceFile, member: ts.MethodDeclaration): string => {
  const first: ts.Node =
    member.modifiers?.find((modifier) => !ts.isDecorator(modifier)) ?? member.name;
  // Начала строк берутся из той же карты TS, что и номер строки: `split` по `\n` разошёлся бы
  // с ней на одиночном `\r` или U+2028 и не резал бы весь файл заново на каждый метод.
  const { line } = source.getLineAndCharacterOfPosition(first.getStart(source));
  const starts = source.getLineStarts();
  return source.text.slice(starts[line], starts[line + 1] ?? source.text.length).trim();
};

/** Классы файла под `@Controller(...)` — с разобранными декораторами и обработчиками. */
export const controllersIn = (source: ts.SourceFile, file: string): ControllerInfo[] => {
  const imports = importsOf(source);
  const out: ControllerInfo[] = [];
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const decorators = decoratorsOf(statement, imports);
    const controller = decorators.find((use) => isFrom(use, 'Controller', NEST_COMMON));
    if (!controller) continue;
    out.push({
      file,
      className: statement.name?.text ?? '<без имени>',
      imports,
      node: statement,
      decorators,
      bases: controllerBases(controller),
      hasBaseClass: (statement.heritageClauses ?? []).some(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      ),
      handlers: statement.members.filter(ts.isMethodDeclaration).map((member) => ({
        name: member.name.getText(source),
        ownerLine: ownerLineOf(source, member),
        node: member,
        decorators: decoratorsOf(member, imports),
      })),
    });
  }
  return out;
};

/** Контроллеры файла по пути. `file` в результате — путь относительно `src`. */
export const parseControllerFile = (file: string): ControllerInfo[] =>
  controllersIn(parseSource(readFileSync(file, 'utf8'), file), relativeToSrc(file));

export type RouteDecorator = {
  verb: HttpVerb;
  paths: string[];
  /** Как декоратор написан в коде: `Get`, `G`, `common.Get` — для сверки с сырым счётом. */
  text: string;
};

/** HTTP-декораторы обработчика: по одному на каждое вхождение, пути — по каждому из массива. */
export const routeDecoratorsOf = (handler: HandlerInfo): RouteDecorator[] =>
  handler.decorators.flatMap((use) => {
    const verb = verbOf(use);
    return verb ? [{ verb, paths: pathsOf(use.args[0]), text: use.text }] : [];
  });

export type ControllerRoute = {
  /** Путь файла относительно `src`. */
  file: string;
  verb: HttpVerb;
  /** Путь маршрута с ведущей косой; параметры оставлены как `:name`. */
  path: string;
  /** Строка, к которой относился блок декораторов, — для внятного отказа. */
  ownerLine: string;
  /**
   * Стоит ли на маршруте `@ApiBearerAuth()` — на самом методе или на его классе
   * (`LEGACY-132`). Складывается так же, как гварды: декоратор класса действует
   * на все его методы.
   */
  bearerAuth: boolean;
};

const joinPath = (base: string, sub: string): string => {
  const parts = [base, sub].filter((part) => part !== '').join('/');
  return (
    '/' +
    parts
      .replace(/^\/+/, '')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/, '')
  );
};

const hasApiBearerAuth = (uses: readonly DecoratorUse[]): boolean =>
  uses.some((use) => isFrom(use, 'ApiBearerAuth', NEST_SWAGGER));

/**
 * Маршруты контроллеров, разложенные на закрытые названным гвардом и открытые.
 * Отдельно от обхода репозитория, чтобы сторожа прогонялись и на синтетическом
 * входе, а не только на дереве, где нарушений нет (`L-017`).
 *
 * ⚠️ Гварды в Nest **складываются**: гвард класса действует на метод, даже если
 * у метода есть свой `@UseGuards(...)`, и несколько `@UseGuards` на одном узле
 * действуют все. Закрытым считается обработчик, у которого гвард нашёлся хоть
 * где-то из двух мест.
 */
export const routesOf = (
  controllers: readonly ControllerInfo[],
  guard?: string,
): { closed: ControllerRoute[]; open: ControllerRoute[] } => {
  const closed: ControllerRoute[] = [];
  const open: ControllerRoute[] = [];

  for (const controller of controllers) {
    // Гвард не назван — закрытых нет, весь список приходит в `open`.
    const classGuarded = guard !== undefined && hasGuard(controller.decorators, guard);
    const classBearerAuth = hasApiBearerAuth(controller.decorators);

    for (const handler of controller.handlers) {
      // Nest пишет путь и метод в метаданные самого обработчика, и из нескольких
      // HTTP-декораторов на одном методе действует верхний (применяется последним) —
      // остальные маршрута не дают.
      for (const { verb, paths } of routeDecoratorsOf(handler).slice(0, 1)) {
        for (const base of controller.bases) {
          for (const sub of paths) {
            const route: ControllerRoute = {
              file: controller.file,
              verb,
              path: joinPath(base, sub),
              ownerLine: handler.ownerLine,
              bearerAuth: classBearerAuth || hasApiBearerAuth(handler.decorators),
            };
            if (classGuarded || (guard !== undefined && hasGuard(handler.decorators, guard))) {
              closed.push(route);
            } else open.push(route);
          }
        }
      }
    }
  }

  return { closed, open };
};

/**
 * Все маршруты всех контроллеров репозитория, разложенные на закрытые
 * названным гвардом и открытые.
 *
 * ⚠️ Файл `*.controller.ts` без класса под `@Controller` пропускается, и пропуск
 * считается: `skipped` возвращается наружу, чтобы сторож мог отличить
 * «таких нет» от «разбор сломался и молча ничего не нашёл».
 */
export const collectRoutes = (
  guard?: string,
): { closed: ControllerRoute[]; open: ControllerRoute[]; skipped: string[] } => {
  const closed: ControllerRoute[] = [];
  const open: ControllerRoute[] = [];
  const skipped: string[] = [];

  for (const file of listControllerFiles()) {
    const controllers = parseControllerFile(file);
    if (controllers.length === 0) {
      skipped.push(relativeToSrc(file));
      continue;
    }
    const found = routesOf(controllers, guard);
    closed.push(...found.closed);
    open.push(...found.open);
  }

  return { closed, open, skipped };
};

/**
 * Все маршруты репозитория одним списком — вход для сторожей, которым гварды
 * безразличны (`LEGACY-024`: пути e2e-спек против объявленных маршрутов).
 *
 * ⚠️ `skipped` возвращается наружу так же, как у `collectRoutes`: файл без
 * контроллера в список не попадает, и сторож обязан отличать «такого маршрута
 * нет» от «файл не разобран».
 */
export const allRoutes = (): { routes: ControllerRoute[]; skipped: string[] } => {
  const { closed, open, skipped } = collectRoutes();
  return { routes: [...closed, ...open], skipped };
};

/* Текстовые помощники ниже декораторов не разбирают: ими пользуется `clearance-lock-writers.spec.ts`. */

/**
 * Строка, шаблон или комментарий, начинающиеся на `i`: индекс их последнего символа, иначе `-1`.
 * Один пропуск литералов на все разборщики модуля — скобка или запятая внутри текста сообщения
 * не должна сдвигать границы вызова ни в одном из них (`LEGACY-290`).
 */
const literalEnd = (text: string, i: number): number => {
  const ch = text[i];
  if (ch === '/' && text[i + 1] === '/') {
    const eol = text.indexOf('\n', i);
    return eol === -1 ? text.length - 1 : eol;
  }
  if (ch === '/' && text[i + 1] === '*') {
    const close = text.indexOf('*/', i + 2);
    return close === -1 ? text.length - 1 : close + 1;
  }
  if (ch !== "'" && ch !== '"' && ch !== '`') return -1;
  let j = i + 1;
  while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
  return j;
};

/** Индекс закрывающей скобки для открывающей на `open`, литералы пропускаются. Нет пары — `-1`. */
export const closingParen = (text: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const skip = literalEnd(text, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
};

/** Аргументы верхнего уровня вызова между `open` и `close`, литералы пропускаются. */
export const topLevelArgs = (text: string, open: number, close: number): string[] => {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const skip = literalEnd(text, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const ch = text[i];
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start, close).trim();
  if (last) args.push(last);
  return args;
};
