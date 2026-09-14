#!/usr/bin/env node
// Response-schema check: does the OpenAPI schema of a route describe everything the code
// actually returns?
//
// Swagger builds the response schema from `@ApiResponse({ type })` and nothing else — there is
// no CLI plugin here (nest-cli.json has no `plugins`), so a DTO that forgets a field simply
// documents less than the handler returns, and nothing goes red. That is not a documentation
// nicety: books-front writes its `types/api-schema/**` by hand and the type-sync gate there
// compares them against this schema. A DTO poorer than the handler pushes the front to DELETE
// correct fields from its own types — exactly what stopped the strict layer of `Q4`
// (`ReadingProgressDto` documented 3 fields while reading-progress.service.ts returned 7).
//
// The check reads two sources and compares them field by field, recursively:
//   1. the TypeScript return type of every controller method (TS Compiler API — the type the
//      handler really produces, `select`/`include` narrowing included);
//   2. `libs/api-client/api-schema.json` — the committed OpenAPI snapshot, i.e. what Swagger
//      actually emits (already guarded against manual edits by openapi-snapshot.spec.ts).
//
// Verdict per route:
//   ok            — schema present and covers every field the code returns (nested too);
//   poor          — schema present but MISSES fields the code returns  -> exit 1;
//   undocumented  — the handler answers with a body and no schema describes it       -> exit 1;
//   unverifiable  — the return type cannot be read (any/unknown/union of objects/no signature)
//                                                                                    -> exit 1;
//   no-body       — the handler answers with nothing, a primitive, or 204;
//   not-in-snapshot — the code declares the route, the snapshot does not know it.
//
// `unverifiable` is printed, never swallowed: a check that cannot say "I did not look at this"
// is indistinguishable from a check that passed (L-015, L-017). Until 14.09.2026 it was printed
// AND ignored by the exit code, together with `undocumented` and with the partial `unverified`
// list — 123 routes out of 314 went unchecked under a green verdict. Now the first two are red
// outright, and the third one is held by a ratchet (see RATCHET below): its causes are Json
// columns, recursion and depth, i.e. places where the handler's type is wider than any schema
// by construction, so a blanket red there would only ask for the check to be weakened back.
//
// RATCHET (`scripts/response-schema-unverified.json`): counts of partially verified routes by
// cause. Any deviation is red, in BOTH directions — growth means a new unchecked place, a drop
// without re-snapshotting means the baseline stopped describing reality. Counts by class, never
// a list of routes: a list is the baseline forbidden by `C19`. Re-snapshot with
// `yarn check:response-schema:snapshot`; under `CI=true` the flag is ignored, so a red pipeline
// cannot be talked into agreeing with itself.
//
// What the ratchet does NOT catch, stated plainly because a guard that overclaims is worse than
// one that admits its limit: an equal-size swap. Narrow one `union of object types` on route A
// and introduce one on route B in the same commit, and every count lands where it was — the gate
// stays green while a newly unchecked route ships. Closing that needs a per-route list, i.e. the
// baseline `C19` forbids, so the cost is accepted and named rather than papered over.
//
// Pure Node (>= 20) plus the already-installed `typescript`. Reads the repo; writes only
// when `--report <path>` or `--update` is given explicitly.
//
// Usage:
//   node scripts/check-response-schema.mjs [repoDir] [--report <path>] [--update]
//   node scripts/check-response-schema.mjs --self-test
//
// Exit code: 0 — every route is either fully checked or honestly declared body-less;
//            1 — a schema is poorer than the answer, a body is undocumented, a return type is
//                unreadable, or the ratchet moved.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(SCRIPT_DIR, '..');

// Снимок счёта частично проверенного. Лежит рядом со сторожем, а не в `libs/`: это его
// собственное состояние, а не часть контракта API.
const RATCHET_FILE = 'scripts/response-schema-unverified.json';
const RATCHET_PATH = join(SCRIPT_DIR, 'response-schema-unverified.json');
let UPDATE_RATCHET = false;

// Глаголы держатся ОДНИМ списком на репозиторий: `src/common/testing/controller-decorators.ts`
// объявляет `VERBS`, и там же написано, почему копии обязаны совпадать — обработчик под `@All`
// или `@Options`, видимый одному сторожу и невидимый другому, даёт двух зелёных сторожей
// с разными ответами на один вход. Импортировать оттуда нельзя (тот модуль на TypeScript,
// а этот файл — голый Node), поэтому список не копируется молча, а СВЕРЯЕТСЯ: разошлись —
// красное с названной причиной, а не тихо пропущенный маршрут.
const VERBS_SOURCE = 'src/common/testing/controller-decorators.ts';
const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];

function assertVerbsMatchSharedList(repoDir) {
  const file = join(repoDir, VERBS_SOURCE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`не найден источник списка глаголов ${VERBS_SOURCE}: сверить копию не с чем`);
  }
  const match = /export const VERBS = \[([^\]]*)\]/.exec(text);
  if (!match) throw new Error(`в ${VERBS_SOURCE} не найдено объявление VERBS: сверить копию не с чем`);
  const shared = match[1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  const mine = [...HTTP_VERBS].sort().join(',');
  const theirs = [...shared].sort().join(',');
  if (mine !== theirs) {
    throw new Error(
      `список глаголов разошёлся с ${VERBS_SOURCE}: здесь [${HTTP_VERBS.join(', ')}], там [${shared.join(', ')}]. ` +
        'Маршрут под глаголом, которого нет в этом списке, проверка не увидит вовсе.',
    );
  }
}

const HTTP_DECORATORS = new Set(HTTP_VERBS.map((v) => v[0].toUpperCase() + v.slice(1)));

// Ниже этого числа сломан обход, а не поредел репозиторий (тот же приём, что
// `MIN_PATHS` в openapi-snapshot.spec.ts и `MIN_CONTROLLERS` в dto-api-property.spec.ts).
const MIN_ROUTES = 280;

// Types whose "properties" are methods or internals, never a JSON object body.
const LEAF_TYPE_NAMES = new Set([
  'Date',
  'Decimal',
  'Buffer',
  'Uint8Array',
  'ArrayBuffer',
  'StreamableFile',
  'RegExp',
  'Error',
]);

const MAX_DEPTH = 6;

/* ---------------- program ---------------- */

function createProgram(repoDir, tsconfigName = 'tsconfig.json') {
  const configPath = join(repoDir, tsconfigName);
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
  if (cfg.error) {
    throw new Error(`cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(cfg.error.messageText, ' ')}`);
  }
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, repoDir);
  return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
}

/* ---------------- decorators ---------------- */

const decoratorsOf = (node) => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []);

function decoratorInfo(decorator) {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr)) {
    return { name: ts.isIdentifier(expr) ? expr.text : null, args: [] };
  }
  return {
    name: ts.isIdentifier(expr.expression) ? expr.expression.text : null,
    args: Array.from(expr.arguments),
  };
}

function stringArgument(arg) {
  if (arg === undefined) return '';
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return null;
}

/* ---------------- route paths ---------------- */

// `books` + `:id` -> `/books/{id}`; `sitemap-:lang.xml` -> `/sitemap-{lang}.xml`.
export function toOpenApiPath(prefix, sub) {
  const segments = [...String(prefix ?? '').split('/'), ...String(sub ?? '').split('/')].filter(Boolean);
  const mapped = segments.map((segment) => segment.replace(/:(\w+)\??/g, (_, name) => `{${name}}`));
  return '/' + mapped.join('/');
}

/* ---------------- route discovery ---------------- */

function collectRoutes(program, repoDir) {
  const routes = [];
  // Отброшенное не исчезает молча: контроллер с вычисляемым префиксом или маршрут
  // с вычисляемым путём попадают сюда и печатаются отдельным списком (L-015).
  const skipped = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const fileName = sourceFile.fileName;
    if (!fileName.includes('/src/')) continue;
    if (fileName.endsWith('.spec.ts') || fileName.endsWith('.fixture.ts')) continue;

    ts.forEachChild(sourceFile, (node) => {
      if (!ts.isClassDeclaration(node)) return;
      const controller = decoratorsOf(node).map(decoratorInfo).find((d) => d.name === 'Controller');
      if (!controller) return;
      const prefix = controller.args.length ? stringArgument(controller.args[0]) : '';
      if (prefix === null) {
        skipped.push({
          what: `${node.name?.text ?? '<анонимный класс>'} — префикс контроллера не строковый литерал`,
          where: `${relative(repoDir, fileName).replace(/\\/g, '/')}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
        });
        return;
      }

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const decorators = decoratorsOf(member).map(decoratorInfo);
        const http = decorators.find((d) => HTTP_DECORATORS.has(d.name));
        if (!http) continue;
        const sub = http.args.length ? stringArgument(http.args[0]) : '';
        if (sub === null) {
          skipped.push({
            what: `${node.name?.text ?? '<анонимный класс>'}.${member.name.getText(sourceFile)} — путь маршрута не строковый литерал`,
            where: `${relative(repoDir, fileName).replace(/\\/g, '/')}:${sourceFile.getLineAndCharacterOfPosition(member.getStart()).line + 1}`,
          });
          continue;
        }

        routes.push({
          verb: http.name.toUpperCase(),
          route: toOpenApiPath(prefix, sub),
          file: relative(repoDir, fileName).replace(/\\/g, '/'),
          line: sourceFile.getLineAndCharacterOfPosition(member.getStart()) .line + 1,
          declaration: member,
          decorators,
        });
      }
    });
  }
  return { routes, skipped };
}

// Имена `HttpStatus`, которыми в этом репозитории перекрывают умолчание Nest. Список закрытый
// и короткий намеренно: незнакомое имя не превращается в «наверное 200», а поднимает
// `unverifiable` — сторож обязан уметь сказать «этого я не прочитал».
const HTTP_STATUS_NAMES = new Map([
  ['OK', 200],
  ['CREATED', 201],
  ['ACCEPTED', 202],
  ['NON_AUTHORITATIVE_INFORMATION', 203],
  ['NO_CONTENT', 204],
  ['RESET_CONTENT', 205],
  ['PARTIAL_CONTENT', 206],
]);

// Объявленный успешный код ответа. Nest отвечает 201 на POST и 200 на всём остальном,
// `@HttpCode(...)` это умолчание перекрывает. Код нужен обеим сторонам сверки: по нему берётся
// ветка `responses` в снимке — без этого `POST` под `@HttpCode(202)` сверялся бы с отсутствующим
// `responses['200']` и уезжал в `undocumented` при живом `@ApiResponse({ status: 202, type })`
// (два маршрута `media-jobs` висели так до 14.09.2026) — и по нему же 204 отделяется от «тела
// нет по типу возврата».
function declaredStatus(verb, decorators) {
  const httpCode = decorators.find((d) => d.name === 'HttpCode');
  const arg = httpCode?.args[0];
  if (!httpCode) return { code: verb === 'POST' ? 201 : 200, explicit: false };
  if (arg && ts.isNumericLiteral(arg)) return { code: Number(arg.text), explicit: true };
  if (arg && ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.name)) {
    const code = HTTP_STATUS_NAMES.get(arg.name.text);
    if (code) return { code, explicit: true };
    return { code: null, explicit: true, why: `HttpStatus.${arg.name.text} — имя не в списке` };
  }
  return { code: null, explicit: true, why: 'аргумент не разобран' };
}

// A handler that declares a non-JSON content type answers with a body this check cannot read.
function declaredNonJson(decorators) {
  for (const d of decorators) {
    if (d.name !== 'Header') continue;
    const header = stringArgument(d.args[0]);
    const value = stringArgument(d.args[1]);
    if (header && header.toLowerCase() === 'content-type' && value && !value.includes('json')) return value;
  }
  return null;
}

/* ---------------- actual (TypeScript) side ---------------- */

function unwrapPromise(checker, type) {
  let current = type;
  for (let i = 0; i < 4; i += 1) {
    const symbol = current.getSymbol();
    if (!symbol || symbol.getName() !== 'Promise') return current;
    const args = checker.getTypeArguments(current);
    if (!args.length) return current;
    current = args[0];
  }
  return current;
}

function nonNullableMembers(type) {
  if (!type.isUnion()) return [type];
  return type.types.filter((t) => !(t.getFlags() & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
}

// 🔴 Отбор идёт по тому, что НЕ является данными, а не по списку разрешённых узлов.
// Первая редакция перечисляла разрешённые: PropertyDeclaration, PropertySignature, Parameter,
// GetAccessor. Мимо списка проходила самая частая форма ответа в этом коде — выведенный тип
// объектного литерала (`return { items, total, page, limit }`), где свойства объявлены узлами
// PropertyAssignment. У такого типа «читаемых свойств» получалось ноль, маршрут уезжал
// в исход `no-body`, и гейт молчал ровно там, ради чего заведён: 40 маршрутов из 317,
// включая `GET /books` и `GET /comments`. Список разрешённого — тот же класс дефекта,
// что список исключений: мимо него проходит то, о чём не подумали (L-015).
function dataProperties(checker, type) {
  return checker.getPropertiesOfType(type).filter((symbol) => {
    if (symbol.getName().startsWith('__')) return false;
    const declarations = symbol.getDeclarations() ?? [];
    if (!declarations.length) return true;
    // Метод — не поле ответа: JSON его не несёт.
    return !declarations.every((d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d));
  });
}

// object | array | leaf | unverifiable — what the handler's return type is, in schema terms.
function describeActual(checker, type, location) {
  const flags = type.getFlags();
  if (flags & ts.TypeFlags.Any) return { kind: 'unverifiable', why: 'any' };
  if (flags & ts.TypeFlags.Unknown) return { kind: 'unverifiable', why: 'unknown' };
  if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never | ts.TypeFlags.Null)) {
    return { kind: 'leaf', why: 'void' };
  }

  const members = nonNullableMembers(type);
  if (members.length === 0) return { kind: 'leaf', why: 'void' };
  if (members.length > 1) {
    const allLeaf = members.every((member) => {
      const described = describeActual(checker, member, location);
      return described.kind === 'leaf';
    });
    if (allLeaf) return { kind: 'leaf', why: 'union of primitives' };
    // Члены объединения отдаются наружу: если схема описывает тот же выбор через `oneOf`,
    // сверка идёт по членам (см. `compareVariants`), и объединение перестаёт быть
    // непроверяемым. Вердикт остаётся `unverifiable` для всех остальных случаев —
    // объединение против одной объектной схемы читать нечем.
    return { kind: 'unverifiable', why: 'union of object types', members };
  }
  const single = members[0];

  if (single.getFlags() & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.EnumLike)) {
    return { kind: 'leaf', why: 'primitive' };
  }
  if (checker.isArrayType(single) || checker.isTupleType(single)) {
    const element = checker.getTypeArguments(single)[0];
    if (!element) return { kind: 'unverifiable', why: 'array of unknown element' };
    return { kind: 'array', element };
  }
  const symbolName = single.getSymbol()?.getName();
  if (symbolName && LEAF_TYPE_NAMES.has(symbolName)) return { kind: 'leaf', why: symbolName };
  if (single.getCallSignatures().length || single.getConstructSignatures().length) {
    return { kind: 'leaf', why: 'callable' };
  }

  const properties = dataProperties(checker, single);
  // Объект без единого читаемого свойства — это НЕ «тела нет»: это «я не смогла прочитать».
  // Разница видна в отчёте: `no-body` печатается числом, `unverifiable` — поимённым списком.
  if (!properties.length) return { kind: 'unverifiable', why: 'object without readable properties' };
  return { kind: 'object', type: single, properties };
}

/* ---------------- documented (OpenAPI) side ---------------- */

function resolveSchema(snapshot, schema, seenRefs = new Set()) {
  if (!schema) return null;
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    if (seenRefs.has(name)) return { kind: 'cycle', name };
    const next = new Set(seenRefs);
    next.add(name);
    const target = snapshot.components?.schemas?.[name];
    if (!target) return null;
    const resolved = resolveSchema(snapshot, target, next);
    return resolved ? { ...resolved, name } : null;
  }
  if (schema.allOf) {
    const parts = schema.allOf.map((part) => resolveSchema(snapshot, part, seenRefs)).filter(Boolean);
    const properties = {};
    for (const part of parts) Object.assign(properties, part.properties ?? {});
    return { kind: 'object', properties, free: parts.some((p) => p.free) };
  }
  // Варианты отдаются наружу, а не схлопываются в «непроверяемо»: `oneOf` — это описанный
  // выбор форм, и сверять его есть с чем, если тот же выбор есть и в типе возврата.
  if (schema.oneOf || schema.anyOf) return { kind: 'variant', variants: schema.oneOf ?? schema.anyOf };
  if (schema.type === 'array') {
    return { kind: 'array', items: schema.items ?? null };
  }
  if (schema.properties) {
    return { kind: 'object', properties: schema.properties, free: schema.additionalProperties === true };
  }
  if (schema.type === 'object') {
    // 🔴 `type: object` без `properties` — это «схема ничего не говорит о полях», а не
    // «схема описывает всё». Первая редакция считала такой узел свободным (`free`), и сравнение
    // молча проходило мимо КАЖДОГО поля под ним, отдавая маршруту вердикт `ok`. Swagger рисует
    // ровно такой узел для `@ApiProperty({ nullable: true })` без `type` — в текущем снимке
    // таких узлов сотни, и под ними пряталось шесть маршрутов с настоящей недостачей, включая
    // почту пользователя в `reviews[].approvedByUser`. Свободным узел делает только явное
    // `additionalProperties: true`.
    return { kind: 'opaque' };
  }
  return { kind: 'leaf' };
}

function responseSchemaOf(snapshot, verb, route, status) {
  const pathItem = snapshot.paths?.[route];
  if (!pathItem) return { inSnapshot: false };
  const operation = pathItem[verb.toLowerCase()];
  if (!operation) return { inSnapshot: false };
  // Код объявлен явно — ищем ровно его ветку. Умолчание Nest неизвестно точно (200 или 201),
  // поэтому при отсутствии `@HttpCode` берётся тот из двух, у кого схема есть:
  // `['200'] ?? ['201']` прятал бы схему из `@ApiCreatedResponse` за описательным
  // `@ApiResponse({ status: 200 })` без тела.
  const codes = status.explicit ? [String(status.code)] : ['200', '201'];
  const candidates = codes.map((code) => operation.responses?.[code]).filter(Boolean);
  const withSchema = candidates.find((r) => r?.content?.['application/json']?.schema);
  // Маршрут в снимке есть, но успешного ответа с телом у него не описано (обычное дело
  // для 204 и 202) — это «схемы нет», а не «снимок не знает маршрута». Путать нельзя:
  // второе означает устаревший снимок и разбирается иначе.
  if (!candidates.length || !withSchema) return { inSnapshot: true, schema: null };
  return { inSnapshot: true, schema: withSchema.content['application/json'].schema };
}

/* ---------------- comparison ---------------- */

// Сверка выбора форм с выбором форм.
//
// Правило одно и строгое: член объединения считается покрытым, только если ХОТЯ БЫ ОДИН вариант
// схемы описывает его **без единой недостачи**. Вариант, который «описывает всё» (`type: object`
// без `properties` или `additionalProperties: true`), покрывающим не считается — иначе один
// свободный вариант в `oneOf` закрывал бы собой любую форму и делал бы сверку декорацией.
// Не покрытый ни одним вариантом член — это `poor` с именем члена и недостачами того варианта,
// который подошёл ближе всех: иначе отчёт назвал бы проблему, но не место.
function compareVariants(context, { actual, actualType }, documented, path, depth, seen) {
  const { checker } = context;
  const gaps = [];
  const unverified = [];

  const members = actual.members ?? [actualType];
  const variants = documented.variants;

  for (const member of members) {
    const name = members.length > 1 ? checker.typeToString(member) : null;
    const memberPath = name ? `${path}<${name}>` : path;
    let covered = null;
    let closest = null;

    for (const variant of variants) {
      const resolved = resolveSchema(context.snapshot, variant);
      // Свободный вариант не покрывает: он ничего не утверждает о полях.
      if (!resolved || resolved.kind === 'opaque' || resolved.free) continue;
      const attempt = compareShape(context, member, variant, memberPath, depth + 1, new Set(seen));
      if (!attempt.gaps.length) {
        covered = attempt;
        break;
      }
      if (!closest || attempt.gaps.length < closest.gaps.length) closest = attempt;
    }

    if (covered) {
      // Непроверенное внутри подошедшего варианта не теряется — оно и есть честный остаток.
      unverified.push(...covered.unverified);
      continue;
    }
    if (closest) {
      gaps.push(...closest.gaps);
      unverified.push(...closest.unverified);
      continue;
    }
    // Ни один вариант не читается: покрыт ли член — неизвестно, и это не «покрыт».
    unverified.push({ path: memberPath, why: 'no readable variant in schema oneOf/anyOf' });
  }

  return { gaps, unverified };
}

// Walks the handler's type and the documented schema together. Collects every field the code
// returns and the schema does not describe, at any depth.
export function compareShape(context, actualType, schema, path, depth, seen) {
  const { checker, snapshot, location } = context;
  const gaps = [];
  const unverified = [];

  if (depth > MAX_DEPTH) {
    unverified.push({ path, why: `depth limit ${MAX_DEPTH}` });
    return { gaps, unverified };
  }

  const actual = describeActual(checker, actualType, location);
  if (actual.kind === 'leaf') return { gaps, unverified };

  const documented = resolveSchema(snapshot, schema);
  if (!documented) {
    unverified.push({ path, why: 'schema not resolvable' });
    return { gaps, unverified };
  }

  // Выбор форм сверяется с выбором форм — и только с ним. Сюда попадают два случая:
  // объединение типов против `oneOf` и один тип против `oneOf` (так описан элемент массива
  // у `GET /books/{id}/versions`). Разбор — в `compareVariants`.
  //
  // 🔴 Объединение против ОДНОЙ объектной схемы сюда не входит, и это не упрощение.
  // Самый частый такой случай — колонка Prisma `Json`: её тип `JsonValue` объединяет объект,
  // массив, строку, число и `null`, тогда как схема описывает одну конкретную форму. Тип шире
  // схемы по устройству, а не по недосмотру, и сверка по членам объявила бы `poor` у 49
  // маршрутов, где недостачи нет. Такое остаётся в `unverified` и держится храповиком.
  if (documented.kind === 'variant') {
    return compareVariants(context, { actual, actualType }, documented, path, depth, seen);
  }

  if (actual.kind === 'unverifiable') {
    unverified.push({ path, why: actual.why });
    return { gaps, unverified };
  }
  if (documented.kind === 'cycle' || documented.kind === 'opaque') {
    const why = {
      cycle: 'schema is recursive',
      opaque: 'schema says `type: object` without properties',
    }[documented.kind];
    unverified.push({ path, why });
    return { gaps, unverified };
  }

  if (actual.kind === 'array') {
    if (documented.kind !== 'array') {
      gaps.push({ path, kind: 'shape', detail: 'code returns an array, schema describes a single object' });
      return { gaps, unverified };
    }
    if (!documented.items) {
      unverified.push({ path: `${path}[]`, why: 'array schema without items' });
      return { gaps, unverified };
    }
    return compareShape(context, actual.element, documented.items, `${path}[]`, depth + 1, seen);
  }

  // actual.kind === 'object'
  if (documented.kind === 'array') {
    gaps.push({ path, kind: 'shape', detail: 'code returns a single object, schema describes an array' });
    return { gaps, unverified };
  }
  if (documented.kind === 'leaf') {
    gaps.push({ path, kind: 'shape', detail: 'code returns an object, schema describes a primitive' });
    return { gaps, unverified };
  }

  const key = `${checker.typeToString(actual.type)}|${documented.name ?? path}`;
  if (seen.has(key)) return { gaps, unverified };
  seen.add(key);

  const documentedProps = documented.properties ?? {};
  for (const property of actual.properties) {
    const name = property.getName();
    if (!Object.prototype.hasOwnProperty.call(documentedProps, name)) {
      if (documented.free) continue; // additionalProperties: true documents the rest by rule
      gaps.push({ path: path ? `${path}.${name}` : name, kind: 'missing-field' });
      continue;
    }
    const declaration = property.valueDeclaration ?? property.getDeclarations()?.[0] ?? location;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const nested = compareShape(
      context,
      propertyType,
      documentedProps[name],
      path ? `${path}.${name}` : name,
      depth + 1,
      seen,
    );
    gaps.push(...nested.gaps);
    unverified.push(...nested.unverified);
  }

  return { gaps, unverified };
}

/* ---------------- analysis ---------------- */

export function analyse(repoDir, { snapshotPath, tsconfigName, skipVerbCheck } = {}) {
  if (!skipVerbCheck) assertVerbsMatchSharedList(repoDir);
  const program = createProgram(repoDir, tsconfigName);

  // 🔴 Программа, которая не разрешила типы, даёт `any` — а `any` этот сторож помечает
  // «не проверено» и красным не отвечает. То есть сломанный `prisma generate` или сбитый
  // `tsconfig` превращали бы гейт в зелёный на пустом месте. Диагностика читается ДО разбора:
  // не собралось — красное, а не «маршрутов 317, все хороши».
  const diagnostics = program
    .getSemanticDiagnostics()
    .filter((d) => d.file && !d.file.fileName.includes('node_modules'));
  if (diagnostics.length) {
    const shown = diagnostics.slice(0, 5).map((d) => {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      const where = `${relative(repoDir, d.file.fileName).replace(/\\/g, '/')}:${line + 1}`;
      return `  ${where} — ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
    const tail = diagnostics.length > 5 ? `\n  ... и ещё ${diagnostics.length - 5}` : '';
    throw new Error(
      `TypeScript не разрешил типы (${diagnostics.length} ошибок), читать типы возврата нечем:\n` +
        shown.join('\n') +
        tail,
    );
  }

  const checker = program.getTypeChecker();
  const snapshot = JSON.parse(
    readFileSync(snapshotPath ?? join(repoDir, 'libs/api-client/api-schema.json'), 'utf8'),
  );

  const { routes, skipped } = collectRoutes(program, repoDir);
  const results = [];
  results.skipped = skipped;
  for (const route of routes) {
    const base = {
      verb: route.verb,
      route: route.route,
      file: route.file,
      line: route.line,
    };

    const nonJson = declaredNonJson(route.decorators);
    if (nonJson) {
      results.push({ ...base, verdict: 'unverifiable', why: `non-JSON response (${nonJson})` });
      continue;
    }

    const status = declaredStatus(route.verb, route.decorators);
    if (status.code === null) {
      results.push({ ...base, verdict: 'unverifiable', why: `@HttpCode: ${status.why}` });
      continue;
    }
    const found = responseSchemaOf(snapshot, route.verb, route.route, status);
    // Снимок спрашивается ДО разбора кода ответа, в том числе у 204. Иначе маршрут под 204,
    // которого в снимке больше нет (путь переименован, контроллер переехал, снимок устарел),
    // молча уходил бы в `no-body` и пропадал из списка «НЕТ В СНИМКЕ» — единственного сигнала
    // расхождения кода со снимком для этих путей.
    if (!found.inSnapshot) {
      results.push({ ...base, verdict: 'not-in-snapshot' });
      continue;
    }

    // 🔴 204 тела не несёт физически, а не по соглашению: Express обнуляет его вместе
    // с `Content-Type` и `Content-Length` (`node_modules/express/lib/response.js:199-204`),
    // поэтому объект, который сервис вернул обработчику, до клиента не доходит. Сверять
    // схему ответа тут не с чем, и «схемы нет» здесь означает «тела нет», а не недостачу.
    // Так снята премисса `LEGACY-373` («объявлены 204, но отдают тело»): на проводе тела нет
    // у одиннадцати маршрутов из четырнадцати, а три оставшихся отвечают 200, потому что
    // `@HttpCode` у них нет вовсе — их тело и правда уезжает и теперь требует схемы.
    if (status.code === 204) {
      results.push({ ...base, verdict: 'no-body', why: '204 (@HttpCode)' });
      continue;
    }

    const signature = checker.getSignatureFromDeclaration(route.declaration);
    if (!signature) {
      results.push({ ...base, verdict: 'unverifiable', why: 'no call signature' });
      continue;
    }
    const returnType = unwrapPromise(checker, checker.getReturnTypeOfSignature(signature));
    const actual = describeActual(checker, returnType, route.declaration);

    // Объединение на верхнем уровне непроверяемо не всегда: если схема маршрута описывает
    // тот же выбор через `oneOf`, сверять есть с чем — `compareShape` уводит такой случай
    // в `compareVariants`. Отбивать его здесь значило бы объявить непроверяемыми две ручки,
    // чей union описан осознанно и подписан в схеме (`PATCH /comments/{id}`,
    // `GET /admin/rights/intakes/{id}/rights-profile`).
    const schemaIsVariant = Boolean(found.schema?.oneOf || found.schema?.anyOf);
    if (actual.kind === 'unverifiable' && !(actual.members && schemaIsVariant)) {
      results.push({ ...base, verdict: 'unverifiable', why: `return type is ${actual.why}` });
      continue;
    }
    if (actual.kind === 'leaf') {
      results.push({ ...base, verdict: 'no-body', why: actual.why });
      continue;
    }
    if (!found.schema) {
      results.push({ ...base, verdict: 'undocumented' });
      continue;
    }

    const { gaps, unverified } = compareShape(
      { checker, snapshot, location: route.declaration },
      returnType,
      found.schema,
      '',
      0,
      new Set(),
    );
    results.push({
      ...base,
      verdict: gaps.length ? 'poor' : 'ok',
      gaps,
      unverified,
    });
  }

  return results;
}

/* ---------------- reporting ---------------- */

function summarise(results) {
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  return counts;
}

/* ---------------- ratchet ---------------- */

// Причина сводится к КЛАССУ, а не берётся дословно: `depth limit 6` несёт в себе число, и снимок
// с ним ломался бы от правки константы, а не от новой непроверенной ветки.
function unverifiedClass(why) {
  if (why.startsWith('depth limit')) return 'depth limit';
  return why;
}

function unverifiedCounts(partly) {
  const byReason = {};
  for (const route of partly) {
    for (const item of route.unverified) {
      const key = unverifiedClass(item.why);
      byReason[key] = (byReason[key] ?? 0) + 1;
    }
  }
  return {
    routes: partly.length,
    byReason: Object.fromEntries(Object.entries(byReason).sort(([a], [b]) => a.localeCompare(b))),
  };
}

// 🔴 Храповик, а не baseline. В снимок идут ЧИСЛА по классам, не список маршрутов: список
// разрешал бы конкретные места навсегда, и это ровно тот baseline, что запрещён пачкой `C19`.
// Расхождение красное в ОБЕ стороны. Рост — новое непроверенное место. Снижение без пересъёмки —
// снимок перестал описывать действительность, и следующий рост будет мерить от неверного нуля.
function ratchetHolds(partly, ratchetPath = RATCHET_PATH) {
  const actual = unverifiedCounts(partly);

  // `--update` под CI игнорируется намеренно: иначе красный конвейер уговаривал бы сам себя,
  // переписывая ожидание под то, что получилось.
  if (UPDATE_RATCHET && process.env.CI !== 'true') {
    writeFileSync(ratchetPath, JSON.stringify(actual, null, 2) + '\n');
    console.log(`\n[response-schema] снимок частично проверенного пересобран: ${RATCHET_FILE}`);
    return true;
  }

  let expected;
  try {
    expected = JSON.parse(readFileSync(ratchetPath, 'utf8'));
  } catch {
    console.log(
      `\n[response-schema] 🔴 снимка частично проверенного нет (${RATCHET_FILE}).\n` +
        'Без него счёт непроверенного не с чем сравнить. Собери: yarn check:response-schema:snapshot',
    );
    return false;
  }

  const keys = [...new Set([...Object.keys(expected.byReason ?? {}), ...Object.keys(actual.byReason)])];
  const moved = [];
  if (expected.routes !== actual.routes) {
    moved.push(`маршрутов с непроверенным: было ${expected.routes}, стало ${actual.routes}`);
  }
  for (const key of keys.sort()) {
    const was = expected.byReason?.[key] ?? 0;
    const now = actual.byReason[key] ?? 0;
    if (was !== now) moved.push(`${key}: было ${was}, стало ${now}`);
  }

  if (!moved.length) return true;

  console.log(`\n[response-schema] 🔴 счёт частично проверенного сдвинулся (${RATCHET_FILE}):`);
  for (const line of moved) console.log(`  ${line}`);
  console.log(
    '\nРост — новое место, которое сторож прочитать не смог: сузь тип возврата или опиши схему.\n' +
      'Снижение — тоже красное: непроверенного стало меньше, а снимок остался прежним,\n' +
      'и следующий рост мерился бы от неверного нуля. Пересними: yarn check:response-schema:snapshot',
  );
  return false;
}

function report(results, ratchetPath = RATCHET_PATH) {
  const poor = results.filter((r) => r.verdict === 'poor');
  const unverifiable = results.filter((r) => r.verdict === 'unverifiable');
  const notInSnapshot = results.filter((r) => r.verdict === 'not-in-snapshot');
  const partly = results.filter((r) => r.verdict === 'ok' && r.unverified?.length);
  const skipped = results.skipped ?? [];

  const counts = summarise(results);
  console.log(
    `[response-schema] маршрутов ${results.length}: ` +
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(', '),
  );

  if (unverifiable.length) {
    console.log(`\n[response-schema] НЕ ПРОВЕРЕНО (${unverifiable.length}) — тип ответа прочитать нечем:`);
    for (const r of unverifiable) console.log(`  ${r.verb} ${r.route} — ${r.why} (${r.file}:${r.line})`);
  }
  if (skipped.length) {
    console.log(`\n[response-schema] НЕ РАЗОБРАНО (${skipped.length}) — адрес не строковый литерал:`);
    for (const item of skipped) console.log(`  ${item.what} (${item.where})`);
  }
  if (notInSnapshot.length) {
    console.log(
      `\n[response-schema] НЕТ В СНИМКЕ (${notInSnapshot.length}) — маршрут объявлен кодом, ` +
        'но в снимке OpenAPI его нет; снимок устарел либо путь собран иначе:',
    );
    for (const r of notInSnapshot) console.log(`  ${r.verb} ${r.route} (${r.file}:${r.line})`);
  }
  if (partly.length) {
    console.log(`\n[response-schema] проверено частично (${partly.length}):`);
    for (const r of partly) {
      const where = r.unverified.map((u) => `${u.path || '<корень>'}: ${u.why}`).join('; ');
      console.log(`  ${r.verb} ${r.route} — ${where}`);
    }
  }

  // Порог на объём разбора: ниже него сломан обход, а не поредел репозиторий.
  if (results.length < MIN_ROUTES) {
    console.log(
      `\n[response-schema] 🔴 разобрано маршрутов ${results.length}, ожидалось не меньше ${MIN_ROUTES}.\n` +
        'Проверка молчит не потому, что всё хорошо, а потому что ей нечего было смотреть.',
    );
    return false;
  }

  let red = false;

  // 🔴 «Не разобрано» и «нет в снимке» краснеют наравне с «не проверено»: это те же вёдра
  // «я не смотрела», только причина в обходе, а не в типе. Контроллер под вычисляемым префиксом
  // уезжает в `skipped` целиком — до трёх десятков маршрутов разом, — и при зелёном итоге
  // обработчик, отдающий строку Prisma спредом, прошёл бы гейт. Порог `MIN_ROUTES` этого
  // не ловит: он срабатывает, только если пропала треть маршрутов.
  if (skipped.length) {
    console.log(
      `\n[response-schema] 🔴 не разобрано маршрутов ${skipped.length} (список выше).\n` +
        'Адрес контроллера или маршрута собран не строковым литералом, и сверить его не с чем.\n' +
        'Приведи путь к литералу — иначе маршрут не виден проверке вовсе.',
    );
    red = true;
  }

  if (notInSnapshot.length) {
    console.log(
      `\n[response-schema] 🔴 нет в снимке OpenAPI: ${notInSnapshot.length} (список выше).\n` +
        'Либо снимок устарел — пересобери `yarn openapi:snapshot`, — либо путь в снимке собран\n' +
        'иначе, чем его строит Nest. В обоих случаях маршрут не сверяется ни с чем.',
    );
    red = true;
  }

  // 🔴 Вердикт «я не смотрел» краснеет наравне с «схема беднее». До 14.09.2026 оба печатались
  // и оба игнорировались кодом возврата: 123 маршрута из 314 уходили непроверенными под
  // зелёным итогом. Тип возврата, который сторож прочитать не может, — это не свойство
  // сторожа, а работа, которую никто не сделал.
  if (unverifiable.length) {
    console.log(
      `\n[response-schema] 🔴 непроверяемых маршрутов ${unverifiable.length} (список выше).\n` +
        'Сузь тип возврата обработчика: назови форму DTO или Prisma-типом вместо `any`,\n' +
        '`unknown`, словаря и объединения. Объединение, описанное в схеме через `oneOf`,\n' +
        'сверяется по членам и непроверяемым не считается.',
    );
    red = true;
  }

  const undocumented = results.filter((r) => r.verdict === 'undocumented');
  if (undocumented.length) {
    console.log(
      `\n[response-schema] 🔴 тело есть, схемы ответа нет (${undocumented.length}):`,
    );
    for (const r of undocumented) console.log(`  ${r.verb} ${r.route} (${r.file}:${r.line})`);
    console.log(
      '\nОбработчик отвечает телом, которого не описывает ни одна схема. Повесь\n' +
        '@ApiResponse({ type }) с верным DTO — или, если тела быть не должно, объяви\n' +
        '@HttpCode(HttpStatus.NO_CONTENT): на 204 тело срезает транспорт.',
    );
    red = true;
  }

  if (!ratchetHolds(partly, ratchetPath)) red = true;

  if (!poor.length) {
    if (!red) console.log('\n[response-schema] ни одна схема ответа не беднее того, что отдаёт код.');
    return !red;
  }

  console.log(`\n[response-schema] 🔴 схема беднее ответа (${poor.length}):`);
  for (const r of poor) {
    console.log(`  ${r.verb} ${r.route} (${r.file}:${r.line})`);
    for (const gap of r.gaps) {
      if (gap.kind === 'shape') console.log(`      форма: ${gap.detail}`);
      else console.log(`      нет в схеме: ${gap.path}`);
    }
  }
  console.log(
    '\nКод отдаёт поля, которых нет в схеме ответа. Фронт пишет types/api-schema/** руками и сверяет\n' +
      'их с этой схемой: недоописанное поле толкает его выкинуть верный тип. Допиши @ApiProperty\n' +
      'в DTO (или @ApiResponse({ type }) с верным DTO) и пересобери снимок: yarn openapi:snapshot.',
  );
  return false;
}

/* ---------------- self-test ---------------- */

const FIXTURE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    strictNullChecks: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ['src/**/*'],
};

const FIXTURE_DECORATORS = `
export function Controller(prefix?: string): ClassDecorator { return () => undefined; }
export function Get(path?: string): MethodDecorator { return () => undefined; }
export function Post(path?: string): MethodDecorator { return () => undefined; }
export function Delete(path?: string): MethodDecorator { return () => undefined; }
export function Header(name: string, value: string): MethodDecorator { return () => undefined; }
export function HttpCode(code: number): MethodDecorator { return () => undefined; }
export const HttpStatus = { OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204 } as const;
`;

function writeFixture(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

function fixtureSnapshot(paths) {
  return { openapi: '3.0.0', info: { title: 't', version: '1' }, paths, components: { schemas: {} } };
}

function objectSchema(properties) {
  return {
    content: { 'application/json': { schema: { type: 'object', properties } } },
  };
}

function selfTest() {
  const cases = [];
  const root = mkdtempSync(join(tmpdir(), 'response-schema-selftest-'));
  const record = (name, passed, detail) => {
    cases.push({ name, passed, detail });
    console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}${passed || !detail ? '' : ` — ${detail}`}`);
  };

  const run = (name, files, snapshot, expect) => {
    const dir = join(root, name.replace(/[^a-z0-9]+/gi, '-'));
    mkdirSync(dir, { recursive: true });
    writeFixture(dir, {
      'tsconfig.json': JSON.stringify(FIXTURE_TSCONFIG, null, 1),
      'src/nest.ts': FIXTURE_DECORATORS,
      // Тот же источник списка глаголов, что в репозитории: иначе сверка копии
      // не выполнялась бы ни в одном случае самопроверки.
      [VERBS_SOURCE]: `export const VERBS = [${HTTP_VERBS.map((v) => `'${v}'`).join(', ')}] as const;
`,
      ...files,
    });
    const snapshotPath = join(dir, 'schema.json');
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 1));
    let results;
    try {
      results = analyse(dir, { snapshotPath });
    } catch (error) {
      record(name, false, `analyse threw: ${error.message}`);
      return;
    }
    const route = results.find((r) => r.route === expect.route && r.verb === expect.verb);
    if (!route) {
      record(name, false, `route ${expect.verb} ${expect.route} not found; got ${results.map((r) => r.verb + ' ' + r.route).join(', ')}`);
      return;
    }
    if (route.verdict !== expect.verdict) {
      record(name, false, `verdict ${route.verdict}, expected ${expect.verdict}`);
      return;
    }
    if (expect.gap) {
      const paths = (route.gaps ?? []).map((g) => (g.kind === 'shape' ? g.detail : g.path));
      if (!paths.includes(expect.gap)) {
        record(name, false, `gap ${expect.gap} not named; got ${paths.join(', ') || '<none>'}`);
        return;
      }
    }
    if (expect.why && !(route.why ?? '').includes(expect.why)) {
      record(name, false, `why "${route.why}" does not mention "${expect.why}"`);
      return;
    }
    record(name, true);
  };

  const controller = (body) =>
    `import { Controller, Get, Post, Delete, Header, HttpCode, HttpStatus } from './nest';\n${body}\n`;

  run(
    'complete schema is green',
    {
      'src/x.controller.ts': controller(`
type Item = { id: string; title: string };
@Controller('items')
export class ItemsController {
  @Get(':id') one(): Promise<Item> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/items/{id}': { get: { responses: { 200: objectSchema({ id: {}, title: {} }) } } } }),
    { verb: 'GET', route: '/items/{id}', verdict: 'ok' },
  );

  run(
    'missing top-level field is red',
    {
      'src/x.controller.ts': controller(`
type Item = { id: string; title: string; secretCount: number };
@Controller('items')
export class ItemsController {
  @Get(':id') one(): Promise<Item> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/items/{id}': { get: { responses: { 200: objectSchema({ id: {}, title: {} }) } } } }),
    { verb: 'GET', route: '/items/{id}', verdict: 'poor', gap: 'secretCount' },
  );

  run(
    'missing nested field is red',
    {
      'src/x.controller.ts': controller(`
type Author = { id: string; email: string };
type Item = { id: string; author: Author };
@Controller('items')
export class ItemsController {
  @Get(':id') one(): Promise<Item> { return null as any; }
}`),
    },
    fixtureSnapshot({
      '/items/{id}': {
        get: { responses: { 200: objectSchema({ id: {}, author: { type: 'object', properties: { id: {} } } }) } },
      },
    }),
    { verb: 'GET', route: '/items/{id}', verdict: 'poor', gap: 'author.email' },
  );

  run(
    'missing field inside an array element is red',
    {
      'src/x.controller.ts': controller(`
type Item = { id: string; slug: string };
@Controller('items')
export class ItemsController {
  @Get() all(): Promise<Item[]> { return null as any; }
}`),
    },
    fixtureSnapshot({
      '/items': {
        get: { responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { id: {} } } } } } } } },
      },
    }),
    { verb: 'GET', route: '/items', verdict: 'poor', gap: '[].slug' },
  );

  run(
    'array documented as object is red',
    {
      'src/x.controller.ts': controller(`
type Item = { id: string };
@Controller('items')
export class ItemsController {
  @Get() all(): Promise<Item[]> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/items': { get: { responses: { 200: objectSchema({ id: {} }) } } } }),
    { verb: 'GET', route: '/items', verdict: 'poor', gap: 'code returns an array, schema describes a single object' },
  );

  run(
    'any return type is reported, not passed',
    {
      'src/x.controller.ts': controller(`
@Controller('items')
export class ItemsController {
  @Get(':id') one(): Promise<any> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/items/{id}': { get: { responses: { 200: objectSchema({ id: {} }) } } } }),
    { verb: 'GET', route: '/items/{id}', verdict: 'unverifiable', why: 'any' },
  );

  run(
    'route without a response schema is undocumented, not ok',
    {
      'src/x.controller.ts': controller(`
type Item = { id: string };
@Controller('items')
export class ItemsController {
  @Get(':id') one(): Promise<Item> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/items/{id}': { get: { responses: { 200: { description: 'ok' } } } } }),
    { verb: 'GET', route: '/items/{id}', verdict: 'undocumented' },
  );

  run(
    'Date is a leaf, not an object with methods',
    {
      'src/x.controller.ts': controller(`
type Item = { id: string; createdAt: Date };
@Controller('items')
export class ItemsController {
  @Get(':id') one(): Promise<Item> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/items/{id}': { get: { responses: { 200: objectSchema({ id: {}, createdAt: {} }) } } } }),
    { verb: 'GET', route: '/items/{id}', verdict: 'ok' },
  );

  run(
    'non-JSON response is reported as unverifiable',
    {
      'src/x.controller.ts': controller(`
@Controller('sitemap')
export class SitemapController {
  @Get(':lang.xml') @Header('Content-Type', 'application/xml') one(): Promise<string> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/sitemap/{lang}.xml': { get: { responses: { 200: { description: '' } } } } }),
    { verb: 'GET', route: '/sitemap/{lang}.xml', verdict: 'unverifiable', why: 'non-JSON' },
  );

  run(
    'additionalProperties: true documents the rest by rule',
    {
      'src/x.controller.ts': controller(`
type Item = { id: string; extra: string };
@Controller('items')
export class ItemsController {
  @Get(':id') one(): Promise<Item> { return null as any; }
}`),
    },
    fixtureSnapshot({
      '/items/{id}': {
        get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { id: {} }, additionalProperties: true } } } } } },
      },
    }),
    { verb: 'GET', route: '/items/{id}', verdict: 'ok' },
  );

  // 🔴 Случаи ниже написаны в той форме, в какой написано подавляющее большинство настоящих
  // ручек: контроллер без аннотации возвращает вызов сервиса, а тип выводится из объектного
  // литерала. Первая редакция самопроверки этой формы не имела вовсе — все её случаи объявляли
  // тип руками, — и поэтому была зелёной на сторожe, слепом к 40 маршрутам из 317 (L-017:
  // контрольный вход обязан быть той же формы, что рабочий).
  run(
    'inferred object literal: missing field is red',
    {
      'src/x.service.ts': `
export class ItemsService {
  list() {
    return { items: [{ id: 'a', slug: 's' }], total: 1, page: 1 };
  }
}`,
      'src/x.controller.ts': controller(`
import { ItemsService } from './x.service';
@Controller('items')
export class ItemsController {
  constructor(private readonly service: ItemsService) {}
  @Get() all() { return this.service.list(); }
}`),
    },
    fixtureSnapshot({
      '/items': {
        get: {
          responses: {
            200: objectSchema({
              items: { type: 'array', items: { type: 'object', properties: { id: {} } } },
              total: {},
              page: {},
            }),
          },
        },
      },
    }),
    { verb: 'GET', route: '/items', verdict: 'poor', gap: 'items[].slug' },
  );

  run(
    'inferred object literal: complete schema is green',
    {
      'src/x.service.ts': `
export class ItemsService {
  list() {
    return { items: [{ id: 'a', slug: 's' }], total: 1, page: 1 };
  }
}`,
      'src/x.controller.ts': controller(`
import { ItemsService } from './x.service';
@Controller('items')
export class ItemsController {
  constructor(private readonly service: ItemsService) {}
  @Get() all() { return this.service.list(); }
}`),
    },
    fixtureSnapshot({
      '/items': {
        get: {
          responses: {
            200: objectSchema({
              items: { type: 'array', items: { type: 'object', properties: { id: {}, slug: {} } } },
              total: {},
              page: {},
            }),
          },
        },
      },
    }),
    { verb: 'GET', route: '/items', verdict: 'ok' },
  );

  run(
    'object whose properties cannot be read is unverifiable, not no-body',
    {
      'src/x.controller.ts': controller(`
type Opaque = Record<string, never>;
@Controller('items')
export class ItemsController {
  @Get(':id') one(): Promise<Opaque> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/items/{id}': { get: { responses: { 200: objectSchema({ id: {} }) } } } }),
    { verb: 'GET', route: '/items/{id}', verdict: 'unverifiable', why: 'readable' },
  );

  run(
    '$ref is followed to components.schemas',
    {
      'src/x.controller.ts': controller(`
type Item = { id: string; title: string };
@Controller('items')
export class ItemsController {
  @Get(':id') one(): Promise<Item> { return null as any; }
}`),
    },
    {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: { '/items/{id}': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ItemDto' } } } } } } } },
      components: { schemas: { ItemDto: { type: 'object', properties: { id: {} } } } },
    },
    { verb: 'GET', route: '/items/{id}', verdict: 'poor', gap: 'title' },
  );

  // Три случая ниже проверяют не сравнение схем, а собственные слепые зоны сторожа:
  // разошедшийся список глаголов, обвалившийся обход и нечитаемую программу. Каждая из них —
  // это «зелено, потому что смотреть было не на что», то есть отказ, который тише всего.
  {
    const dir = join(root, 'verbs-diverged');
    mkdirSync(dir, { recursive: true });
    writeFixture(dir, {
      'tsconfig.json': JSON.stringify(FIXTURE_TSCONFIG, null, 1),
      'src/nest.ts': FIXTURE_DECORATORS,
      [VERBS_SOURCE]: "export const VERBS = ['get', 'post'] as const;\n",
      'src/x.controller.ts': `import { Controller, Get } from './nest';\n@Controller('items')\nexport class C { @Get() all(): Promise<{ id: string }> { return null as any; } }\n`,
    });
    const snapshotPath = join(dir, 'schema.json');
    writeFileSync(snapshotPath, JSON.stringify(fixtureSnapshot({}), null, 1));
    let message = '';
    try {
      analyse(dir, { snapshotPath });
    } catch (error) {
      message = error.message;
    }
    record('verb list diverging from the shared one is red', message.includes('разошёлся'), message || 'не бросил вовсе');
  }

  {
    const dir = join(root, 'unresolved-types');
    mkdirSync(dir, { recursive: true });
    writeFixture(dir, {
      'tsconfig.json': JSON.stringify(FIXTURE_TSCONFIG, null, 1),
      'src/nest.ts': FIXTURE_DECORATORS,
      [VERBS_SOURCE]: `export const VERBS = [${HTTP_VERBS.map((v) => `'${v}'`).join(', ')}] as const;\n`,
      'src/x.controller.ts':
        `import { Controller, Get } from './nest';\nimport type { Gone } from './does-not-exist';\n` +
        `@Controller('items')\nexport class C { @Get() all(): Promise<Gone> { return null as any; } }\n`,
    });
    const snapshotPath = join(dir, 'schema.json');
    writeFileSync(snapshotPath, JSON.stringify(fixtureSnapshot({}), null, 1));
    let message = '';
    try {
      analyse(dir, { snapshotPath });
    } catch (error) {
      message = error.message;
    }
    record(
      'program that did not resolve its types is red, not "unverifiable"',
      message.includes('не разрешил типы'),
      message || 'не бросил вовсе',
    );
  }

  // --- 204 и 202: объявленный код решает, есть ли тело вообще ---

  run(
    '204 by @HttpCode is no-body even when the service returns a row',
    {
      'src/x.controller.ts': controller(`
@Controller('items')
export class C {
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(): Promise<{ id: string; title: string }> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/items/{id}': { delete: { responses: { 204: { description: '' } } } } }),
    { verb: 'DELETE', route: '/items/{id}', verdict: 'no-body', why: '204' },
  );

  run(
    'the same handler without @HttpCode answers 200 and is undocumented',
    {
      'src/x.controller.ts': controller(`
@Controller('items')
export class C {
  @Delete(':id')
  remove(): Promise<{ id: string; title: string }> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/items/{id}': { delete: { responses: { 200: { description: '' } } } } }),
    { verb: 'DELETE', route: '/items/{id}', verdict: 'undocumented' },
  );

  run(
    'schema is looked up under the declared status, not only 200/201',
    {
      'src/x.controller.ts': controller(`
@Controller('items')
export class C {
  @Post('probe')
  @HttpCode(HttpStatus.ACCEPTED)
  probe(): Promise<{ enqueued: number }> { return null as any; }
}`),
    },
    fixtureSnapshot({ '/items/probe': { post: { responses: { 202: objectSchema({ enqueued: {} }) } } } }),
    { verb: 'POST', route: '/items/probe', verdict: 'ok' },
  );

  // --- объединение против oneOf ---

  const variantSnapshot = (variants) =>
    fixtureSnapshot({
      '/items/{id}': {
        get: { responses: { 200: { content: { 'application/json': { schema: { oneOf: variants } } } } } },
      },
    });

  run(
    'union of object types is verified against schema oneOf',
    {
      'src/x.controller.ts': controller(`
@Controller('items')
export class C {
  @Get(':id')
  one(): Promise<{ id: string; full: string } | { id: string }> { return null as any; }
}`),
    },
    variantSnapshot([
      { type: 'object', properties: { id: {}, full: {} } },
      { type: 'object', properties: { id: {} } },
    ]),
    { verb: 'GET', route: '/items/{id}', verdict: 'ok' },
  );

  run(
    'a union member no variant covers is poor, not silently verified',
    {
      'src/x.controller.ts': controller(`
@Controller('items')
export class C {
  @Get(':id')
  one(): Promise<{ id: string; secret: string } | { id: string }> { return null as any; }
}`),
    },
    variantSnapshot([
      { type: 'object', properties: { id: {} } },
      { type: 'object', properties: { id: {} } },
    ]),
    { verb: 'GET', route: '/items/{id}', verdict: 'poor' },
  );

  run(
    'a free variant does not count as covering',
    {
      'src/x.controller.ts': controller(`
@Controller('items')
export class C {
  @Get(':id')
  one(): Promise<{ id: string; secret: string } | { id: string }> { return null as any; }
}`),
    },
    variantSnapshot([
      { type: 'object', properties: { id: {} }, additionalProperties: true },
      { type: 'object', properties: { id: {} } },
    ]),
    { verb: 'GET', route: '/items/{id}', verdict: 'poor' },
  );

  // --- код возврата: непроверенное краснеет ---

  {
    const filler = Array.from({ length: MIN_ROUTES }, (_, i) => ({
      verb: 'GET',
      route: `/x${i}`,
      file: 'f',
      line: 1,
      verdict: 'ok',
      gaps: [],
      unverified: [],
    }));
    const emptyRatchet = join(root, 'ratchet-ok.json');
    writeFileSync(emptyRatchet, JSON.stringify({ routes: 0, byReason: {} }));

    const withUnverifiable = [
      ...filler,
      { verb: 'GET', route: '/u', file: 'f', line: 1, verdict: 'unverifiable', why: 'return type is any' },
    ];
    const a = report(withUnverifiable, emptyRatchet) === false;
    record('unverifiable route makes the run red', a, a ? '' : 'вышло зелёным');

    const withUndocumented = [
      ...filler,
      { verb: 'DELETE', route: '/d', file: 'f', line: 1, verdict: 'undocumented' },
    ];
    const b = report(withUndocumented, emptyRatchet) === false;
    record('undocumented body makes the run red', b, b ? '' : 'вышло зелёным');

    const partly = [
      {
        verb: 'GET',
        route: '/p',
        file: 'f',
        line: 1,
        verdict: 'ok',
        gaps: [],
        unverified: [{ path: 'a', why: 'unknown' }],
      },
    ];

    const grew = join(root, 'ratchet-grew.json');
    writeFileSync(grew, JSON.stringify({ routes: 0, byReason: {} }));
    const c = report([...filler, ...partly], grew) === false;
    record('ratchet growth is red', c, c ? '' : 'рост непроверенного пропущен');

    const dropped = join(root, 'ratchet-dropped.json');
    writeFileSync(dropped, JSON.stringify({ routes: 5, byReason: { unknown: 9 } }));
    const d = report([...filler, ...partly], dropped) === false;
    record('ratchet drop without re-snapshot is red too', d, d ? '' : 'снижение пропущено');

    const exact = join(root, 'ratchet-exact.json');
    writeFileSync(exact, JSON.stringify({ routes: 1, byReason: { unknown: 1 } }));
    const e = report([...filler, ...partly], exact) === true;
    record('ratchet that matches reality is green', e, e ? '' : 'совпадение не прошло');

    const missing = join(root, 'ratchet-missing.json');
    const f = report(filler, missing) === false;
    record('missing ratchet snapshot is red, not assumed empty', f, f ? '' : 'отсутствие снимка пропущено');
  }

  {
    const few = [{ verb: 'GET', route: '/x', file: 'f', line: 1, verdict: 'ok', gaps: [], unverified: [] }];
    const passed = report(few) === false;
    record('route count below the floor is red even without a single gap', passed, passed ? '' : 'порог не сработал');
  }

  rmSync(root, { recursive: true, force: true });

  const failed = cases.filter((c) => !c.passed);
  console.log(`\n[response-schema self-test] случаев ${cases.length}, упало ${failed.length}`);
  return failed.length === 0;
}

/* ---------------- cli ---------------- */

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--self-test')) {
    console.log('[response-schema self-test] проверка сама себя на подложенных дефектах:');
    return selfTest() ? 0 : 1;
  }

  UPDATE_RATCHET = args.includes('--update');

  const reportIndex = args.indexOf('--report');
  const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : null;
  // Значение `--report` — не позиционный аргумент; всё остальное без `--` им является.
  // Прежняя редакция вычитала индекс `reportIndex + 1`, который без `--report` равен нулю,
  // то есть съедала первый же позиционный аргумент: путь к репозиторию молча игнорировался,
  // и прогон по чужому каталогу разбирал `books`.
  const positional = args.filter((a, i) => !a.startsWith('--') && !(reportIndex >= 0 && i === reportIndex + 1));
  const repoDir = positional[0] ? resolve(positional[0]) : DEFAULT_REPO;

  const results = analyse(repoDir);
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify({ counts: summarise(results), results }, null, 1));
    console.log(`[response-schema] отчёт: ${reportPath}`);
  }
  return report(results) ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv));
}
