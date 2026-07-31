#!/usr/bin/env node
// Drift check: does the sum of hand-written SQL migrations equal prisma/schema.prisma?
//
// There is no local database (ADR-011): `prisma migrate` never runs here, migrations are
// written by hand and applied by a human on the VPS. Nothing else compares the two sources,
// and a divergence surfaces only as a runtime failure in production while typecheck stays green.
//
// Pure Node (>= 20), no dependencies, read-only.
//
// Usage:
//   node scripts/drift-check.mjs [repoDir] [--allow-unparsed]
//   node scripts/drift-check.mjs --self-test
//
// Exit code: 0 — schema and migrations agree; 1 — drift detected or SQL left unparsed.

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = join(SCRIPT_DIR, '..');

const SCALARS = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);

/* ---------------- parse schema.prisma ---------------- */

function parseSchema(text) {
  const models = new Map(); // name -> string[] (raw lines)
  const enums = new Map(); // name -> Set(values)
  const lines = text.split(/\r?\n/);

  // pass 1: enum names (needed to classify fields as columns)
  let cur = null,
    kind = null;
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (kind === null) {
      let m = /^enum\s+(\w+)\s*\{/.exec(line);
      if (m) {
        kind = 'enum';
        cur = m[1];
        enums.set(cur, new Set());
        continue;
      }
      m = /^model\s+(\w+)\s*\{/.exec(line);
      if (m) {
        kind = 'model';
        cur = m[1];
        models.set(cur, []);
        continue;
      }
      continue;
    }
    if (line === '}') {
      kind = null;
      cur = null;
      continue;
    }
    if (kind === 'enum') {
      const m = /^(\w+)/.exec(line);
      if (m) enums.get(cur).add(m[1]);
    } else {
      models.get(cur).push(line);
    }
  }

  // pass 2: classify model fields into columns
  const modelCols = new Map();
  for (const [name, fieldLines] of models) {
    const cols = new Set();
    let table = name;
    for (const line of fieldLines) {
      if (line.startsWith('@@')) {
        const tm = /^@@map\(\s*"([^"]+)"\s*\)/.exec(line);
        if (tm) table = tm[1];
        continue;
      }
      if (line.startsWith('@')) continue;
      const m = /^(\w+)\s+([\w.]+)(\[\])?(\?)?/.exec(line);
      if (!m) continue;
      const [, field, type, isList] = m;
      const base = type;
      const isScalar = SCALARS.has(base);
      const isEnum = enums.has(base);
      if (!isScalar && !isEnum) continue; // relation field -> no column
      if (
        isList &&
        !isEnum &&
        base !== 'String' &&
        base !== 'Int' &&
        base !== 'Float' &&
        base !== 'Boolean' &&
        base !== 'DateTime' &&
        base !== 'Decimal' &&
        base !== 'BigInt' &&
        base !== 'Bytes' &&
        base !== 'Json'
      )
        continue;
      const mapped = /@map\(\s*"([^"]+)"\s*\)/.exec(line);
      cols.add(mapped ? mapped[1] : field);
    }
    modelCols.set(table, cols);
  }
  return { models: modelCols, enums };
}

/* ---------------- parse migrations ---------------- */

function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  let inS = false,
    inD = false;
  while (i < sql.length) {
    const c = sql[i],
      n = sql[i + 1];
    if (!inS && !inD && c === '-' && n === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (!inS && !inD && c === '/' && n === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (!inD && c === "'") inS = !inS;
    else if (!inS && c === '"') inD = !inD;
    out += c;
    i++;
  }
  return out;
}

// Rights migrations wrap idempotent DDL in `DO $$ BEGIN IF NOT EXISTS (...) THEN ... END IF; END $$;`.
// Inline those bodies as plain SQL so the DDL inside them is seen.
function inlineDoBlocks(sql) {
  return sql.replace(/\bDO\s+(\$\w*\$)([\s\S]*?)\1/gi, (_m, _tag, body) => {
    let b = body;
    // Order matters: close-tokens first, otherwise `END IF;` is itself matched as `IF ... THEN`
    // and swallows the following statement up to the next THEN.
    b = b.replace(/\bEND\s+IF\s*;/gi, ' ');
    b = b.replace(/\bEND\s+LOOP\s*;/gi, ' ');
    b = b.replace(/\bEXCEPTION\s+WHEN\b[^;]*;/gi, ' ');
    b = b.replace(/\bRAISE\s+(NOTICE|WARNING|EXCEPTION)\b[^;]*;/gi, ' ');
    b = b.replace(/\bDECLARE\b[^;]*;/gi, ' ');
    b = b.replace(/\bEXECUTE\b[^;]*;/gi, ' ');
    // `[^;]*?` keeps guard conditions from crossing a statement boundary
    b = b.replace(/\bELSIF\b[^;]*?\bTHEN\b/gi, ' ');
    b = b.replace(/\bIF\b[^;]*?\bTHEN\b/gi, ' ');
    b = b.replace(/\bELSE\b/gi, ' ');
    b = b.replace(/\bBEGIN\b/gi, ' ');
    b = b.replace(/\bEND\s*;/gi, ' ');
    b = b.replace(/\bEND\s*$/i, ' ');
    return `\n${b}\n`;
  });
}

function splitStatements(sql) {
  const stmts = [];
  let cur = '',
    inS = false,
    inD = false,
    dollar = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (dollar) {
      cur += c;
      if (sql.startsWith(dollar, i)) {
        cur += sql.slice(i + 1, i + dollar.length);
        i += dollar.length - 1;
        dollar = null;
      }
      continue;
    }
    const dm = /^\$\w*\$/.exec(sql.slice(i));
    if (!inS && !inD && dm) {
      dollar = dm[0];
      cur += dollar;
      i += dollar.length - 1;
      continue;
    }
    if (!inD && c === "'") inS = !inS;
    else if (!inS && c === '"') inD = !inD;
    if (c === ';' && !inS && !inD) {
      stmts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) stmts.push(cur);
  return stmts.map((s) => s.trim()).filter(Boolean);
}

function splitTopLevelCommas(s) {
  const parts = [];
  let cur = '',
    depth = 0,
    inS = false,
    inD = false;
  for (const c of s) {
    if (!inD && c === "'") inS = !inS;
    else if (!inS && c === '"') inD = !inD;
    if (!inS && !inD) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const CONSTRAINT_START = /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE|LIKE)\b/i;

function applyMigrations(migDir) {
  const tables = new Map(); // name -> Set(columns)
  const enums = new Map(); // name -> Set(values)
  const dirs = existsSync(migDir)
    ? readdirSync(migDir)
        .filter((d) => existsSync(join(migDir, d, 'migration.sql')))
        .sort()
    : [];
  const unhandled = [];

  for (const dir of dirs) {
    const sql = inlineDoBlocks(
      stripSqlComments(readFileSync(join(migDir, dir, 'migration.sql'), 'utf8')),
    );
    for (const stmt of splitStatements(sql)) {
      const s = stmt.replace(/\s+/g, ' ').trim();
      let m;

      if ((m = /^CREATE\s+TYPE\s+(?:"?\w+"?\.)?"?(\w+)"?\s+AS\s+ENUM\s*\(([\s\S]*)\)$/i.exec(s))) {
        const vals = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
        enums.set(m[1], new Set(vals));
        continue;
      }
      if (
        (m =
          /^ALTER\s+TYPE\s+(?:"?\w+"?\.)?"?(\w+)"?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']*)'/i.exec(
            s,
          ))
      ) {
        if (!enums.has(m[1])) enums.set(m[1], new Set());
        enums.get(m[1]).add(m[2]);
        continue;
      }
      if (
        (m =
          /^ALTER\s+TYPE\s+(?:"?\w+"?\.)?"?(\w+)"?\s+RENAME\s+TO\s+(?:"?\w+"?\.)?"?(\w+)"?$/i.exec(
            s,
          ))
      ) {
        if (enums.has(m[1])) {
          enums.set(m[2], enums.get(m[1]));
          enums.delete(m[1]);
        }
        continue;
      }
      if (
        (m =
          /^ALTER\s+TYPE\s+(?:"?\w+"?\.)?"?(\w+)"?\s+RENAME\s+VALUE\s+'([^']*)'\s+TO\s+'([^']*)'/i.exec(
            s,
          ))
      ) {
        const e = enums.get(m[1]);
        if (e) {
          e.delete(m[2]);
          e.add(m[3]);
        }
        continue;
      }
      if ((m = /^DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/i.exec(s))) {
        enums.delete(m[1]);
        continue;
      }

      if (
        (m =
          /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?\s*\(([\s\S]*)\)$/i.exec(
            s,
          ))
      ) {
        const cols = new Set();
        for (const part of splitTopLevelCommas(m[2])) {
          if (CONSTRAINT_START.test(part)) continue;
          const cm = /^"([^"]+)"/.exec(part) || /^(\w+)/.exec(part);
          if (cm) cols.add(cm[1]);
        }
        tables.set(m[1], cols);
        continue;
      }
      if ((m = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/i.exec(s))) {
        tables.delete(m[1]);
        continue;
      }

      if ((m = /^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?\w+"?\.)?"?(\w+)"?\s+([\s\S]*)$/i.exec(s))) {
        const table = m[1];
        if (!tables.has(table)) tables.set(table, new Set());
        const cols = tables.get(table);
        const rename = /^RENAME\s+TO\s+(?:"?\w+"?\.)?"?(\w+)"?$/i.exec(m[2]);
        if (rename) {
          tables.set(rename[1], cols);
          tables.delete(table);
          continue;
        }
        for (const action of splitTopLevelCommas(m[2])) {
          let a;
          if ((a = /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i.exec(action))) {
            cols.add(a[1]);
            continue;
          }
          if ((a = /^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i.exec(action))) {
            cols.delete(a[1]);
            continue;
          }
          if ((a = /^RENAME\s+COLUMN\s+"?(\w+)"?\s+TO\s+"?(\w+)"?/i.exec(action))) {
            cols.delete(a[1]);
            cols.add(a[2]);
            continue;
          }
          if (
            /^(ALTER|ADD\s+CONSTRAINT|DROP\s+CONSTRAINT|ENABLE|DISABLE|VALIDATE|ADD\s+PRIMARY|ADD\s+FOREIGN|ADD\s+UNIQUE|ADD\s+CHECK|OWNER|SET|REPLICA)/i.test(
              action,
            )
          )
            continue;
          unhandled.push(`${dir}: ALTER TABLE ${table} :: ${action.slice(0, 90)}`);
        }
        continue;
      }

      if (/^(CREATE|DROP)\s+(UNIQUE\s+)?INDEX/i.test(s)) continue;
      if (
        /^(INSERT|UPDATE|DELETE|SELECT|WITH|COMMENT|SET|BEGIN|COMMIT|DO|GRANT|CREATE\s+(EXTENSION|SCHEMA|FUNCTION|TRIGGER|SEQUENCE|VIEW))/i.test(
          s,
        )
      )
        continue;
      if (/^(DROP\s+(INDEX|FUNCTION|TRIGGER|SEQUENCE|VIEW|CONSTRAINT))/i.test(s)) continue;
      unhandled.push(`${dir}: ${s.slice(0, 110)}`);
    }
  }
  return { tables, enums, unhandled, count: dirs.length };
}

/* ---------------- diff ---------------- */

const setDiff = (a, b) => [...a].filter((x) => !b.has(x));

// Compares a parsed schema against the state the migrations build up.
// Returns the list of problem kinds plus the report lines, so callers decide what to print.
function compare(schema, mig, { allowUnparsed = false } = {}) {
  const problems = [];
  const out = [];

  out.push(`schema.prisma : ${schema.models.size} models, ${schema.enums.size} enums`);
  out.push(
    `migrations    : ${mig.count} dirs -> ${mig.tables.size} tables, ${mig.enums.size} enums`,
  );
  out.push('');

  // tables
  const missingTables = setDiff(new Set(schema.models.keys()), mig.tables);
  const extraTables = setDiff(
    new Set([...mig.tables.keys()].filter((t) => !t.startsWith('_'))),
    new Set(schema.models.keys()),
  );
  if (missingTables.length) {
    problems.push('missing tables');
    out.push(`## TABLES IN SCHEMA BUT NEVER CREATED BY MIGRATIONS (${missingTables.length})`);
    missingTables.forEach((t) => out.push(`  - ${t}`));
    out.push('');
  }
  if (extraTables.length) {
    problems.push('extra tables');
    out.push(`## TABLES CREATED BY MIGRATIONS BUT ABSENT FROM SCHEMA (${extraTables.length})`);
    extraTables.forEach((t) => out.push(`  - ${t}`));
    out.push('');
  }

  // columns
  const colIssues = [];
  for (const [model, cols] of schema.models) {
    const mcols = mig.tables.get(model);
    if (!mcols) continue;
    const missing = setDiff(cols, mcols);
    const extra = setDiff(mcols, cols);
    if (missing.length || extra.length) colIssues.push({ model, missing, extra });
  }
  if (colIssues.length) {
    problems.push('column drift');
    out.push(`## COLUMN DRIFT (${colIssues.length} tables)`);
    for (const { model, missing, extra } of colIssues) {
      out.push(`  ${model}`);
      if (missing.length) out.push(`    MISSING in migrations : ${missing.join(', ')}`);
      if (extra.length) out.push(`    EXTRA   in migrations : ${extra.join(', ')}`);
    }
    out.push('');
  }

  // enums
  const missingEnums = setDiff(new Set(schema.enums.keys()), mig.enums);
  const extraEnums = setDiff(new Set(mig.enums.keys()), new Set(schema.enums.keys()));
  if (missingEnums.length) {
    problems.push('missing enums');
    out.push(`## ENUMS IN SCHEMA BUT NEVER CREATED (${missingEnums.length})`);
    missingEnums.forEach((e) => out.push(`  - ${e}`));
    out.push('');
  }
  if (extraEnums.length) {
    out.push(`## ENUMS CREATED BUT ABSENT FROM SCHEMA (${extraEnums.length})`);
    extraEnums.forEach((e) => out.push(`  - ${e}`));
    out.push('');
  }

  const enumIssues = [];
  for (const [name, vals] of schema.enums) {
    const mvals = mig.enums.get(name);
    if (!mvals) continue;
    const missing = setDiff(vals, mvals);
    const extra = setDiff(mvals, vals);
    if (missing.length || extra.length) enumIssues.push({ name, missing, extra });
  }
  if (enumIssues.length) {
    problems.push('enum value drift');
    out.push(`## ENUM VALUE DRIFT (${enumIssues.length} enums)`);
    for (const { name, missing, extra } of enumIssues) {
      out.push(`  ${name}`);
      if (missing.length) out.push(`    MISSING in migrations : ${missing.join(', ')}`);
      if (extra.length) out.push(`    EXTRA   in migrations : ${extra.join(', ')}`);
    }
    out.push('');
  }

  if (mig.unhandled.length) {
    // Unparsed DDL is not cosmetic: whatever it did to the database is invisible to this
    // comparison, so "agree" would be a claim the script cannot back up.
    if (!allowUnparsed) problems.push('unparsed statements');
    out.push(`## UNPARSED STATEMENTS (${mig.unhandled.length}) — may hide drift`);
    mig.unhandled.slice(0, 40).forEach((u) => out.push(`  ! ${u}`));
    out.push('');
  }

  return { problems: [...new Set(problems)], out };
}

function checkRepo(repo, options) {
  const schema = parseSchema(readFileSync(join(repo, 'prisma/schema.prisma'), 'utf8'));
  const mig = applyMigrations(join(repo, 'prisma/migrations'));
  return compare(schema, mig, options);
}

/* ---------------- self-test ---------------- */

// The failure mode of a checker like this is a silent false "agree": a parser gap turns real
// drift into a green build. These fixtures pin the detection of each drift kind it claims to find.

const FIXTURE_SCHEMA = `
generator client {
  provider = "prisma-client-js"
}

enum Status {
  DRAFT
  PUBLISHED
}

model Book {
  id        String    @id @default(uuid())
  title     String
  status    Status    @default(DRAFT)
  createdAt DateTime  @default(now()) @map("created_at")
  chapters  Chapter[]
}

model Chapter {
  id     String @id
  bookId String @map("book_id")
  book   Book   @relation(fields: [bookId], references: [id])
}
`;

const FIXTURE_MIGRATION = `
-- CreateEnum
CREATE TYPE "Status" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "Book" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" "Status" NOT NULL DEFAULT 'DRAFT',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chapter" (
  "id" TEXT NOT NULL,
  "book_id" TEXT NOT NULL,
  CONSTRAINT "Chapter_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Chapter" ADD CONSTRAINT "Chapter_book_id_fkey"
  FOREIGN KEY ("book_id") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
`;

const SELF_TEST_CASES = [
  {
    name: 'baseline: schema and migrations agree',
    expect: [],
  },
  {
    name: 'column present in schema, never migrated',
    schema: (s) => s.replace('  title     String', '  title     String\n  subtitle  String?'),
    expect: ['column drift'],
  },
  {
    name: 'column added by migration, absent from schema',
    extraMigration: 'ALTER TABLE "Book" ADD COLUMN "legacy_note" TEXT;',
    expect: ['column drift'],
  },
  {
    name: 'model present in schema, never migrated',
    schema: (s) => `${s}\nmodel Tag {\n  id String @id\n}\n`,
    expect: ['missing tables'],
  },
  {
    name: 'table created by migration, absent from schema',
    extraMigration: 'CREATE TABLE "Orphan" (\n  "id" TEXT NOT NULL\n);',
    expect: ['extra tables'],
  },
  {
    name: 'enum value present in schema, never migrated',
    schema: (s) => s.replace('  PUBLISHED', '  PUBLISHED\n  ARCHIVED'),
    expect: ['enum value drift'],
  },
  {
    name: 'enum value added by migration, absent from schema',
    extraMigration: `ALTER TYPE "Status" ADD VALUE IF NOT EXISTS 'RETIRED';`,
    expect: ['enum value drift'],
  },
  {
    // Rights migrations wrap DDL in idempotent DO-blocks; if inlining broke, this column would
    // read as missing and every such migration would report false drift.
    name: 'DDL inside an idempotent DO-block is seen',
    schema: (s) => s.replace('  title     String', '  title     String\n  notes     String?'),
    extraMigration: `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Book' AND column_name = 'notes') THEN
    ALTER TABLE "Book" ADD COLUMN "notes" TEXT;
  END IF;
END $$;`,
    expect: [],
  },
  {
    name: 'statement the parser does not understand is reported, not ignored',
    extraMigration: 'TRUNCATE TABLE "Book" RESTART IDENTITY;',
    expect: ['unparsed statements'],
  },
];

function buildFixture(caseDef) {
  const root = mkdtempSync(join(tmpdir(), 'drift-check-'));
  const migDir = join(root, 'prisma', 'migrations');
  mkdirSync(join(migDir, '20260101000000_init'), { recursive: true });
  writeFileSync(
    join(root, 'prisma', 'schema.prisma'),
    caseDef.schema ? caseDef.schema(FIXTURE_SCHEMA) : FIXTURE_SCHEMA,
  );
  writeFileSync(join(migDir, '20260101000000_init', 'migration.sql'), FIXTURE_MIGRATION);
  if (caseDef.extraMigration) {
    mkdirSync(join(migDir, '20260102000000_extra'), { recursive: true });
    writeFileSync(join(migDir, '20260102000000_extra', 'migration.sql'), caseDef.extraMigration);
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
      console.log(
        `  FAIL ${caseDef.name}\n         expected: ${expected}\n         actual:   ${actual}`,
      );
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
const allowUnparsed = argv.includes('--allow-unparsed');
const selfTest = argv.includes('--self-test');
const repo = argv.find((a) => !a.startsWith('--')) || DEFAULT_REPO;

if (selfTest) {
  process.exit(runSelfTest());
}

const { problems, out } = checkRepo(repo, { allowUnparsed });
console.log(out.join('\n'));

if (problems.length) {
  console.log(`RESULT: DRIFT DETECTED (${problems.join(', ')})`);
  console.log('');
  console.log('schema.prisma and the hand-written migrations describe different databases.');
  console.log('Fix the migration (or the schema) before this reaches the VPS — see ADR-011.');
  process.exit(1);
}

console.log('RESULT: schema and migrations agree');
