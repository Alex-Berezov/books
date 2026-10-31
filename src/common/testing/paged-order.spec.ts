import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import * as ts from 'typescript';

import {
  importsOf,
  listFiles,
  parseSource,
  propertyKey,
  relativeToSrc,
  SRC_ROOT,
  unwrap,
} from './controller-decorators';

/**
 * `LEGACY-484`. Постраничная выдача (`skip`) по неуникальному ключу повторяет одни записи
 * и теряет другие на соседних страницах: записи с одной меткой времени (сид, пакетная
 * загрузка) меняются местами от запроса к запросу. Сторож разбирает исходники `src`
 * (TypeScript AST): в каждом `findMany({ ... skip ... })` порядок обязан кончаться ключом
 * верхнего уровня `id` — последним элементом массива `orderBy` или единственным ключом
 * объекта; в `groupBy({ ... skip ... })` — `id` или единственным полем из `by`. Порядок,
 * заданный именем (`orderBy,` / `orderBy: NAME`), разворачивается в ближайшее объявление
 * этого файла или файла, из которого имя импортировано относительным путём; не нашлось —
 * нарушение, а не пропуск.
 *
 * ⚠️ Граница: аргументы, собранные вне литерала (`findMany(args)`, `findMany({ ...page })`),
 * и сырой SQL с `OFFSET` сторож не видит — такие выдачи проверяются ревью (`LEGACY-484`).
 */

/**
 * `файл|ключи порядка` → поле области и почему `id` не нужен: ключи уникальны внутри
 * области (`@@unique`), и выдача обязана держать это поле в `where`. Исключение действует
 * только на этот порядок этого файла и только при поле области в `where`.
 */
const UNIQUE_ORDER: Readonly<Record<string, { scope: string; why: string }>> = {
  'modules/audio-chapter/audio-chapter.service.ts|number': {
    scope: 'bookVersionId',
    why: '`@@unique([bookVersionId, number])`',
  },
  'modules/chapter/chapter.service.ts|number': {
    scope: 'bookVersionId',
    why: '`@@unique([bookVersionId, number])`',
  },
  'modules/translation/dossier/dossier-tasks.handler.ts|chapterNumber,partIndex': {
    scope: 'dossierId',
    why: '`@@unique([dossierId, chapterNumber, partIndex])`',
  },
  'modules/translation/dossier/dossier-tasks.handler.ts|groupIndex': {
    scope: 'dossierId',
    why: '`@@unique([dossierId, level, groupIndex])`, `level` тоже в `where`',
  },
};

type Verdict = { line: number; keys: string; ok: boolean; scope: string[]; why?: string };

const PAGED_CALLS = new Set(['findMany', 'groupBy']);

/** Сколько вердиктов порядка сторож выносит сейчас (`T154`; тернарник — два на вызов); меньше — разбор ослеп. */
const PAGED_SEEN_FLOOR = 40;

/** Сколько постраничных вызовов (не вердиктов) сторож видит сейчас (`T154`). */
const PAGED_CALLS_FLOOR = 39;

/**
 * Объявление `const|let NAME = <init>`, видимое из `from`: ближайшее по вложенности блока
 * (объявление в том же методе важнее одноимённого в соседнем; из соседнего метода или
 * вложенного `if {}` не видно). Без `from` — только объявление верхнего уровня файла.
 * Параметр функции и деструктуризация тоже объявляют имя и перекрывают внешнее: ближайшим
 * оказалось такое — значение задаёт вызывающий, `undefined`, то есть нарушение.
 * ⚠️ `let`, переприсвоенный ниже, берётся по инициализатору.
 */
function declaredIn(
  source: ts.SourceFile,
  name: string,
  from?: ts.Node,
): ts.Expression | undefined {
  const found: Array<ts.VariableDeclaration | ts.ParameterDeclaration | ts.BindingElement> = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const scopeOf = (node: ts.Node): ts.Node => {
    // Параметр виден во всей своей функции; остальное — в ближайшем блоке.
    if (ts.isParameter(node)) return node.parent;
    let current: ts.Node = node.parent;
    while (!ts.isSourceFile(current) && !ts.isBlock(current)) current = current.parent;
    return current;
  };
  const target = from ?? source;
  const visible = found.filter((d) => {
    const scope = scopeOf(d);
    return from
      ? scope.getStart() <= target.getStart() && target.getEnd() <= scope.getEnd()
      : ts.isSourceFile(scope);
  });
  const nearest = visible.sort((a, b) => scopeOf(b).getStart() - scopeOf(a).getStart())[0];
  return nearest && ts.isVariableDeclaration(nearest) ? nearest.initializer : undefined;
}

/**
 * Объявление имени, импортированного относительным путём (`import { A as B } from './x'`
 * тоже): `const A = ...` файла `x.ts`. Пакеты и псевдонимы путей — нет.
 */
function importedDeclaration(
  source: ts.SourceFile,
  name: string,
): { source: ts.SourceFile; init: ts.Expression } | undefined {
  const ref = importsOf(source).named.get(name);
  if (!ref || !ref.module.startsWith('.')) return undefined;
  const file = `${resolve(dirname(source.fileName), ref.module)}.ts`;
  if (!existsSync(file)) return undefined;
  const other = parseSource(readFileSync(file, 'utf8'), file);
  const init = declaredIn(other, ref.name);
  return init ? { source: other, init } : undefined;
}

/** Выражение, на которое указывает имя: объявление этого файла, затем относительного импорта. */
function resolveName(
  source: ts.SourceFile,
  expr: ts.Expression,
): { source: ts.SourceFile; expr: ts.Expression } {
  const bare = unwrap(expr);
  if (!ts.isIdentifier(bare)) return { source, expr: bare };
  const init = declaredIn(source, bare.text, bare);
  if (init) return resolveName(source, init);
  const imported = importedDeclaration(source, bare.text);
  return imported ? resolveName(imported.source, imported.init) : { source, expr: bare };
}

/** Формы порядка: имя разворачивается, тернарник — в обе ветки. */
function orderShapes(source: ts.SourceFile, expr: ts.Expression | undefined): ts.Expression[] {
  if (!expr) return [];
  const found = resolveName(source, expr);
  if (ts.isConditionalExpression(found.expr)) {
    return [
      ...orderShapes(found.source, found.expr.whenTrue),
      ...orderShapes(found.source, found.expr.whenFalse),
    ];
  }
  return [found.expr];
}

/** Значение свойства литерала: `key: value` или `key,` (короткая запись). */
function propertyValue(args: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  const prop = args.properties.find((p) => propertyKey(p) === key);
  if (!prop) return undefined;
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name;
  return ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
}

/**
 * Ключи верхнего уровня `where`, отфильтрованные равенством (`key` или `key: value`
 * не объектом): `{ bookVersionId: { in: ids } }` область не сужает до одной.
 * ⚠️ Граница: значение-имя, которое может прийти `undefined` (Prisma такой фильтр снимает)
 * или держать `{ in }`, разбор не отличит — исключения `UNIQUE_ORDER` поэтому держат только
 * методы с обязательным аргументом области, а новое исключение проверяется ревью.
 */
function whereKeys(source: ts.SourceFile, args: ts.ObjectLiteralExpression): string[] {
  const where = propertyValue(args, 'where');
  if (!where) return [];
  const found = resolveName(source, where).expr;
  if (!ts.isObjectLiteralExpression(found)) return [];
  return found.properties
    .filter(
      (p) =>
        ts.isShorthandPropertyAssignment(p) ||
        (ts.isPropertyAssignment(p) && !ts.isObjectLiteralExpression(unwrap(p.initializer))),
    )
    .map(propertyKey)
    .filter((k): k is string => k !== undefined);
}

/** Ключи верхнего уровня через запятую; последний — или `null`, если форма не литерал. */
function shapeKeys(shape: ts.Expression): { keys: string; last: string | null } {
  const entries = ts.isArrayLiteralExpression(shape) ? [...shape.elements] : [shape];
  const keys: string[] = [];
  for (const entry of entries) {
    if (!ts.isObjectLiteralExpression(entry) || entry.properties.length !== 1) {
      return { keys: entry.getText(), last: null };
    }
    keys.push(propertyKey(entry.properties[0]) ?? '?');
  }
  return { keys: keys.join(','), last: keys[keys.length - 1] ?? null };
}

/** Поле `by` у `groupBy` — уникально в выдаче групп, только если оно одно. */
function groupKeys(args: ts.ObjectLiteralExpression): string[] {
  const by = propertyValue(args, 'by');
  if (!by || !ts.isArrayLiteralExpression(by)) return [];
  const fields = by.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
  return fields.length === 1 ? fields : [];
}

/** Все постраничные `findMany`/`groupBy` файла с вердиктом по каждому порядку. */
function pagedOrders(code: string, fileName = join(SRC_ROOT, 'fixture.service.ts')): Verdict[] {
  const source = parseSource(code, fileName);
  const verdicts: Verdict[] = [];
  const visit = (node: ts.Node): void => {
    const args = ts.isCallExpression(node) ? node.arguments[0] : undefined;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      PAGED_CALLS.has(node.expression.name.text) &&
      args &&
      ts.isObjectLiteralExpression(args) &&
      args.properties.some((p) => propertyKey(p) === 'skip')
    ) {
      const unique = new Set(['id', ...groupKeys(args)]);
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const scope = whereKeys(source, args);
      const shapes = orderShapes(source, propertyValue(args, 'orderBy'));
      if (shapes.length === 0) {
        verdicts.push({ line, keys: '', ok: false, scope, why: 'нет orderBy' });
      }
      for (const shape of shapes) {
        const { keys, last } = shapeKeys(shape);
        verdicts.push({ line, keys, ok: last !== null && unique.has(last), scope });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return verdicts;
}

describe('постраничные выдачи: уникальный ключ последним в порядке (LEGACY-484)', () => {
  describe('разбор', () => {
    const ok = (code: string, fileName?: string): boolean[] =>
      pagedOrders(code, fileName).map((v) => v.ok);

    it('id последним ключом верхнего уровня — пропуск', () => {
      expect(
        ok(`db.x.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take });`),
      ).toEqual([true]);
      expect(ok(`db.x.findMany({ orderBy: { id: 'asc' }, skip: 1, take: 2 });`)).toEqual([true]);
      expect(
        ok(`db.x.findMany({ orderBy: [{ a: 'asc' }, { id: 'asc' }] satisfies X, skip });`),
      ).toEqual([true]);
    });

    it('без id, id не последним, id связи, два ключа в объекте или без orderBy — отказ', () => {
      expect(ok(`db.x.findMany({ orderBy: { createdAt: 'desc' }, skip, take });`)).toEqual([false]);
      expect(
        ok(`db.x.findMany({ orderBy: [{ id: 'asc' }, { createdAt: 'desc' }], skip, take });`),
      ).toEqual([false]);
      expect(
        ok(`db.x.findMany({ orderBy: [{ createdAt: 'desc' }, { book: { id: 'asc' } }], skip });`),
      ).toEqual([false]);
      expect(ok(`db.x.findMany({ orderBy: { createdAt: 'desc', id: 'desc' }, skip });`)).toEqual([
        false,
      ]);
      expect(ok(`db.x.findMany({ where, skip, take });`)).toEqual([false]);
    });

    it('имя порядка — ближайшее объявление этого файла, тернарник — обе ветки', () => {
      expect(
        ok(`const orderBy = p ? [{ likes: 'desc' }, { id: 'desc' }] : [{ createdAt: 'desc' }];
            db.x.findMany({ orderBy, skip, take });`),
      ).toEqual([true, false]);
      // Одноимённое объявление в соседнем методе не подменяет своё.
      expect(
        ok(`function a() { const orderBy = { id: 'asc' }; return db.x.findMany({ orderBy }); }
            function b() { const orderBy = { createdAt: 'desc' }; db.x.findMany({ orderBy, skip }); }`),
      ).toEqual([false]);
    });

    it('имя из относительного импорта разворачивается в объявление того файла', () => {
      const fixture = join(SRC_ROOT, 'modules/rights-licenses/fixture.service.ts');
      expect(
        ok(
          `import { LICENSE_LIST_ORDER } from './rights-license-coverage.service';
           db.x.findMany({ orderBy: LICENSE_LIST_ORDER, skip });`,
          fixture,
        ),
      ).toEqual([true]);
      expect(
        ok(
          `import { LICENSE_LIST_ORDER as ORDER } from './rights-license-coverage.service';
           db.x.findMany({ orderBy: ORDER, skip });`,
          fixture,
        ),
      ).toEqual([true]);
      expect(ok(`db.x.findMany({ orderBy: IMPORTED_ORDER, skip, take });`)).toEqual([false]);
    });

    it('groupBy: последним единственное поле группы — пропуск; агрегат или два поля — отказ', () => {
      expect(
        ok(`db.x.groupBy({ by: ['g'], orderBy: [{ _max: { u: 'desc' } }, { g: 'asc' }], skip });`),
      ).toEqual([true]);
      expect(ok(`db.x.groupBy({ by: ['g'], orderBy: { _max: { u: 'desc' } }, skip });`)).toEqual([
        false,
      ]);
      expect(
        ok(
          `db.x.groupBy({ by: ['g', 'h'], orderBy: [{ _max: { u: 'desc' } }, { g: 'asc' }], skip });`,
        ),
      ).toEqual([false]);
    });

    it('поля where собираются для исключения по области', () => {
      expect(
        pagedOrders(`const where = { bookVersionId };
                     db.x.findMany({ where, orderBy: { number: 'asc' }, skip });`)[0].scope,
      ).toEqual(['bookVersionId']);
      expect(
        pagedOrders(`db.x.findMany({ where: { bookVersionId: { in: ids }, level: 1 },
                     orderBy: { number: 'asc' }, skip });`)[0].scope,
      ).toEqual(['level']);
    });

    it('параметр или объявление из соседнего блока порядком не считается', () => {
      expect(
        ok(`function a() { const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }]; }
            function b(orderBy: X) { db.x.findMany({ orderBy, skip }); }`),
      ).toEqual([false]);
      expect(
        ok(
          `function c() { if (p) { const orderBy = { id: 'asc' }; } db.x.findMany({ orderBy, skip }); }`,
        ),
      ).toEqual([false]);
      // Параметр метода перекрывает одноимённую константу модуля.
      expect(
        ok(`const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
            class S { list(orderBy: X) { return db.x.findMany({ orderBy, skip }); } }`),
      ).toEqual([false]);
    });

    it('выдача без skip не постраничная и не проверяется', () => {
      expect(pagedOrders(`db.x.findMany({ orderBy: { createdAt: 'desc' } });`)).toEqual([]);
    });
  });

  describe('исходники src', () => {
    const files = listFiles(
      SRC_ROOT,
      (path) => path.endsWith('.ts') && !path.endsWith('.spec.ts') && !path.endsWith('.d.ts'),
    );
    const offenders: string[] = [];
    const usedExceptions = new Set<string>();
    // Считаются вызовы, а не вердикты: тернарник в `orderBy` даёт два вердикта на один вызов.
    const pagedCalls = new Set<string>();
    let pagedSeen = 0;

    for (const file of files) {
      const where = relativeToSrc(file);
      for (const v of pagedOrders(readFileSync(file, 'utf8'), file)) {
        pagedCalls.add(`${where}:${v.line}`);
        pagedSeen += 1;
        if (v.ok) continue;
        const exception = `${where}|${v.keys}`;
        const allowed = Object.prototype.hasOwnProperty.call(UNIQUE_ORDER, exception)
          ? UNIQUE_ORDER[exception]
          : undefined;
        if (allowed && v.scope.includes(allowed.scope)) {
          usedExceptions.add(exception);
          continue;
        }
        offenders.push(`${where}:${v.line} — ${v.why ?? `порядок без id последним: ${v.keys}`}`);
      }
    }

    it('сторож видит постраничные выдачи (иначе он слеп)', () => {
      // Число выдач на 31.10.2026 (`T154`). Упало — разбор перестал видеть часть вызовов,
      // а не выдачи исчезли: сверь с `rg -n "skip" src --glob '!*.spec.ts'`.
      expect(pagedSeen).toBeGreaterThanOrEqual(PAGED_SEEN_FLOOR);
      expect(pagedCalls.size).toBeGreaterThanOrEqual(PAGED_CALLS_FLOOR);
    });

    it('в каждой порядок кончается уникальным ключом', () => {
      expect(offenders).toEqual([]);
    });

    it('каждое исключение ещё нужно (иначе оно прикрывает чужой порядок)', () => {
      expect([...usedExceptions].sort()).toEqual(Object.keys(UNIQUE_ORDER).sort());
    });
  });
});
