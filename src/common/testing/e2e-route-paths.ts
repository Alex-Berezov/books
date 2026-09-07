import * as ts from 'typescript';
import { VERBS, type HttpVerb } from './controller-decorators';

/**
 * Разбор путей, по которым e2e-спеки ходят в приложение (`LEGACY-024`).
 *
 * Вынесен из спеки отдельным модулем по раскладке этой папки: разбор — модуль,
 * сторож — спека поверх него (`controller-decorators.ts`, `module-registration.ts`).
 * Импортировать разбор из `.spec.ts` нельзя — импорт запускает её `describe`,
 * и второй сторож, которому понадобится тот же разбор, написал бы свою копию
 * (`LEGACY-290`).
 *
 * ⚠️ Разбор идёт компилятором TypeScript, а не регулярками (`L-008`).
 * Регулярка не отличает `map.get('/x')` от supertest-цепочки и не видит обёртку
 * `const get = (path: string) => request(http()).get(path)`, которой пользуются
 * четыре спеки: обе ошибки дали бы молчаливый пропуск.
 *
 * Что восстанавливается, кроме литерала на месте вызова:
 * - константа того же файла (`const PATH = '/en/categories?type=collection'`);
 * - локальная обёртка над supertest — тогда проверяются её вызовы, а не тело;
 * - параметр колбэка `it.each([[...], [...]])` — по столбцу таблицы.
 *
 * Не восстановилось — это **отдельный исход, а не пропуск** (`L-015`): вызов
 * возвращается с полем `unresolved`, и сторож обязан краснеть на непустом
 * списке таких вызовов.
 */

/**
 * Метка подстановки `${...}` в разобранном пути.
 *
 * 🔴 Записывается escape-последовательностью, а не самим байтом: сырой `NUL`
 * в исходнике делает файл двоичным для git, `grep` и `rg`. Правка такого файла
 * приходит в ревью строкой `Binary files differ` — добавленных строк у него нет,
 * и ни `standards.js`, ни `commit-gate.js` по нему не проверяют ничего.
 */
const HOLE = '\u0000';

type PathPattern = string;

export type SpecCall = {
  file: string;
  line: number;
  verb: HttpVerb;
  /** Восстановленные пути. Больше одного даёт только таблица `it.each`. */
  paths: PathPattern[];
  /** Текст аргумента, если путь восстановить не удалось. */
  unresolved?: string;
  /**
   * Цепочка требует 404 или 405 — спека утверждает, что маршрута нет
   * (`rights-claims.e2e-spec.ts`: «claims не удаляются, закрытие — единственная
   * терминальная операция»). Отсутствие такого пути в таблице маршрутов —
   * подтверждение спеки, а не её ошибка.
   */
  expectsAbsence?: boolean;
};

/** Коды, которыми спека объявляет, что маршрута нет. */
const ABSENCE_STATUSES = new Set([404, 405]);

/** Те же коды именами `HttpStatus`. */
const ABSENCE_NAMES = new Set(['NOT_FOUND', 'METHOD_NOT_ALLOWED']);

const isVerb = (name: string): name is HttpVerb => (VERBS as readonly string[]).includes(name);

/** Строковый узел -> шаблон пути; подстановки заменяются меткой. */
const patternOf = (node: ts.Node): PathPattern | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => HOLE + span.literal.text).join('');
  }
  return undefined;
};

/** Ближайшая функция, в теле которой лежит узел. */
const enclosingFunction = (node: ts.Node): ts.ArrowFunction | ts.FunctionExpression | undefined => {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) return cur;
  }
  return undefined;
};

/**
 * Значения столбца таблицы `it.each([[...], [...]])(name, (a, b) => ...)`
 * для параметра под номером `index`. Пусто — таблица не литеральная либо
 * колбэк принадлежит не `each`.
 */
const eachColumn = (
  fn: ts.ArrowFunction | ts.FunctionExpression,
  index: number,
): PathPattern[] | undefined => {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call)) return undefined;
  const each = call.expression;
  if (!ts.isCallExpression(each)) return undefined;
  const callee = each.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'each') return undefined;

  const table = each.arguments[0];
  if (!table || !ts.isArrayLiteralExpression(table)) return undefined;

  const values: PathPattern[] = [];
  for (const row of table.elements) {
    // Плоская таблица `it.each(['?page=abc', '?page='])` — строка сама и есть
    // единственный столбец; она законна ровно для колбэка с одним параметром.
    const cell = ts.isArrayLiteralExpression(row)
      ? row.elements[index]
      : index === 0 && fn.parameters.length === 1
        ? row
        : undefined;
    const pattern = cell ? patternOf(cell) : undefined;
    if (pattern === undefined) return undefined;
    values.push(pattern);
  }
  return values.length > 0 ? values : undefined;
};

/**
 * Метка места, куда обёртка подставляет свой аргумент.
 *
 * Отдельная от `HOLE` намеренно: `HOLE` — «здесь было любое значение,
 * проверять нечего», а `PARAM` — «сюда приедет путь из вызова», и подставить
 * туда надо именно его.
 */
const PARAM = '\u0001';

/** Сегмент, о котором известно только то, что он есть: значение параметра. */
const ANY_SEGMENT = '\u0002';

/** Приставка сегмента, у которого известно начало, но не хвост. */
const PREFIX = '\u0003';

type Wrapper = {
  verb: HttpVerb;
  /** Номер параметра обёртки, в котором приезжает путь. */
  index: number;
  /** Тело обёртки: шаблон пути с `PARAM` на месте её параметра. */
  template: PathPattern;
  /**
   * Та самая цепочка тела, по которой обёртка опознана. Из разбора исключается
   * только она: остальные обращения внутри тела — обычные вызовы, и молчаливо
   * терять их нельзя (логин внутри обёртки уходил бы мимо сверки целиком).
   */
  chain: ts.CallExpression;
};

/** Корень цепочки `request(...)` — значит вызов уходит в приложение. */
const rootsAtRequest = (receiver: ts.Expression): boolean => {
  let cur: ts.Expression = receiver;
  for (;;) {
    if (ts.isCallExpression(cur)) {
      if (ts.isIdentifier(cur.expression) && cur.expression.text === 'request') return true;
      cur = cur.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return false;
  }
};

/**
 * Тело обёртки как шаблон пути: на месте её параметра — `PARAM`, на месте
 * прочих подстановок — `HOLE`. Аргумент-идентификатор даёт голый `PARAM`,
 * то есть путь целиком приходит из вызова.
 *
 * 🔴 Разбирать надо и шаблон, а не только голый параметр: `test/tag-books-query.e2e-spec.ts:78`
 * объявлен как `const get = (query: string) => request(http()).get(\`/en/tags/${slug}/books${query}\`)`,
 * и первая редакция такую обёртку не признавала вовсе — семь её вызовов
 * не проверялись и в отчёт о невосстановимых не попадали. Это ровно тот
 * молчаливый пропуск, который сторожу запрещён (`L-015`).
 */
const wrapperTemplate = (
  arg: ts.Expression,
  params: string[],
): { index: number; template: PathPattern } | undefined => {
  if (ts.isIdentifier(arg)) {
    const index = params.indexOf(arg.text);
    return index >= 0 ? { index, template: PARAM } : undefined;
  }
  if (!ts.isTemplateExpression(arg)) return undefined;

  let index = -1;
  let template = arg.head.text;
  for (const span of arg.templateSpans) {
    const named = ts.isIdentifier(span.expression) ? params.indexOf(span.expression.text) : -1;
    if (named >= 0 && index === -1) {
      index = named;
      template += PARAM;
    } else {
      template += HOLE;
    }
    template += span.literal.text;
  }
  return index >= 0 ? { index, template } : undefined;
};

/**
 * Локальные обёртки над supertest: `const get = (path: string) =>
 * request(http()).get(path)`. Тело обёртки проверять нечего — путь приходит
 * снаружи, поэтому проверяются её вызовы.
 */
const wrappersOf = (source: ts.SourceFile): Map<string, Wrapper> => {
  const found = new Map<string, Wrapper>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      const fn = node.initializer;
      const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));

      const findChain = (inner: ts.Node): void => {
        if (
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          isVerb(inner.expression.name.text) &&
          rootsAtRequest(inner.expression.expression)
        ) {
          const arg = inner.arguments[0];
          const shape = arg ? wrapperTemplate(arg, params) : undefined;
          const name = node.name.getText();
          if (shape && !found.has(name)) {
            found.set(name, {
              verb: inner.expression.name.text,
              index: shape.index,
              template: shape.template,
              chain: inner,
            });
          }
        }
        ts.forEachChild(inner, findChain);
      };
      findChain(fn);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
};

/**
 * Требует ли цепочка, в которой стоит вызов, кода 404 или 405. Ищется по всей
 * цепочке целиком — `.expect(404)` стоит в её конце, а не рядом с глаголом.
 */
const expectsAbsence = (call: ts.CallExpression): boolean => {
  let top: ts.Node = call;
  while (
    top.parent &&
    ((ts.isPropertyAccessExpression(top.parent) && top.parent.expression === top) ||
      (ts.isCallExpression(top.parent) && top.parent.expression === top))
  ) {
    top = top.parent;
  }

  let found = false;
  const scan = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'expect'
    ) {
      const arg = node.arguments[0];
      // Код пишут и числом, и через `HttpStatus.NOT_FOUND` — обе формы значат одно.
      const named =
        arg && ts.isPropertyAccessExpression(arg) && arg.expression.getText() === 'HttpStatus'
          ? ABSENCE_NAMES.has(arg.name.text)
          : false;
      if (arg && ((ts.isNumericLiteral(arg) && ABSENCE_STATUSES.has(Number(arg.text))) || named)) {
        found = true;
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(top);
  return found;
};

/** Все обращения к приложению в одной e2e-спеке. */
export const callsOf = (text: string, file: string): SpecCall[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wrappers = wrappersOf(source);
  const constants = new Map<string, PathPattern>();

  /**
   * Карта «имя → путь» по константам файла.
   *
   * ⚠️ Только `const` и только значение, похожее на путь. `let url = ''`,
   * которому настоящий адрес присваивают в `beforeAll`, дал бы разбор пустого
   * пути — а пустой путь совпадает с корневым маршрутом `GET /`, и вызов ушёл бы
   * в «проверено» вместо «не восстановлено».
   */
  const collectConstants = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      node.parent &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const pattern = patternOf(node.initializer);
      if (pattern !== undefined && pattern.startsWith('/')) constants.set(node.name.text, pattern);
    }
    ts.forEachChild(node, collectConstants);
  };
  collectConstants(source);

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const resolvePath = (arg: ts.Expression | undefined): Pick<SpecCall, 'paths' | 'unresolved'> => {
    if (!arg) return { paths: [], unresolved: '<без аргумента>' };

    const direct = patternOf(arg);
    if (direct !== undefined) return { paths: [direct] };

    if (ts.isIdentifier(arg)) {
      // 🔴 Параметр функции проверяется раньше карты констант: имя, объявленное
      // и на верхнем уровне файла, и параметром колбэка, затеняет константу —
      // а карта плоская и области видимости не знает. Порядок наоборот дал бы
      // разбор чужого значения: красное на исправной спеке либо тишину
      // на пути с опечаткой.
      const fn = enclosingFunction(arg);
      const index = fn?.parameters.findIndex(
        (p) => ts.isIdentifier(p.name) && p.name.text === arg.text,
      );
      if (fn && index !== undefined && index >= 0) {
        const column = eachColumn(fn, index);
        return column ? { paths: column } : { paths: [], unresolved: arg.getText(source) };
      }

      const constant = constants.get(arg.text);
      if (constant !== undefined) return { paths: [constant] };
    }
    return { paths: [], unresolved: arg.getText(source) };
  };

  const calls: SpecCall[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      if (ts.isPropertyAccessExpression(callee) && isVerb(callee.name.text)) {
        if (rootsAtRequest(callee.expression)) {
          const isWrapperChain = [...wrappers.values()].some((w) => w.chain === node);
          if (!isWrapperChain) {
            calls.push({
              file,
              line: lineOf(node),
              verb: callee.name.text,
              expectsAbsence: expectsAbsence(node),
              ...resolvePath(node.arguments[0]),
            });
          }
        }
      } else if (ts.isIdentifier(callee) && wrappers.has(callee.text)) {
        const wrapper = wrappers.get(callee.text) as Wrapper;
        const resolved = resolvePath(node.arguments[wrapper.index]);
        // Аргумент не восстановился — исход зависит от того, что обёртка из него
        // строит. Путь целиком (`get(path)`) неизвестен, и это «не проверено».
        // Кусок шаблона (`get(\`/books/\${id}\${query}\`)`) — это значение
        // в позиции параметра: `gateOf(driftVersionId)` подставляет туда
        // идентификатор строки, а не адрес, и сверять там нечего.
        const opaqueFragment = resolved.unresolved !== undefined && wrapper.template !== PARAM;
        const patterns = opaqueFragment ? [HOLE] : resolved.paths;

        calls.push({
          file,
          line: lineOf(node),
          verb: wrapper.verb,
          // Код отказа проверяется и здесь: `del(path).expect(404)` — такое же
          // утверждение об отсутствии маршрута, как и у прямой цепочки.
          expectsAbsence: expectsAbsence(node),
          paths: patterns.map((pattern) => wrapper.template.split(PARAM).join(pattern)),
          unresolved: opaqueFragment ? undefined : resolved.unresolved,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return calls;
};

/**
 * Сегменты пути. Хвост после `?` и `#` отбрасывается.
 *
 * Сегмент бывает трёх видов, и различать их обязательно:
 * - литерал — сравнивается буквально;
 * - целиком подстановка (`/books/${id}`) — совпадает с любым сегментом;
 * - литеральное начало плюс неизвестный хвост (`/en/books${query}`) — совпадает
 *   только с тем, что с этого начала начинается.
 *
 * 🔴 Третий вид раньше сводился ко второму, и это была дыра ровно того класса,
 * ради которого сторож заведён: `/en/books${query}` превращался в `['en', ':']`
 * и совпадал с `/:lang/tags`, а `/categories${query}` — с `GET /health`. Снятый
 * маршрут при этом числился бы сверенным.
 *
 * ⚠️ Подстановка в конце последнего сегмента может оказаться и хвостом сегмента,
 * и строкой запроса, поэтому возвращаются оба разбора: путь известен, если
 * совпал хоть один. Иначе сторож краснел бы на исправных спеках.
 */
const segmentsOf = (pattern: PathPattern): string[][] => {
  const head = pattern.split('?')[0].split('#')[0];
  const parts = head.split('/').filter((s) => s !== '');

  const asWritten = parts.map((part) => {
    if (!part.includes(HOLE)) return part;
    // Подстановка занимает сегмент целиком — это значение параметра.
    if (part.startsWith(HOLE)) return ANY_SEGMENT;
    // Литеральное начало, дальше неизвестно.
    return PREFIX + part.slice(0, part.indexOf(HOLE));
  });

  const last = parts[parts.length - 1];
  if (last !== undefined && last.includes(HOLE) && !last.startsWith(HOLE)) {
    // Второй разбор: подстановка была строкой запроса, сегмент кончился литералом.
    const trimmed = [...asWritten.slice(0, -1), last.slice(0, last.indexOf(HOLE))];
    return [asWritten, trimmed];
  }
  return [asWritten];
};

export type Route = { verb: HttpVerb; segments: string[] };

/**
 * Сегмент маршрута против сегмента пути.
 *
 * ⚠️ Параметр в Nest занимает не обязательно весь сегмент: `sitemap-:lang.xml`
 * — один сегмент с параметром внутри. Сравнение по `startsWith(':')` такой
 * маршрут не находило вовсе, и исправная спека выглядела ошибкой.
 */
const segmentFits = (routeSegment: string, segment: string): boolean => {
  if (segment === ANY_SEGMENT) return true;

  if (segment.startsWith(PREFIX)) {
    // Известно только начало сегмента. Маршрут подходит, если начинается так же,
    // либо если его собственный параметр начинается не позже конца этого начала:
    // `sitemap-${lang}` против `sitemap-:lang.xml`.
    const prefix = segment.slice(PREFIX.length);
    const literal = routeSegment.split(':')[0];
    return (
      routeSegment.startsWith(prefix) || (routeSegment.includes(':') && prefix.startsWith(literal))
    );
  }

  if (!routeSegment.includes(':')) return routeSegment === segment;
  const pattern = routeSegment
    .split(/(:[A-Za-z0-9_]+)/)
    .map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${pattern}$`).test(segment);
};

const fits = (route: Route, segments: string[], verb: HttpVerb): boolean => {
  if (route.verb !== verb && route.verb !== 'all') return false;
  if (route.segments.length !== segments.length) return false;
  return route.segments.every((rs, i) => segmentFits(rs, segments[i]));
};

/** Глобальный префикс приложения (`src/main.ts`: `app.setGlobalPrefix('api')`). */
const GLOBAL_PREFIX = 'api';

/** Есть ли такой путь среди маршрутов; `verb === undefined` — под любым глаголом. */
const routeExists = (routes: Route[], pattern: PathPattern, verb?: HttpVerb): boolean =>
  segmentsOf(pattern).some((segments) => {
    const matches = (segs: string[]): boolean =>
      routes.some((route) =>
        verb === undefined
          ? route.segments.length === segs.length &&
            route.segments.every((rs, i) => segmentFits(rs, segs[i]))
          : fits(route, segs, verb),
      );
    if (matches(segments)) return true;
    // Спека, поднимающая приложение с глобальным префиксом, ходит по `/api/...`.
    return segments[0] === GLOBAL_PREFIX && matches(segments.slice(1));
  });

/**
 * Разбор всех обращений против таблицы маршрутов.
 *
 * 🔴 Цепочка с `.expect(404)` **не даёт пропуска сама по себе**. Пропуск даётся
 * только тогда, когда путь существует под другим глаголом: спека утверждает
 * «маршрут есть, а этот метод не поддержан» (`rights-claims.e2e-spec.ts`:
 * «claims не удаляются, закрытие — единственная терминальная операция»).
 * Путь, которого нет ни под каким глаголом, краснеет и с `.expect(404)` —
 * иначе опечатка вида `/versions/:id/audio-chapter` вместо `audio-chapters`
 * давала бы зелёный тест (404 приходит из-за отсутствия маршрута) и молчащего
 * сторожа, то есть ровно прецедент `LEGACY-024`.
 *
 * `checked` считает пути, которые действительно сверены, а не число вызовов:
 * порог, стоящий на длине списка вызовов, не заметил бы, что проверять
 * перестало (`L-015`).
 */
export const verifyPaths = (
  routes: Route[],
  calls: SpecCall[],
): { mismatches: string[]; checked: number; declaredAbsent: string[] } => {
  const mismatches: string[] = [];
  const declaredAbsent: string[] = [];
  let checked = 0;

  for (const call of calls) {
    for (const pattern of call.paths) {
      const shown = pattern.split(HOLE).join('${…}');
      const where = `${call.file}:${call.line}: ${call.verb.toUpperCase()} '${shown}'`;

      if (routeExists(routes, pattern, call.verb)) {
        checked += 1;
        continue;
      }
      if (call.expectsAbsence === true && routeExists(routes, pattern)) {
        checked += 1;
        declaredAbsent.push(`${where} — метод не поддержан, спека требует отказа`);
        continue;
      }
      mismatches.push(`${where} — такого маршрута нет`);
    }
  }

  return { mismatches, checked, declaredAbsent };
};

/** Пути, которых нет среди маршрутов, — по строке на каждый. */
export const mismatchesOf = (routes: Route[], calls: SpecCall[]): string[] =>
  verifyPaths(routes, calls).mismatches;
