import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SRC_ROOT, listFiles, relativeToSrc, stripComments } from './controller-decorators';

/**
 * Сторож перечня обращений к `BookCategory` (`LEGACY-005`).
 *
 * Колонка `BookCategory.isPrimary` мертва — в `true` её не пишет ни один путь, по значению
 * её не читает никто, главную категорию версии держит `BookVersion.primaryCategoryId`.
 * Снимает её **следующий** релиз миграцией, и по `ADR-018` (класс 1) это возможно ровно
 * при одном условии: работающий образ не должен её выбирать. Иначе `DROP COLUMN` даёт
 * `42703` на живых маршрутах, а откат образа перестаёт быть откатом.
 *
 * ⚠️ «Выбирает» шире, чем «читает», и в этом вся суть сторожа. Колонка попадает в `SELECT`
 * тремя способами, из которых явное чтение — только первый:
 *   1. вызов делегата без `select` — `findMany`, `findFirst`, `findUnique`;
 *   2. запись без `select` — `create`, `update`, `delete`, `upsert` возвращают строку
 *      через `RETURNING`, то есть перечисляют все скаляры;
 *   3. обход связи через `include` (или `categories: true`) — `include` на связи тянет
 *      все скаляры самой связи, даже когда потребителю нужен только вложенный `category`.
 *
 * ⚠️ Посадка на конкретный вызов такой гарантии не даёт: она молчит про вызов, который допишут
 * завтра. Первый заход по этой записи ровно на этом и споткнулся — три точечные посадки были
 * зелёными, пока четыре других обращения к той же модели продолжали выбирать колонку. Поэтому
 * здесь заморожен **перечень обращений**, а не поведение трёх из них.
 *
 * ⚠️ `select` ищется **среди ключей верхнего уровня** аргумента, а не подстрокой. Вызов
 * `findMany({ where, include: { category: { select: { translations: true } } } })` содержит
 * слово `select`, но скаляры связи выбирает целиком — от той формы, что лежала здесь
 * до `LEGACY-005`, его отделяет одно слово.
 *
 * ⚠️ Обход идёт и по `prisma/`, а не только по `src`: `prisma/seed.ts` — такое же обращение
 * к модели, и у него три потребителя, включая конвейер **соседнего** репозитория
 * (`LEGACY-294`). Пропущенный там `upsert` красит чужой CI, а не свой.
 *
 * ⚠️ Обход дерева и снятие комментариев берутся из `controller-decorators.ts`, а не пишутся
 * заново: рукописных копий `readdirSync` в репозитории и так больше, чем нужно (`LEGACY-290`).
 *
 * Спека переживёт снятие колонки и останется осмысленной: белый список на выдаче —
 * требование `books/CLAUDE.md` само по себе, вне зависимости от судьбы `isPrimary`.
 */

const PRISMA_ROOT = resolve(SRC_ROOT, '../prisma');

/** Вызовы, возвращающие строку (а значит, выбирающие её колонки) — в отличие от `count`. */
const ROW_OPS = [
  'create',
  'createMany',
  'upsert',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'findFirst',
  'findUnique',
  'findMany',
] as const;

/** `createMany`/`updateMany`/`deleteMany` отдают только счётчик — колонок не выбирают. */
const COUNT_ONLY = new Set<string>(['createMany', 'updateMany', 'deleteMany']);

const CALL_RE = new RegExp(`\\bbookCategory\\.(${ROW_OPS.join('|')})\\s*\\(`, 'g');

/**
 * Имена связи, ведущей к `BookCategory`, с обеих сторон:
 * `BookVersion.categories` (`schema.prisma:77`) и `Category.books` (`:388`).
 */
const RELATION_FIELDS = new Set<string>(['categories', 'books']);

/** Начало блока выборки: только внутрь такого блока и смотрим на связь. */
const SELECTION_RE = /\b(?:select|include)\s*:\s*(?=\{)/g;

/**
 * Ключи фильтра: `where: { categories: { some: … } }` связь не выбирает, а сужает выборку.
 * Такой объект в перечень не идёт.
 */
const FILTER_KEYS = new Set<string>(['some', 'every', 'none', 'is', 'isNot']);

/**
 * Текст блока от открывающей скобки до парной ей закрывающей.
 * Скобки считаются, а не ищутся регэкспом, иначе вложенный объект обрывает разбор
 * на первой же `}` и вызов с `select` в глубине выглядел бы голым.
 */
const balanced = (text: string, open: number, pair: '()' | '{}'): string => {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === pair[0]) depth += 1;
    else if (text[i] === pair[1]) {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
};

/** Пары «ключ верхнего уровня → текст значения»: вложенные в подобъекты сюда не попадают. */
const topLevelEntries = (objectBody: string): Map<string, string> => {
  const entries = new Map<string, string>();
  let depth = 0;
  for (let i = 0; i < objectBody.length; i += 1) {
    const ch = objectBody[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (depth === 0) {
      const key = /^([A-Za-z_$][\w$]*)\s*:\s*/.exec(objectBody.slice(i));
      if (key && (i === 0 || !/[\w$.]/.test(objectBody[i - 1]))) {
        entries.set(key[1], objectBody.slice(i + key[0].length));
      }
    }
  }
  return entries;
};

const topLevelKeys = (objectBody: string): Set<string> =>
  new Set(topLevelEntries(objectBody).keys());

/** Первый объектный литерал аргумента: `findMany({ … })` → тело фигурных скобок. */
const firstObjectOf = (args: string): string | null => {
  const brace = args.indexOf('{');
  return brace === -1 ? null : balanced(args, brace, '{}');
};

/** Ключи верхнего уровня у аргумента вызова — общая функция для обхода и для проб на отказ. */
const callArgumentKeys = (code: string, from = 0): Set<string> => {
  const re = new RegExp(CALL_RE.source, 'g');
  re.lastIndex = from;
  const match = re.exec(code);
  if (!match) return new Set();
  const args = balanced(code, match.index + match[0].length - 1, '()');
  return topLevelKeys(firstObjectOf(args) ?? '');
};

/**
 * Обращения к связи — общая функция для обхода и для проб на отказ.
 *
 * ⚠️ Смотрим **только внутрь `select:`/`include:`**, а не на `categories:` где попало.
 * Иначе в перечень попадает обычный объект настроек: `seo.controller.ts:121` передаёт
 * `{ categories: true, tags: true }` в пересчёт индексируемости, и к Prisma это отношения
 * не имеет. Ровно тот случай, ради которого `L-008` запрещает разбирать код регэкспом
 * без контекста.
 *
 * Вложенность закрывается сама: вложенные `select:`/`include:` — это свои совпадения
 * того же обхода.
 */
const relationFindings = (text: string): string[] => {
  const out: string[] = [];
  for (const match of text.matchAll(new RegExp(SELECTION_RE.source, 'g'))) {
    const body = balanced(text, match.index + match[0].length, '{}');
    for (const [field, value] of topLevelEntries(body)) {
      if (!RELATION_FIELDS.has(field)) continue;
      if (/^true\b/.test(value)) {
        out.push(`${field}: true`);
        continue;
      }
      if (!value.startsWith('{')) continue;
      const keys = topLevelKeys(balanced(value, 0, '{}'));
      if ([...keys].some((k) => FILTER_KEYS.has(k))) continue;
      if (keys.has('include')) out.push(`${field}: { include }`);
    }
  }
  return out;
};

type Finding = { file: string; what: string };

const collectBare = (): { findings: Finding[]; files: number; calls: number } => {
  const keep = (path: string) => path.endsWith('.ts') && !path.endsWith('.spec.ts');
  const files = [...listFiles(SRC_ROOT, keep), ...listFiles(PRISMA_ROOT, keep)];
  const findings: Finding[] = [];
  let calls = 0;

  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const where = relativeToSrc(file);

    for (const match of text.matchAll(CALL_RE)) {
      if (COUNT_ONLY.has(match[1])) continue;
      calls += 1;
      if (!callArgumentKeys(text, match.index).has('select')) {
        findings.push({ file: where, what: `${match[1]} без select` });
      }
    }

    for (const what of relationFindings(text)) findings.push({ file: where, what });
  }

  return { findings, files: files.length, calls };
};

describe('BookCategory читается только белым списком (LEGACY-005)', () => {
  const scan = collectBare();

  it('ни одно обращение к `BookCategory` не выбирает её скаляры', () => {
    expect(scan.findings).toEqual([]);
  });

  /**
   * 🔴 Пустой обход даёт тот же `[]`, что и чистое дерево (`L-015`). Без пола спека остаётся
   * зелёной, когда `SRC_ROOT` уехал при переносе файла или фильтр перестал попадать в `.ts`, —
   * и следующий релиз пишет `DROP COLUMN` по сторожу, не проверившему ни одного файла.
   */
  it('обход действительно дошёл до файлов и до самих вызовов', () => {
    expect(scan.files).toBeGreaterThan(400);
    expect(scan.calls).toBeGreaterThan(5);
  });

  /**
   * Пробы на отказ идут через **тот же** разбор, которым работает обход, а не через
   * отдельные регэкспы: иначе зелёной остаётся и спека со сломанным разбором.
   */
  describe('пробы на отказ разбора', () => {
    it('голый вызов отличается от вызова с белым списком', () => {
      expect([
        ...callArgumentKeys(`prisma.bookCategory.findFirst({ where: { id } })`),
      ]).not.toContain('select');
      expect([
        ...callArgumentKeys(
          `prisma.bookCategory.findFirst({ where: { id }, select: { id: true } })`,
        ),
      ]).toContain('select');
    });

    /** 🔴 Ровно та форма, что лежала в `seo.service.ts` до `LEGACY-005`: `select` есть, но вложенный. */
    it('вложенный `select` внутри `include` белым списком не считается', () => {
      const keys = [
        ...callArgumentKeys(`prisma.bookCategory.findMany({
          where: { bookVersionId },
          include: { category: { select: { translations: true } } },
        })`),
      ];
      expect(keys).not.toContain('select');
      expect(keys).toContain('include');
    });

    it('вложенный объект не обрывает разбор аргумента раньше времени', () => {
      expect([
        ...callArgumentKeys(
          `prisma.bookCategory.findMany({ where: { a: { b: 1 } }, select: { id: true } })`,
        ),
      ]).toContain('select');
    });

    it('ключ подобъекта за ключ верхнего уровня не выдаётся', () => {
      expect([...topLevelKeys(`where: { select: 1 }, include: { x: true }`)].sort()).toEqual([
        'include',
        'where',
      ]);
    });
  });

  describe('пробы на отказ по связи', () => {
    it('`include` на связи считается обращением, `select` — нет', () => {
      expect(relationFindings(`select: { categories: { include: { category: true } } }`)).toEqual([
        'categories: { include }',
      ]);
      expect(relationFindings(`select: { categories: { select: { category: true } } }`)).toEqual(
        [],
      );
    });

    it('`include` не первым ключом тоже виден', () => {
      expect(
        relationFindings(
          `select: { categories: { orderBy: { sortOrder: 'asc' }, include: { category: true } } }`,
        ),
      ).toEqual(['categories: { include }']);
    });

    it('`categories: true` и обратная сторона связи `books` видны', () => {
      expect(relationFindings(`include: { categories: true }`)).toEqual(['categories: true']);
      expect(relationFindings(`include: { books: true }`)).toEqual(['books: true']);
    });

    it('фильтр по связи выборкой не считается', () => {
      expect(relationFindings(`where: { categories: { some: { categoryId } } }`)).toEqual([]);
    });

    /**
     * 🔴 `seo.controller.ts:121` передаёт `{ categories: true, tags: true }` в пересчёт
     * индексируемости — это настройки, а не выборка Prisma. Без контекста `select`/`include`
     * сторож краснел на живом коде и требовал бы «починить» то, что не сломано (`L-008`).
     */
    it('обычный объект настроек за выборку не принимается', () => {
      expect(relationFindings(`const cold = { categories: true, tags: true };`)).toEqual([]);
    });
  });

  it('счётные вызовы колонок не выбирают и в перечень не идут', () => {
    expect([...COUNT_ONLY]).toEqual(['createMany', 'updateMany', 'deleteMany']);
  });
});
