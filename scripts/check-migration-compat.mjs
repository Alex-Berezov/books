#!/usr/bin/env node
// Migration compatibility check: does every migration leave the previous image working?
//
// ADR-018. A release now carries everything merged since the previous tag (LEGACY-241), and
// `prisma migrate deploy` applies the directories one by one without wrapping the set in a
// transaction. A failure on the fifth migration of seven leaves four applied. That is only
// survivable while the previous image still runs against the new schema — which is exactly
// what a destructive statement takes away. Rollback in this project rolls back the *image*,
// never the schema (ADR-018), so this check is what makes rollback meaningful at all.
//
// Destructive here means: the old code stops working the moment the statement lands. Dropping
// a column or table, renaming either, narrowing a type, adding NOT NULL without a default,
// dropping a constraint the old code relies on. Such a change is two releases, not one:
// first expand (add, write both ways), then contract (stop reading, drop) — with a tag in
// between, so the intermediate state is what production actually ran.
//
// Pure Node (>= 20), no dependencies, read-only.
//
// Usage:
//   node scripts/check-migration-compat.mjs [repoDir]
//   node scripts/check-migration-compat.mjs --self-test
//
// Exit code: 0 — every migration is backwards compatible or explicitly allowlisted;
//            1 — a destructive statement outside the allowlist, or the allowlist itself is stale.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = join(SCRIPT_DIR, '..');
const ALLOWLIST_NAME = 'migration-compat-allowlist.json';

/**
 * Разрушающие конструкции. Пробелы в шаблонах — `\s+`, потому что `migration.sql` пишутся
 * руками (ADR-011) и перенос строки внутри `ALTER TABLE ... DROP\n  COLUMN` встречается.
 */
const DESTRUCTIVE = [
  { id: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/i },
  { id: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { id: 'RENAME COLUMN', re: /\bRENAME\s+COLUMN\b/i },
  { id: 'RENAME TO', re: /\bRENAME\s+TO\b/i },
  { id: 'SET NOT NULL', re: /\bSET\s+NOT\s+NULL\b/i },
  { id: 'DROP CONSTRAINT', re: /\bDROP\s+CONSTRAINT\b/i },
  { id: 'ALTER COLUMN ... TYPE', re: /\bALTER\s+(?:COLUMN\s+)?"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i },
];

/**
 * SQL без комментариев. Посимвольно, а не регуляркой: `--` внутри строкового литерала
 * комментарием не является, и вырезание по регулярке съело бы половину запроса.
 * Долларовые кавычки (`$$ ... $$`) в проекте несут идемпотентные `DO`-блоки.
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
      // Тело `$$ ... $$` разбирается наравне с остальным: идемпотентные блоки в проекте
      // содержат настоящий DDL, и `DROP COLUMN` внутри такого блока — тот же дефект.
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Разрушающие конструкции файла, по идентификаторам, без повторов и в порядке объявления. */
export function destructiveIn(sql) {
  const text = stripSqlComments(sql);
  return DESTRUCTIVE.filter((d) => d.re.test(text)).map((d) => d.id);
}

/** Каталоги миграций по алфавиту — это же и хронологический порядок Prisma. */
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
  if (!existsSync(path)) return { path, entries: {} };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return { path, entries: raw.allowed ?? {} };
}

export function checkRepo(repo) {
  const problems = [];
  const out = [];
  const names = migrationNames(repo);
  const { entries } = readAllowlist(repo);

  out.push(`migrations: ${names.length}, allowlisted: ${Object.keys(entries).length}`);

  const destructiveByName = new Map();
  for (const name of names) {
    const sql = readFileSync(join(repo, 'prisma', 'migrations', name, 'migration.sql'), 'utf8');
    const found = destructiveIn(sql);
    if (found.length) destructiveByName.set(name, found);
  }

  for (const [name, found] of destructiveByName) {
    if (name in entries) continue;
    problems.push(`destructive:${name}`);
    out.push(`  ✗ ${name}: ${found.join(', ')}`);
  }

  // 🔴 Список исключений краснеет в обе стороны. Запись про миграцию, которой больше нет,
  // и запись про миграцию без разрушающих конструкций — обе ошибки: иначе список
  // превращается в свалку, куда дописывают «на всякий случай», и правило умирает молча.
  const known = new Set(names);
  for (const name of Object.keys(entries)) {
    if (!known.has(name)) {
      problems.push(`allowlist-orphan:${name}`);
      out.push(`  ✗ allowlist: миграции \`${name}\` нет в prisma/migrations`);
      continue;
    }
    if (!destructiveByName.has(name)) {
      problems.push(`allowlist-stale:${name}`);
      out.push(`  ✗ allowlist: в \`${name}\` нет разрушающих конструкций — запись лишняя`);
      continue;
    }
    const reason = entries[name];
    if (typeof reason !== 'string' || reason.trim() === '') {
      problems.push(`allowlist-no-reason:${name}`);
      out.push(`  ✗ allowlist: у \`${name}\` пустая причина`);
    }
  }

  return { problems, out };
}

/* ---------------- self-test ---------------- */

const CLEAN = 'ALTER TABLE "Book" ADD COLUMN "subtitle" TEXT;\n';
const DROPPING = 'ALTER TABLE "Book" DROP COLUMN "subtitle";\n';
const COMMENTED = '-- ALTER TABLE "Book" DROP COLUMN "subtitle";\nALTER TABLE "Book" ADD COLUMN "x" TEXT;\n';

const SELF_TEST_CASES = [
  { name: 'чистая миграция проходит', migrations: { '20260101000000_clean': CLEAN }, allowed: {}, expect: [] },
  {
    name: 'DROP COLUMN краснеет',
    migrations: { '20260101000000_drop': DROPPING },
    allowed: {},
    expect: ['destructive:20260101000000_drop'],
  },
  {
    name: 'DROP COLUMN в исключениях проходит',
    migrations: { '20260101000000_drop': DROPPING },
    allowed: { '20260101000000_drop': 'уже на проде' },
    expect: [],
  },
  {
    name: 'исключение для несуществующей миграции краснеет',
    migrations: { '20260101000000_clean': CLEAN },
    allowed: { '20260101000000_gone': 'её нет' },
    expect: ['allowlist-orphan:20260101000000_gone'],
  },
  {
    name: 'исключение для чистой миграции краснеет',
    migrations: { '20260101000000_clean': CLEAN },
    allowed: { '20260101000000_clean': 'на всякий случай' },
    expect: ['allowlist-stale:20260101000000_clean'],
  },
  {
    name: 'DROP COLUMN внутри комментария не краснеет',
    migrations: { '20260101000000_commented': COMMENTED },
    allowed: {},
    expect: [],
  },
  {
    name: 'исключение без причины краснеет',
    migrations: { '20260101000000_drop': DROPPING },
    allowed: { '20260101000000_drop': '   ' },
    expect: ['allowlist-no-reason:20260101000000_drop'],
  },
  {
    name: 'SET NOT NULL краснеет',
    migrations: { '20260101000000_notnull': 'ALTER TABLE "Book" ALTER COLUMN "slug" SET NOT NULL;\n' },
    allowed: {},
    expect: ['destructive:20260101000000_notnull'],
  },
  {
    name: 'перенос строки внутри конструкции не спасает',
    migrations: { '20260101000000_wrapped': 'ALTER TABLE "Book"\n  DROP\n  COLUMN "subtitle";\n' },
    allowed: {},
    expect: ['destructive:20260101000000_wrapped'],
  },
];

function buildFixture(caseDef) {
  const root = mkdtempSync(join(tmpdir(), 'migcompat-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', ALLOWLIST_NAME),
    JSON.stringify({ allowed: caseDef.allowed }, null, 2),
  );
  for (const [name, sql] of Object.entries(caseDef.migrations)) {
    mkdirSync(join(root, 'prisma', 'migrations', name), { recursive: true });
    writeFileSync(join(root, 'prisma', 'migrations', name, 'migration.sql'), sql);
  }
  return root;
}

function runSelfTest() {
  let failed = 0;
  for (const caseDef of SELF_TEST_CASES) {
    const { problems } = checkRepo(buildFixture(caseDef));
    const expected = [...caseDef.expect].sort().join(', ') || '(none)';
    const actual = [...problems].sort().join(', ') || '(none)';
    if (expected === actual) {
      console.log(`  ok   ${caseDef.name}`);
    } else {
      failed++;
      console.log(`  FAIL ${caseDef.name}\n         expected: ${expected}\n         actual:   ${actual}`);
    }
  }
  console.log('');
  if (failed) {
    console.log(`RESULT: self-test failed (${failed}/${SELF_TEST_CASES.length} cases)`);
    return 1;
  }
  console.log(`RESULT: self-test passed (${SELF_TEST_CASES.length} cases)`);
  return 0;
}

/* ---------------- entry point ---------------- */

const argv = process.argv.slice(2);
const selfTest = argv.includes('--self-test');
const repo = argv.find((a) => !a.startsWith('--')) || DEFAULT_REPO;

if (selfTest) {
  process.exit(runSelfTest());
}

const { problems, out } = checkRepo(repo);
console.log(out.join('\n'));

if (problems.length) {
  console.log(`RESULT: BACKWARDS-INCOMPATIBLE MIGRATION (${problems.join(', ')})`);
  console.log('');
  console.log('Такая миграция ломает предыдущий образ, а откат в этом проекте откатывает образ,');
  console.log('а не схему — см. ADR-018. Разнесите изменение на два релиза: сначала расширение,');
  console.log('потом сжатие. Если это уже на проде — впишите миграцию в scripts/' + ALLOWLIST_NAME);
  console.log('с причиной, и только её.');
  process.exit(1);
}

console.log('RESULT: every migration keeps the previous image working');
