#!/usr/bin/env node
// Migration compatibility check: does every migration leave the previous image working?
//
// ADR-018. A release carries everything merged since the previous tag (LEGACY-241), and
// `prisma migrate deploy` applies the directories one by one without wrapping the set in a
// transaction. A failure on the fifth migration of seven leaves four applied. That is only
// survivable while the previous image still runs against the new schema — which is exactly
// what a destructive statement takes away. Rollback in this project rolls back the *image*,
// never the schema (ADR-018), so this check is what makes rollback meaningful at all.
//
// "Destructive" here means one of two things:
//   - the old code stops working the moment the statement lands: something it reads is gone,
//     renamed or retyped, or something it writes now violates a constraint that did not
//     exist a second ago;
//   - data disappears, and rolling the image back does not bring it back.
//
// Either way the fix is the same shape: two releases with a tag in between. First expand
// (add, write both ways), then contract (stop reading, drop). The intermediate state is what
// production actually runs between the two tags, so it is not a formality.
//
// Pure Node (>= 20), no dependencies, read-only.
//
// Usage:
//   node scripts/check-migration-compat.mjs [repoDir]
//   node scripts/check-migration-compat.mjs --self-test
//
// Exit code: 0 — every migration is backwards compatible or explicitly allowlisted;
//            1 — a destructive statement outside the allowlist, or the allowlist itself is stale.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = join(SCRIPT_DIR, '..');
const ALLOWLIST_NAME = 'migration-compat-allowlist.json';

/**
 * SQL without comments. Character by character rather than by regex: `--` inside a string
 * literal is not a comment, and stripping by regex would eat half the statement with it.
 * Dollar quoting (`$$ ... $$`) carries the idempotent `DO` blocks used across this project;
 * its body is kept, because DDL inside such a block is DDL all the same.
 */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (sql[i] === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '\\' && sql[i + 1] !== undefined) {
          i += 2;
          continue;
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }
    const dollar = /^\$(\w*)\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/**
 * Обвязка блока PL/pgSQL, снятая с начала оператора. Идемпотентные миграции в проекте
 * написаны как `DO $$ BEGIN IF NOT EXISTS (...) THEN ALTER TABLE ...; END IF; END $$;`,
 * и без снятия этой обвязки настоящий DDL не опознаётся: оператор начинается с `BEGIN`.
 */
function stripBlockNoise(statement) {
  let s = statement;
  for (;;) {
    const next = s
      .replace(/^(?:BEGIN|DECLARE|ELSE|LOOP|END(?:\s+IF|\s+LOOP)?)\b\s*/i, '')
      .replace(/^(?:IF|ELSIF)\b[\s\S]*?\bTHEN\b\s*/i, '');
    if (next === s) return s;
    s = next;
  }
}

/**
 * Операторы, пробелы схлопнуты. Тело `$tag$ ... $tag$` вынимается и разбирается отдельно:
 * DDL внутри идемпотентного `DO`-блока — это тот же DDL, и делить его по `;` вместе с
 * внешним текстом нельзя, иначе `;` внутри блока рвёт внешний оператор.
 */
function statements(sql) {
  const clean = stripSqlComments(sql);
  const bodies = [];
  let outer = '';
  let i = 0;
  while (i < clean.length) {
    const open = /^\$(\w*)\$/.exec(clean.slice(i));
    if (open) {
      const tag = open[0];
      const end = clean.indexOf(tag, i + tag.length);
      const stop = end === -1 ? clean.length : end;
      bodies.push(clean.slice(i + tag.length, stop));
      i = end === -1 ? clean.length : end + tag.length;
      outer += ' ';
      continue;
    }
    outer += clean[i];
    i += 1;
  }
  const split = (text) =>
    text
      .split(';')
      .map((s) => stripBlockNoise(s.replace(/\s+/g, ' ').trim()))
      .filter(Boolean);
  return [...split(outer), ...bodies.flatMap(split)];
}

const ident = '(?:"[^"]+"|\\w+)';

const unquote = (name) => name.replace(/"/g, '');

/** Идентификаторы в кавычках внутри куска SQL. */
const quotedIn = (text) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/** Содержимое первой скобочной группы после позиции. */
function groupAfter(s, at) {
  const open = s.indexOf('(', at);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    if (s[i] === ')') {
      depth -= 1;
      if (depth === 0) return s.slice(open + 1, i);
    }
  }
  return '';
}

/**
 * Колонки, которые ограничивает оператор. Для внешнего ключа берётся только группа после
 * `FOREIGN KEY`: `REFERENCES "Category"("id")` описывает чужую таблицу и к нашей проверке
 * отношения не имеет.
 */
function constrainedColumns(s) {
  const uniqueIndex = /^CREATE\s+UNIQUE\s+INDEX\b/i.test(s);
  if (uniqueIndex) {
    const on = /\bON\s+(?:ONLY\s+)?(?:"[^"]+"|\w+)/i.exec(s);
    return on ? quotedIn(groupAfter(s, on.index + on[0].length)) : [];
  }
  for (const kw of [/\bFOREIGN\s+KEY\b/i, /\bUNIQUE\b/i, /\bCHECK\b/i, /\bPRIMARY\s+KEY\b/i]) {
    const m = kw.exec(s);
    if (m) return quotedIn(groupAfter(s, m.index + m[0].length));
  }
  return [];
}

/**
 * Таблица, к которой относится оператор: `ALTER TABLE "X"`, `CREATE ... INDEX ... ON "X"`.
 * Пустая строка, если оператор не про таблицу.
 */
function targetTable(s) {
  const alter = new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${ident})`, 'i').exec(s);
  if (alter) return unquote(alter[1]);
  const index = new RegExp(`\\bON\\s+(?:ONLY\\s+)?(${ident})`, 'i').exec(s);
  if (index && /^CREATE\b/i.test(s)) return unquote(index[1]);
  return '';
}

/**
 * Detectors. Each is checked against one statement at a time, so `ALTER TABLE` clauses cannot
 * be confused with a top-level `DROP`. Keyword spacing is `\s+` because whitespace is already
 * collapsed; `COLUMN` is optional throughout because PostgreSQL treats it as noise and
 * hand-written migrations (ADR-011) leave it out.
 */
const DETECTORS = [
  // --- the old image can no longer read what it used to ---
  {
    id: 'DROP COLUMN',
    test: (s) =>
      /^ALTER\s+TABLE\b/i.test(s) &&
      new RegExp(`\\bDROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?${ident}`, 'i').test(s) &&
      !/\bDROP\s+(?:CONSTRAINT|DEFAULT|NOT\s+NULL)\b/i.test(s),
  },
  { id: 'DROP TABLE', test: (s) => /^DROP\s+TABLE\b/i.test(s) },
  { id: 'DROP TYPE', test: (s) => /^DROP\s+TYPE\b/i.test(s) },
  {
    id: 'RENAME COLUMN',
    test: (s) =>
      /^ALTER\s+TABLE\b/i.test(s) &&
      new RegExp(`\\bRENAME\\s+(?:COLUMN\\s+)?${ident}\\s+TO\\b`, 'i').test(s),
  },
  { id: 'RENAME TABLE', test: (s) => /^ALTER\s+TABLE\b/i.test(s) && /\bRENAME\s+TO\b/i.test(s) },
  { id: 'RENAME TYPE', test: (s) => /^ALTER\s+TYPE\b/i.test(s) && /\bRENAME\s+TO\b/i.test(s) },
  { id: 'RENAME ENUM VALUE', test: (s) => /^ALTER\s+TYPE\b/i.test(s) && /\bRENAME\s+VALUE\b/i.test(s) },
  {
    id: 'ALTER COLUMN TYPE',
    test: (s) =>
      /^ALTER\s+TABLE\b/i.test(s) &&
      new RegExp(`\\bALTER\\s+(?:COLUMN\\s+)?${ident}\\s+(?:SET\\s+DATA\\s+)?TYPE\\b`, 'i').test(s),
  },

  // --- what the old image writes now violates a constraint that did not exist before ---
  { id: 'SET NOT NULL', test: (s) => /^ALTER\s+TABLE\b/i.test(s) && /\bSET\s+NOT\s+NULL\b/i.test(s) },
  {
    id: 'ADD COLUMN NOT NULL',
    test: (s) =>
      /^ALTER\s+TABLE\b/i.test(s) &&
      /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i.test(s) &&
      /\bNOT\s+NULL\b/i.test(s) &&
      !/\bDEFAULT\b/i.test(s),
  },
  { id: 'CREATE UNIQUE INDEX', test: (s) => /^CREATE\s+UNIQUE\s+INDEX\b/i.test(s) },
  {
    id: 'ADD CONSTRAINT',
    test: (s) =>
      /^ALTER\s+TABLE\b/i.test(s) &&
      /\bADD\s+CONSTRAINT\b/i.test(s) &&
      /\b(?:UNIQUE|CHECK|FOREIGN\s+KEY|PRIMARY\s+KEY|EXCLUDE)\b/i.test(s),
  },

  // --- guarantees the old image relies on go away ---
  { id: 'DROP CONSTRAINT', test: (s) => /^ALTER\s+TABLE\b/i.test(s) && /\bDROP\s+CONSTRAINT\b/i.test(s) },
  { id: 'DROP INDEX', test: (s) => /^DROP\s+INDEX\b/i.test(s) },

  // --- data disappears, and rolling the image back does not bring it back ---
  { id: 'TRUNCATE', test: (s) => /^TRUNCATE\b/i.test(s) },
  { id: 'DELETE FROM', test: (s) => /^DELETE\s+FROM\b/i.test(s) },
];

const constraintNames = (re, sql) =>
  new Set([...statements(sql).flatMap((s) => [...s.matchAll(re)]).map((m) => m[1].replace(/"/g, ''))]);

/**
 * Constructs found in one migration.
 *
 * 🔴 A constraint dropped and re-added under the same name in the same migration is not
 * destructive: it is how a foreign key gets its `ON DELETE` action changed, and how an
 * idempotent migration is written (`DROP CONSTRAINT IF EXISTS x; ADD CONSTRAINT x ...`).
 * Without this pairing the allowlist fills up with migrations that never broke anything,
 * and an entry in it stops meaning what ADR-018 says it means.
 */
export function destructiveIn(sql) {
  const parsed = statements(sql);

  const dropped = constraintNames(new RegExp(`\\bDROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?(${ident})`, 'gi'), sql);
  const added = constraintNames(new RegExp(`\\bADD\\s+CONSTRAINT\\s+(${ident})`, 'gi'), sql);
  const paired = [...dropped].filter((name) => added.has(name));
  const pairedOnly = paired.length > 0 && paired.length === dropped.size && dropped.size === added.size;

  // 🔴 Ограничение на таблицу, заведённую этой же миграцией, ничего не ломает: предыдущий
  // образ про такую таблицу не знает и в неё не пишет. Без этой поправки список исключений
  // разросся бы до трети каталога — почти каждая миграция, создающая модель, ставит на неё
  // уникальный индекс и внешние ключи, — и перестал бы что-либо означать.
  const createdTables = new Set(
    parsed
      .filter((s) => /^CREATE\s+TABLE\b/i.test(s))
      .map((s) => new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ident})`, 'i').exec(s))
      .filter(Boolean)
      .map((m) => unquote(m[1])),
  );
  const ON_NEW_TABLE_IS_FINE = new Set(['ADD CONSTRAINT', 'CREATE UNIQUE INDEX', 'ADD COLUMN NOT NULL', 'SET NOT NULL']);

  // 🔴 То же и про колонку: ограничение на колонку, добавленную этой же миграцией, старому
  // образу не мешает — он в неё не пишет, а `UNIQUE` в PostgreSQL допускает сколько угодно
  // NULL. Опасно ограничение, наложенное на **живые** данные: их старый образ пишет прямо
  // сейчас, и первая же запись после выката упирается в 23505 или 23514.
  const addedColumns = new Map();
  for (const s of parsed) {
    if (!/^ALTER\s+TABLE\b/i.test(s)) continue;
    const table = targetTable(s);
    for (const m of s.matchAll(new RegExp(`\\bADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?"([^"]+)"`, 'gi'))) {
      if (!addedColumns.has(table)) addedColumns.set(table, new Set());
      addedColumns.get(table).add(m[1]);
    }
  }
  const onlyNewColumns = (s) => {
    const cols = constrainedColumns(s);
    if (cols.length === 0) return false;
    const fresh = addedColumns.get(targetTable(s)) ?? new Set();
    return cols.every((c) => fresh.has(c));
  };

  const found = new Set();
  for (const s of parsed) {
    for (const d of DETECTORS) {
      if (!d.test(s)) continue;
      if (pairedOnly && (d.id === 'DROP CONSTRAINT' || d.id === 'ADD CONSTRAINT')) continue;
      if (ON_NEW_TABLE_IS_FINE.has(d.id) && createdTables.has(targetTable(s))) continue;
      if ((d.id === 'ADD CONSTRAINT' || d.id === 'CREATE UNIQUE INDEX') && onlyNewColumns(s)) continue;
      found.add(d.id);
    }
  }
  return [...found].sort();
}

/** Migration directories, alphabetical — which is also Prisma's chronological order. */
function migrationNames(repo) {
  const dir = join(repo, 'prisma', 'migrations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'migration.sql')))
    .map((e) => e.name)
    .sort();
}

function readAllowlist(repo) {
  const path = join(repo, 'scripts', ALLOWLIST_NAME);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')).allowed ?? {};
}

export function checkRepo(repo) {
  const problems = [];
  const out = [];
  const names = migrationNames(repo);
  const entries = readAllowlist(repo);

  out.push(`migrations: ${names.length}, allowlisted: ${Object.keys(entries).length}`);

  const foundByName = new Map();
  for (const name of names) {
    const found = destructiveIn(readFileSync(join(repo, 'prisma', 'migrations', name, 'migration.sql'), 'utf8'));
    if (found.length) foundByName.set(name, found);
  }

  for (const [name, found] of foundByName) {
    const entry = entries[name];
    if (entry === undefined) {
      problems.push(`destructive:${name}`);
      out.push(`  x ${name}: ${found.join(', ')}`);
      continue;
    }
    // 🔴 Исключение выдаётся на перечисленные конструкции, а не на каталог целиком.
    // Иначе разрешённая миграция становится местом, где любая новая разрушающая правка
    // бесплатна — а правка уже применённого `migration.sql` и без того запрещена
    // (`rules.books.json`, `createOnly`), но ловится только `drift-check`.
    const allowed = new Set(entry.constructs ?? []);
    const extra = found.filter((c) => !allowed.has(c));
    if (extra.length) {
      problems.push(`destructive:${name}`);
      out.push(`  x ${name}: ${extra.join(', ')} (не перечислено в исключении)`);
    }
  }

  // 🔴 Список краснеет в обе стороны. Запись про миграцию, которой больше нет, запись про
  // миграцию без разрушающих конструкций и перечисленная конструкция, которой в файле нет,
  // — всё это ошибки: иначе список превращается в свалку, куда дописывают «на всякий
  // случай», и правило умирает молча.
  const known = new Set(names);
  for (const [name, entry] of Object.entries(entries)) {
    if (!known.has(name)) {
      problems.push(`allowlist-orphan:${name}`);
      out.push(`  x allowlist: миграции \`${name}\` нет в prisma/migrations`);
      continue;
    }
    const found = foundByName.get(name) ?? [];
    if (found.length === 0) {
      problems.push(`allowlist-stale:${name}`);
      out.push(`  x allowlist: в \`${name}\` нет разрушающих конструкций — запись лишняя`);
      continue;
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      problems.push(`allowlist-no-reason:${name}`);
      out.push(`  x allowlist: у \`${name}\` нет внятной причины`);
    }
    const listed = entry.constructs ?? [];
    const unused = listed.filter((c) => !found.includes(c));
    if (unused.length) {
      problems.push(`allowlist-unused:${name}`);
      out.push(`  x allowlist: в \`${name}\` нет конструкций ${unused.join(', ')} — запись шире факта`);
    }
  }

  return { problems, out };
}

/* ---------------- self-test ---------------- */

const OK = 'ALTER TABLE "Book" ADD COLUMN "subtitle" TEXT;';
const CASES = [
  { name: 'чистая миграция проходит', sql: OK, expect: [] },
  { name: 'DROP COLUMN', sql: 'ALTER TABLE "Book" DROP COLUMN "subtitle";', expect: ['DROP COLUMN'] },
  { name: 'DROP без слова COLUMN', sql: 'ALTER TABLE "Book" DROP "subtitle";', expect: ['DROP COLUMN'] },
  { name: 'DROP IF EXISTS без слова COLUMN', sql: 'ALTER TABLE "Book" DROP IF EXISTS "subtitle";', expect: ['DROP COLUMN'] },
  { name: 'DROP DEFAULT — послабление, не находка', sql: 'ALTER TABLE "Book" ALTER COLUMN "x" DROP DEFAULT;', expect: [] },
  { name: 'DROP NOT NULL — послабление, не находка', sql: 'ALTER TABLE "Book" ALTER COLUMN "x" DROP NOT NULL;', expect: [] },
  { name: 'DROP TABLE', sql: 'DROP TABLE "Bookshelf";', expect: ['DROP TABLE'] },
  { name: 'DROP TYPE', sql: 'DROP TYPE "Status";', expect: ['DROP TYPE'] },
  { name: 'RENAME COLUMN', sql: 'ALTER TABLE "Book" RENAME COLUMN "a" TO "b";', expect: ['RENAME COLUMN'] },
  { name: 'RENAME без слова COLUMN', sql: 'ALTER TABLE "Book" RENAME "a" TO "b";', expect: ['RENAME COLUMN'] },
  { name: 'RENAME TABLE', sql: 'ALTER TABLE "Book" RENAME TO "Books";', expect: ['RENAME TABLE'] },
  { name: 'RENAME TYPE', sql: 'ALTER TYPE "Status" RENAME TO "Status_old";', expect: ['RENAME TYPE'] },
  { name: 'RENAME VALUE у enum', sql: "ALTER TYPE \"Lang\" RENAME VALUE 'en' TO 'eng';", expect: ['RENAME ENUM VALUE'] },
  { name: 'ALTER COLUMN TYPE', sql: 'ALTER TABLE "Book" ALTER COLUMN "x" TYPE INTEGER;', expect: ['ALTER COLUMN TYPE'] },
  { name: 'ALTER COLUMN SET DATA TYPE', sql: 'ALTER TABLE "Book" ALTER "x" SET DATA TYPE INTEGER;', expect: ['ALTER COLUMN TYPE'] },
  { name: 'SET NOT NULL', sql: 'ALTER TABLE "Book" ALTER COLUMN "slug" SET NOT NULL;', expect: ['SET NOT NULL'] },
  { name: 'ADD COLUMN NOT NULL без DEFAULT', sql: 'ALTER TABLE "Book" ADD COLUMN "isbn" TEXT NOT NULL;', expect: ['ADD COLUMN NOT NULL'] },
  { name: 'ADD COLUMN NOT NULL с DEFAULT проходит', sql: "ALTER TABLE \"Book\" ADD COLUMN \"isbn\" TEXT NOT NULL DEFAULT '';", expect: [] },
  { name: 'CREATE UNIQUE INDEX', sql: 'CREATE UNIQUE INDEX "Book_slug_key" ON "Book"("slug");', expect: ['CREATE UNIQUE INDEX'] },
  { name: 'обычный CREATE INDEX проходит', sql: 'CREATE INDEX "Book_slug_idx" ON "Book"("slug");', expect: [] },
  { name: 'ADD CONSTRAINT CHECK', sql: 'ALTER TABLE "Book" ADD CONSTRAINT "c" CHECK ("x" > 0);', expect: ['ADD CONSTRAINT'] },
  { name: 'DROP INDEX', sql: 'DROP INDEX "Book_slug_key";', expect: ['DROP INDEX'] },
  { name: 'DROP CONSTRAINT без пересоздания', sql: 'ALTER TABLE "Book" DROP CONSTRAINT "b_fkey";', expect: ['DROP CONSTRAINT'] },
  {
    name: 'DROP CONSTRAINT с пересозданием того же имени проходит',
    sql: 'ALTER TABLE "Book" DROP CONSTRAINT IF EXISTS "b_fkey";\nALTER TABLE "Book" ADD CONSTRAINT "b_fkey" FOREIGN KEY ("y") REFERENCES "Y"("id") ON DELETE CASCADE;',
    expect: [],
  },
  {
    name: 'DROP CONSTRAINT с пересозданием ДРУГОГО имени краснеет',
    sql: 'ALTER TABLE "Book" DROP CONSTRAINT "old_fkey";\nALTER TABLE "Book" ADD CONSTRAINT "new_fkey" FOREIGN KEY ("y") REFERENCES "Y"("id");',
    expect: ['ADD CONSTRAINT', 'DROP CONSTRAINT'],
  },
  { name: 'TRUNCATE', sql: 'TRUNCATE "Comment";', expect: ['TRUNCATE'] },
  { name: 'DELETE FROM', sql: 'DELETE FROM "Comment" WHERE "x" IS NULL;', expect: ['DELETE FROM'] },
  { name: 'нижний регистр ловится так же', sql: 'alter table "Book" drop column "subtitle";', expect: ['DROP COLUMN'] },
  { name: 'перенос строки внутри конструкции не спасает', sql: 'ALTER TABLE "Book"\n  DROP\n  COLUMN "subtitle";', expect: ['DROP COLUMN'] },
  { name: 'находка в строчном комментарии не считается', sql: '-- ALTER TABLE "Book" DROP COLUMN "x";\n' + OK, expect: [] },
  { name: 'находка в блочном комментарии не считается', sql: '/* ALTER TABLE "Book" DROP COLUMN "x"; */\n' + OK, expect: [] },
  {
    name: '`--` внутри строкового литерала комментарий не открывает',
    sql: 'INSERT INTO "Setting" VALUES (\'a--b\');\nALTER TABLE "Book" DROP COLUMN "x";',
    expect: ['DROP COLUMN'],
  },
  {
    name: 'DDL внутри $$-блока считается',
    sql: 'DO $$ BEGIN ALTER TABLE "Book" DROP COLUMN "x"; END $$;',
    expect: ['DROP COLUMN'],
  },
  {
    name: 'DDL внутри идемпотентного IF NOT EXISTS считается',
    sql: 'DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class) THEN ALTER TABLE "Book" DROP COLUMN "x"; END IF; END $$;',
    expect: ['DROP COLUMN'],
  },
  {
    name: 'точка с запятой внутри $$-блока не рвёт внешний оператор',
    sql: 'DO $$ BEGIN PERFORM 1; END $$;\nDROP TABLE "Y";',
    expect: ['DROP TABLE'],
  },
];

const REPO_CASES = [
  {
    name: 'исключение для несуществующей миграции краснеет',
    migrations: { '20260101000000_clean': OK },
    allowed: { '20260101000000_gone': { reason: 'её нет в каталоге', constructs: ['DROP COLUMN'] } },
    expect: ['allowlist-orphan:20260101000000_gone'],
  },
  {
    name: 'исключение для чистой миграции краснеет',
    migrations: { '20260101000000_clean': OK },
    allowed: { '20260101000000_clean': { reason: 'на всякий случай', constructs: ['DROP COLUMN'] } },
    expect: ['allowlist-stale:20260101000000_clean'],
  },
  {
    name: 'исключение без внятной причины краснеет',
    migrations: { '20260101000000_drop': 'ALTER TABLE "Book" DROP COLUMN "x";' },
    allowed: { '20260101000000_drop': { reason: '-', constructs: ['DROP COLUMN'] } },
    expect: ['allowlist-no-reason:20260101000000_drop'],
  },
  {
    name: 'исключение на перечисленные конструкции пропускает только их',
    migrations: { '20260101000000_two': 'ALTER TABLE "Book" DROP COLUMN "x";\nDROP TABLE "Y";' },
    allowed: { '20260101000000_two': { reason: 'применена на проде 01.01.2026', constructs: ['DROP COLUMN'] } },
    expect: ['destructive:20260101000000_two'],
  },
  {
    name: 'исключение шире факта краснеет',
    migrations: { '20260101000000_one': 'ALTER TABLE "Book" DROP COLUMN "x";' },
    allowed: { '20260101000000_one': { reason: 'применена на проде 01.01.2026', constructs: ['DROP COLUMN', 'DROP TABLE'] } },
    expect: ['allowlist-unused:20260101000000_one'],
  },
  {
    name: 'разрешённая миграция целиком проходит',
    migrations: { '20260101000000_one': 'ALTER TABLE "Book" DROP COLUMN "x";' },
    allowed: { '20260101000000_one': { reason: 'применена на проде 01.01.2026', constructs: ['DROP COLUMN'] } },
    expect: [],
  },
  {
    name: 'несколько миграций разбираются каждая',
    migrations: { '20260101000000_a': OK, '20260102000000_b': 'DROP TABLE "Y";' },
    allowed: {},
    expect: ['destructive:20260102000000_b'],
  },
];

function buildFixture(caseDef) {
  const root = mkdtempSync(join(tmpdir(), 'migcompat-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', ALLOWLIST_NAME), JSON.stringify({ allowed: caseDef.allowed }, null, 2));
  for (const [name, sql] of Object.entries(caseDef.migrations)) {
    mkdirSync(join(root, 'prisma', 'migrations', name), { recursive: true });
    writeFileSync(join(root, 'prisma', 'migrations', name, 'migration.sql'), `${sql}\n`);
  }
  return root;
}

function runSelfTest() {
  let failed = 0;
  const report = (name, expected, actual) => {
    const e = [...expected].sort().join(', ') || '(none)';
    const a = [...actual].sort().join(', ') || '(none)';
    if (e === a) {
      console.log(`  ok   ${name}`);
      return;
    }
    failed += 1;
    console.log(`  FAIL ${name}\n         expected: ${e}\n         actual:   ${a}`);
  };

  for (const c of CASES) report(c.name, c.expect, destructiveIn(c.sql));

  for (const c of REPO_CASES) {
    const root = buildFixture(c);
    try {
      report(c.name, c.expect, checkRepo(root).problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const total = CASES.length + REPO_CASES.length;
  console.log('');
  if (failed) {
    console.log(`RESULT: self-test failed (${failed}/${total} cases)`);
    return 1;
  }
  console.log(`RESULT: self-test passed (${total} cases)`);
  return 0;
}

/* ---------------- entry point ---------------- */

// Точка входа выполняется только при прямом запуске: без этой проверки любой `import`
// помощников попутно прогонял бы весь репозиторий и мог убить процесс через `process.exit`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    process.exit(runSelfTest());
  }

  const { problems, out } = checkRepo(argv.find((a) => !a.startsWith('--')) || DEFAULT_REPO);
  console.log(out.join('\n'));

  if (problems.length) {
    console.log(`RESULT: BACKWARDS-INCOMPATIBLE MIGRATION (${problems.join(', ')})`);
    console.log('');
    console.log('Такая миграция ломает предыдущий образ, а откат в этом проекте откатывает образ,');
    console.log('а не схему — см. ADR-018. Разнесите изменение на два релиза: сначала расширение,');
    console.log(`потом сжатие. Если это уже на проде — впишите миграцию в scripts/${ALLOWLIST_NAME},`);
    console.log('перечислив ровно те конструкции, которые в ней есть, и назвав причину.');
    process.exit(1);
  }

  console.log('RESULT: every migration keeps the previous image working');
}
