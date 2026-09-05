#!/usr/bin/env node
// Drift check: does the sum of hand-written SQL migrations equal prisma/schema.prisma —
// and do the raw SQL templates in src/ still name tables and columns that exist there?
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
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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
  // column -> enum name, for columns whose type is one of the enums collected in pass 1.
  // LEGACY-252: this is the map the third pass (raw SQL) needs to tell an enum-typed column
  // from any other, so a string literal compared against it can be checked against real values.
  const colEnumTypes = new Map();
  for (const [name, fieldLines] of models) {
    const cols = new Set();
    const enumCols = new Map();
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
      const col = mapped ? mapped[1] : field;
      cols.add(col);
      if (isEnum && !isList) enumCols.set(col, base);
    }
    modelCols.set(table, cols);
    colEnumTypes.set(table, enumCols);
  }
  return { models: modelCols, enums, colEnumTypes };
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
  const schemaVsMigrations = compare(schema, mig, options);
  // Third source of the same names: the raw SQL templates in src/ (LEGACY-123).
  const rawSql = checkRawSql(repo, schema);
  return {
    problems: [...new Set([...schemaVsMigrations.problems, ...rawSql.problems])],
    out: [...schemaVsMigrations.out, ...rawSql.out],
  };
}

/* ---------------- raw SQL identifiers ---------------- */

// Third pass (LEGACY-123). Values inside `$queryRaw` are parameterised, so this is not about
// injection: the table and column names there exist only as characters inside a template string.
// `tsc` does not look inside the template and `prisma generate` types delegates, not raw SQL, so a
// column renamed by a hand-written migration keeps typecheck, lint and tests green and fails at
// runtime on a public route. This pass resolves every identifier of those templates against
// schema.prisma — the same source the two passes above already agree on.
//
// What is checked, and what deliberately is not:
//   checked     — quoted table names after FROM/JOIN/INTO/UPDATE, qualified references
//                 (`bv.status`, `bc."categoryId"`), bare quoted identifiers (`"timestamp"`),
//                 and casts to a quoted type (`${lang}::"Language"`, `CAST(x AS "Language")`);
//   not checked — bare UNQUOTED words (`date`, `count`, `date_trunc`). Telling a column from a
//                 function or a keyword there needs an SQL grammar, and guessing produces noise —
//                 which is exactly how a checker teaches people to ignore its output (LEGACY-045).
//   not read    — `test/**`. Its `$queryRawUnsafe` calls build SQL as strings, and fixtures there
//                 fail loudly in the e2e run rather than silently in production.
//   checked     — the VALUES compared against an enum-typed column: `bv.status = 'published'`
//                 and `bv.status IN ('published', 'draft')`. Resolved the same way as an
//                 identifier — through the alias this file's queries bind — then the literal is
//                 checked against the enum's current values via `parseSchema`'s column->enum map
//                 (LEGACY-252, see `checkEnumLiterals` below). A literal compared against a
//                 non-enum column is left alone: this is not a general string-literal check.
//
// 🔴 Two rules shape the design, and three rounds of review were spent learning both.
//
// 1. **Nothing is skipped silently.** A construct the parser cannot resolve — an alias no query
//    binds, SQL built as a string, a template whose tag does not parse — is printed and fails the
//    run. A green line must mean "read and resolved", never "not understood".
// 2. **A name is resolved inside its own query, not its own file.** Aliases, CTE names and output
//    aliases all live per template. Resolving them per file was the source of half the findings:
//    one CTE named `c` switched off checking for every other `c` in the service, an output alias
//    in one method hid a renamed column in another, and two correct queries reusing the letter
//    `b` for different tables failed the build.
//
// The one place where per-file resolution stays is a FRAGMENT: `Prisma.sql` pieces such as
// `t."authorId" IN (${...})` name no table of their own, and the query they are spliced into
// lives elsewhere in the file. For those — and only those — the aliases and tables of the whole
// file are used, and a name that fits ANY of them is accepted. That is a real weak spot, and it
// is the smallest one available without following values across functions.

// Tag of a raw SQL template. The template is found by scanning from the tag (see extractTemplates):
// a regex cannot tell `$queryRaw<T>\`…\`` from `$queryRaw<T>(stmt)` without balancing the angles.
const RAW_SQL_TAG = /(?:\$queryRaw|\$executeRaw|Prisma\.sql)(?![A-Za-z0-9_])/g;
// SQL this pass cannot read at all: built as a string, not as a template. Reported rather than
// passed over — the checker must not claim to cover what it never saw.
const RAW_SQL_OPAQUE = /\$(?:queryRaw|executeRaw)Unsafe(?![A-Za-z0-9_])|Prisma\.raw(?![A-Za-z0-9_])/g;

// Directories that hold TypeScript with raw SQL. `prisma/scripts/**` is here because it does:
// a maintenance script naming "BookVersion" columns breaks by exactly the same rename.
const SOURCE_ROOTS = ['src', 'prisma', 'libs'];

const TABLE_INTRO = new Set(['from', 'join', 'into', 'update', 'using']);

// Functions whose ARGUMENTS use SQL keywords as syntax: `EXTRACT(EPOCH FROM x)`,
// `SUBSTRING(x FROM 1 FOR 2)`, `CAST(x AS "T")`. Inside them `FROM` does not introduce a relation
// and `AS` does not name an output column, so the ordinary rules have to stand down.
const SYNTAX_FUNCTIONS = new Set(['extract', 'substring', 'trim', 'position', 'overlay', 'cast']);

// Words that may stand where an alias would, but never are one.
const SQL_KEYWORDS = new Set([
  'on', 'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'except', 'intersect',
  'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'lateral', 'using', 'set', 'values',
  'as', 'and', 'or', 'returning', 'select', 'from', 'into', 'update', 'delete', 'insert', 'when',
  'then', 'else', 'end', 'for', 'with', 'distinct', 'asc', 'desc', 'not', 'in', 'is', 'null',
  'case', 'all', 'any', 'exists', 'between', 'like', 'ilike', 'default', 'do', 'nothing',
  'window', 'over', 'filter', 'within', 'at', 'time', 'zone', 'collate', 'natural', 'tablesample',
  'fetch', 'only', 'rows', 'row', 'first', 'next', 'conflict', 'by', 'recursive', 'of',
  'ordinality', 'materialized', 'share', 'nowait', 'skip', 'locked',
]);

// Types that are not enums of the schema and still legal after a cast: Postgres base types.
// Anything else quoted after `::` or `CAST(… AS …)` is either an enum or a row type of a model.
const BUILTIN_TYPES = new Set([
  'text', 'varchar', 'char', 'bpchar', 'int', 'int2', 'int4', 'int8', 'integer', 'bigint',
  'smallint', 'numeric', 'decimal', 'real', 'float4', 'float8', 'double precision', 'bool',
  'boolean', 'date', 'time', 'timestamp', 'timestamptz', 'timetz', 'interval', 'uuid', 'json',
  'jsonb', 'bytea', 'money', 'inet', 'cidr', 'macaddr', 'tsvector', 'tsquery', 'xml', 'oid',
]);

// `EXCLUDED` in `ON CONFLICT ... DO UPDATE SET x = EXCLUDED.x` is a pseudo-relation with the
// columns of the target table, not an alias anybody declares.
const PSEUDO_RELATION = 'excluded';

// The first word of a complete statement.
const STATEMENT_HEADS = new Set(['select', 'insert', 'update', 'delete', 'with', 'merge']);

function listSourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'migrations') continue;
      out.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !/\.(spec|e2e-spec)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

const lineOf = (code, index) => {
  let line = 1;
  for (let i = 0; i < index; i++) if (code[i] === '\n') line++;
  return line;
};

const newlinesIn = (code, from, to) => {
  let n = '';
  for (let i = from; i < to && i < code.length; i++) if (code[i] === '\n') n += '\n';
  return n;
};

function skipJsString(code, i) {
  const quote = code[i];
  i++;
  while (i < code.length) {
    if (code[i] === '\\') {
      i += 2;
      continue;
    }
    if (code[i] === quote) return i + 1;
    i++;
  }
  return i;
}

// Reads a template literal from the backtick at `start`, replacing every `${...}` with a lone `?`
// plus the newlines it spanned. The interpolations are parameters (`Prisma.join`, values); their
// contents are TypeScript, not SQL. Keeping their newlines is what makes the reported line numbers
// point at the SQL and not somewhere above it.
function readTemplate(code, start) {
  let text = '';
  let i = start + 1;
  while (i < code.length) {
    const c = code[i];
    if (c === '\\') {
      text += ' ';
      i += 2;
      continue;
    }
    if (c === '`') return { text, end: i + 1 };
    if (c === '$' && code[i + 1] === '{') {
      const from = i;
      let depth = 1;
      i += 2;
      while (i < code.length && depth > 0) {
        const d = code[i];
        if (d === '{') depth++;
        else if (d === '}') depth--;
        else if (d === "'" || d === '"' || d === '`') {
          i = skipJsString(code, i);
          continue;
        }
        i++;
      }
      text += ` ? ${newlinesIn(code, from, i)}`;
      continue;
    }
    text += c;
    i++;
  }
  return { text, end: i };
}

// End of a JavaScript regex literal starting at `i`, or -1 when it does not look like one.
// Needed because `s.replace(/'/g, "''")` is a quote-escaping helper — the kind of code that sits
// right next to raw SQL — and reading its `'` as the start of a string blanks the rest of the file.
function skipRegexLiteral(code, i) {
  let inClass = false;
  let j = i + 1;
  while (j < code.length) {
    const c = code[j];
    if (c === '\n') return -1;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j + 1;
    j++;
  }
  return -1;
}

// A `/` starts a regex only where a value may start. After a name, a number or a closing bracket
// it is division — unless that name is a keyword: `return /['"]/.test(s)` is a regex, and reading
// its quote as the start of a string blanks the rest of the file.
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'await', 'yield', 'new', 'delete', 'void', 'instanceof',
  'do', 'else', 'throw',
]);
const REGEX_MAY_START_AFTER = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^',
  '<', '>', '\n',
]);

// Blanks out JavaScript comments, string literals and regex literals, keeping every offset and
// newline in place. Without it a commented-out query is checked as if it ran, and the word
// `$queryRawUnsafe` in a comment fails the build.
//
// Two modes, because the file has to be read twice for two different questions:
//   default          — template literals are copied through untouched. This is the mask the SQL
//                      itself is read from.
//   blankTemplates   — the TEXT of every template is blanked, but the code inside `${…}` is masked
//                      as code and survives. That is the mask the "SQL built as a string" scan
//                      uses: `${Prisma.raw(...)}` is a call and must be found, while
//                      `` `never use $queryRawUnsafe here` `` is prose and must not.
function maskJs(code, { blankTemplates = false } = {}) {
  const out = new Array(code.length);
  const blankAt = (i) => (code[i] === '\n' ? '\n' : ' ');
  const blankRange = (from, to) => {
    for (let k = from; k < to && k < code.length; k++) out[k] = blankAt(k);
  };

  // Masks `code[from..to)` as JavaScript.
  const maskCode = (from, to) => {
    let prev = '';
    let prevWord = '';
    let i = from;
    while (i < to) {
      const c = code[i];
      const n = i + 1 < to ? code[i + 1] : '';
      if (c === '/' && n === '/') {
        const start = i;
        while (i < to && code[i] !== '\n') i++;
        blankRange(start, i);
        continue;
      }
      if (c === '/' && n === '*') {
        const found = code.indexOf('*/', i + 2);
        const stop = found === -1 || found + 2 > to ? to : found + 2;
        blankRange(i, stop);
        i = stop;
        continue;
      }
      if (c === '/' && (REGEX_MAY_START_AFTER.has(prev) || REGEX_AFTER_KEYWORD.has(prevWord))) {
        const end = skipRegexLiteral(code, i);
        if (end !== -1 && end <= to) {
          out[i] = c;
          blankRange(i + 1, end);
          i = end;
          prev = '/';
          prevWord = '';
          continue;
        }
      }
      if (c === "'" || c === '"') {
        const end = Math.min(skipJsString(code, i), to);
        out[i] = c;
        blankRange(i + 1, end);
        i = end;
        prev = c;
        prevWord = '';
        continue;
      }
      if (c === '`') {
        i = maskTemplate(i, to);
        prev = '`';
        prevWord = '';
        continue;
      }
      out[i] = c;
      if (/[A-Za-z_$]/.test(c)) prevWord += c;
      else if (!/\s/.test(c)) prevWord = '';
      if (!/\s/.test(c) || c === '\n') prev = c;
      i++;
    }
  };

  // Masks the template literal that starts at `start`; returns the index just past it.
  function maskTemplate(start, limit) {
    const { end } = readTemplate(code, start);
    const stop = Math.min(end, limit);
    if (!blankTemplates) {
      for (let k = start; k < stop; k++) out[k] = code[k];
      return stop;
    }
    out[start] = '`';
    let i = start + 1;
    while (i < stop) {
      if (code[i] === '`') {
        out[i] = '`';
        i++;
        break;
      }
      if (code[i] === '\\') {
        blankRange(i, i + 2);
        i += 2;
        continue;
      }
      if (code[i] === '$' && code[i + 1] === '{') {
        blankRange(i, i + 2);
        let depth = 1;
        let k = i + 2;
        while (k < stop && depth > 0) {
          const d = code[k];
          if (d === '{') depth++;
          else if (d === '}') {
            depth--;
            if (depth === 0) break;
          } else if (d === "'" || d === '"' || d === '`') {
            k = skipJsString(code, k);
            continue;
          }
          k++;
        }
        maskCode(i + 2, Math.min(k, stop)); // the interpolation is TypeScript, not SQL text
        if (k < stop) out[k] = ' ';
        i = k + 1;
        continue;
      }
      out[i] = blankAt(i);
      i++;
    }
    return stop;
  }

  maskCode(0, code.length);
  // Offsets are the contract of this function: every position must hold exactly one character.
  for (let k = 0; k < out.length; k++) if (out[k] === undefined) out[k] = blankAt(k);
  return out.join('');
}

const skipSpace = (code, i) => {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
};

// Balanced `<...>` of a generic argument list, or -1 when it does not close.
function skipAngle(code, i) {
  let depth = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '<') depth++;
    // `=>` inside a generic is an arrow, not a closing angle: `<Array<(x: string) => void>>`.
    else if (c === '>' && code[i - 1] !== '=') {
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === '`') return -1; // a backtick inside the angles means this is not a generic
    i++;
  }
  return -1;
}

function extractTemplates(code, masked) {
  const found = [];
  const unreadable = [];
  RAW_SQL_TAG.lastIndex = 0;
  let m;
  while ((m = RAW_SQL_TAG.exec(masked))) {
    let i = skipSpace(masked, m.index + m[0].length);
    if (masked[i] === '<') {
      const after = skipAngle(masked, i);
      if (after === -1) {
        unreadable.push({ line: lineOf(code, m.index), text: m[0] });
        continue;
      }
      i = skipSpace(masked, after);
    }
    // No backtick: this is the call form `$queryRaw<T>(stmt)`, and `stmt` is a `Prisma.sql`
    // template read on its own turn. Nothing is lost by walking past it.
    if (masked[i] !== '`') continue;
    const { text } = readTemplate(code, i);
    found.push({ text, line: lineOf(code, i) });
    // lastIndex is left just past the tag on purpose: a template nested inside an interpolation
    // (`${cond ? Prisma.sql`…` : …}`) is collapsed to `?` in the text above, so the only way it
    // gets read at all is for the scan to walk into it.
  }
  return { found, unreadable };
}

// Comments and string literals are dropped, newlines kept: line numbers are the whole point of the
// report, and `'published'` must not be read as an identifier. Quoted identifiers are copied
// through untouched — `"a--b"` is a name, not a comment.
function stripSqlLiterals(sql) {
  let out = '';
  let i = 0;
  const keepNewlines = (from, to) => {
    for (let k = from; k < to; k++) if (sql[k] === '\n') out += '\n';
  };
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== '"') j++;
      out += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }
    if (c === '-' && n === '-') {
      const from = i;
      while (i < sql.length && sql[i] !== '\n') i++;
      keepNewlines(from, i);
      continue;
    }
    if (c === '/' && n === '*') {
      const from = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      keepNewlines(from, Math.min(i, sql.length));
      continue;
    }
    if (c === "'") {
      const from = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      keepNewlines(from, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function tokenizeSql(sql) {
  const toks = [];
  let line = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < sql.length && sql[j] !== '"') {
        v += sql[j];
        j++;
      }
      toks.push({ t: 'qident', v, line });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      toks.push({ t: 'word', v: sql.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < sql.length && /[0-9.]/.test(sql[j])) j++;
      toks.push({ t: 'num', v: sql.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === ':' && sql[i + 1] === ':') {
      toks.push({ t: 'op', v: '::', line });
      i += 2;
      continue;
    }
    toks.push({ t: 'op', v: c, line });
    i++;
  }
  return toks;
}

const isAliasToken = (a) =>
  !!a && (a.t === 'qident' || (a.t === 'word' && !SQL_KEYWORDS.has(a.v.toLowerCase())));

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(toks, open) {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    if (toks[i].t !== 'op') continue;
    if (toks[i].v === '(') depth++;
    else if (toks[i].v === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function emptyRefs() {
  return {
    tables: [],
    aliases: new Map(),
    outputAliases: new Set(),
    derived: new Set(),
    named: [],
    isStatement: false,
    opaqueRelations: [],
    casts: [],
    qualified: [],
    bare: [],
  };
}

// The alias behind a derived relation: `) AS s`, `) WITH ORDINALITY AS t("a","b")`, `) g(n)`.
// The column list names the relation's own output, so those names belong to no table.
function takeDerivedAlias(toks, from, refs, consumed) {
  let ai = from;
  if (
    toks[ai] &&
    toks[ai].t === 'word' &&
    toks[ai].v.toLowerCase() === 'with' &&
    toks[ai + 1] &&
    toks[ai + 1].t === 'word' &&
    toks[ai + 1].v.toLowerCase() === 'ordinality'
  ) {
    ai += 2;
  }
  if (toks[ai] && toks[ai].t === 'word' && toks[ai].v.toLowerCase() === 'as') ai++;
  if (!isAliasToken(toks[ai])) return;
  refs.derived.add(toks[ai].v);
  consumed.add(ai);
  ai++;
  if (toks[ai] && toks[ai].t === 'op' && toks[ai].v === '(') {
    const close = matchParen(toks, ai);
    if (close !== -1) {
      for (let c = ai + 1; c < close; c++) {
        if (toks[c].t === 'qident' || toks[c].t === 'word') {
          refs.outputAliases.add(toks[c].v);
          consumed.add(c);
        }
      }
    }
  }
}

// Reads ONE template and returns what it says. Judging is left to validateRefs: a fragment has to
// be resolved against the rest of the file, and that is only known once every template is read.
function collectRefs(text, startLine) {
  const refs = emptyRefs();
  const toks = tokenizeSql(stripSqlLiterals(text));
  // A complete statement answers for its own names. A fragment — a `Prisma.sql` piece spliced
  // into a query written elsewhere in the file — is the only thing allowed to borrow them.
  refs.isStatement =
    !!toks[0] && toks[0].t === 'word' && STATEMENT_HEADS.has(toks[0].v.toLowerCase());
  const consumed = new Set();
  const lineAt = (tok) => startLine + tok.line;
  const parens = []; // enclosing `(`: the syntax function that opened it, when it is one

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const n = toks[i + 1];
    if (t.t === 'op' && t.v === '(') {
      const prev = toks[i - 1];
      const fn =
        prev && prev.t === 'word' && SYNTAX_FUNCTIONS.has(prev.v.toLowerCase())
          ? prev.v.toLowerCase()
          : null;
      parens.push(fn);
      continue;
    }
    if (t.t === 'op' && t.v === ')') {
      parens.pop();
      continue;
    }
    if (!n) break;
    const inside = parens.length ? parens[parens.length - 1] : null;
    const word = t.t === 'word' ? t.v.toLowerCase() : null;

    if (t.t === 'op' && t.v === '::' && n.t === 'qident') {
      refs.casts.push({ name: n.v, line: lineAt(n) });
      consumed.add(i + 1);
      continue;
    }

    // `WITH name AS (`, `WITH RECURSIVE name AS (`, `, name AS (` — a CTE declares a relation
    // whose columns schema.prisma knows nothing about. Only this exact shape counts as a
    // declaration; guessing derived relations from punctuation is what made `AT TIME ZONE`
    // register `AT` as one.
    if (word === 'with' || (t.t === 'op' && t.v === ',')) {
      let k = i + 1;
      if (toks[k] && toks[k].t === 'word' && toks[k].v.toLowerCase() === 'recursive') k++;
      const name = toks[k];
      // `WITH counted ("bookId", "n") AS MATERIALIZED (…)`. The shape is decided BEFORE anything
      // is consumed: a comma followed by `COUNT(` looks the same up to the paren, and swallowing
      // its arguments as a CTE column list would silence real column references.
      let a = k + 1;
      const listClose =
        toks[a] && toks[a].t === 'op' && toks[a].v === '(' ? matchParen(toks, a) : -1;
      const listOpen = listClose === -1 ? -1 : a;
      if (listClose !== -1) a = listClose + 1;
      const as = toks[a];
      let open = a + 1;
      if (toks[open] && toks[open].t === 'word' && toks[open].v.toLowerCase() === 'not') open++;
      const materialized =
        toks[open] && toks[open].t === 'word' && toks[open].v.toLowerCase() === 'materialized'
          ? open
          : -1;
      if (materialized !== -1) open++;
      if (
        isAliasToken(name) &&
        as &&
        as.t === 'word' &&
        as.v.toLowerCase() === 'as' &&
        toks[open] &&
        toks[open].t === 'op' &&
        toks[open].v === '('
      ) {
        refs.derived.add(name.v);
        consumed.add(k);
        consumed.add(a);
        if (materialized !== -1) consumed.add(materialized);
        if (listOpen !== -1) {
          // The column list names the CTE's own output; those names belong to no table.
          for (let c = listOpen + 1; c < listClose; c++) {
            if (toks[c].t === 'qident' || toks[c].t === 'word') {
              refs.outputAliases.add(toks[c].v);
              consumed.add(c);
            }
          }
        }
        i = open - 1;
        continue;
      }
    }

    if (word && TABLE_INTRO.has(word) && !inside) {
      // A relation list: `FROM "A" a, "B" b`, `JOIN LATERAL (…) x`, `FROM (…) AS s`.
      let j = i + 1;
      let stepInto = false;
      for (let guard = 0; guard < 64; guard++) {
        while (
          toks[j] &&
          toks[j].t === 'word' &&
          (toks[j].v.toLowerCase() === 'lateral' || toks[j].v.toLowerCase() === 'only')
        ) {
          j++;
        }
        const rel = toks[j];
        if (!rel) break;

        // `FROM ${table}` — the relation is a parameter. Nothing here can say what it is, and
        // a query whose relation is unknown must not have its bare names resolved against the
        // tables of a neighbouring query.
        if (rel.t === 'op' && rel.v === '?') {
          refs.opaqueRelations.push({ line: lineAt(rel) });
          break;
        }

        if (rel.t === 'op' && rel.v === '(') {
          // The alias is behind the matching paren, but the walk must still step through the
          // subquery so the real tables inside it are checked.
          const close = matchParen(toks, j);
          if (close !== -1) takeDerivedAlias(toks, close + 1, refs, consumed);
          stepInto = true;
          break;
        }

        let relation = null;
        // Schema-qualified: `public."Book" b`.
        if (
          rel.t === 'word' &&
          toks[j + 1] &&
          toks[j + 1].t === 'op' &&
          toks[j + 1].v === '.' &&
          toks[j + 2] &&
          toks[j + 2].t === 'qident'
        ) {
          const table = toks[j + 2];
          refs.tables.push({ name: table.v, line: lineAt(table) });
          relation = { kind: 'table', name: table.v };
          consumed.add(j);
          consumed.add(j + 2);
          j += 3;
        } else if (
          rel.t === 'word' &&
          toks[j + 1] &&
          toks[j + 1].t === 'op' &&
          toks[j + 1].v === '('
        ) {
          // A set-returning function: `FROM unnest(...) AS t(x)`, `generate_series(...) g`.
          // Its columns are not in the schema, so the alias joins the derived relations.
          const close = matchParen(toks, j + 1);
          if (close !== -1) takeDerivedAlias(toks, close + 1, refs, consumed);
          consumed.add(j);
          stepInto = true;
          break;
        } else if (rel.t === 'qident') {
          refs.tables.push({ name: rel.v, line: lineAt(rel) });
          relation = { kind: 'table', name: rel.v };
          consumed.add(j);
          j++;
        } else if (rel.t === 'word' && !SQL_KEYWORDS.has(rel.v.toLowerCase())) {
          // An unquoted relation name: either a CTE of this same query, or an unquoted table name.
          relation = { kind: 'name', name: rel.v, line: lineAt(rel) };
          consumed.add(j);
          j++;
        } else break;

        if (toks[j] && toks[j].t === 'word' && toks[j].v.toLowerCase() === 'as') {
          consumed.add(j);
          j++;
        }
        const alias =
          isAliasToken(toks[j]) && !(toks[j + 1] && toks[j + 1].t === 'op' && toks[j + 1].v === '.')
            ? toks[j]
            : null;
        if (alias) {
          consumed.add(j);
          j++;
        }
        if (relation.kind === 'table') {
          if (alias) {
            if (!refs.aliases.has(alias.v)) refs.aliases.set(alias.v, new Set());
            refs.aliases.get(alias.v).add(relation.name);
          }
        } else {
          refs.named.push({
            name: relation.name,
            alias: alias ? alias.v : null,
            line: relation.line,
          });
        }
        // `FROM "A" a, "B" b` — the comma continues the relation list, it does not end it.
        if (toks[j] && toks[j].t === 'op' && toks[j].v === ',') {
          j++;
          continue;
        }
        break;
      }
      if (!stepInto) i = j - 1;
      continue;
    }

    if (word === 'as' && (n.t === 'qident' || n.t === 'word')) {
      // `CAST(x AS "Language")` names a type, not an output column. Filing it as an alias was a
      // silent miss twice over: the type went unchecked and the name stopped being checked anywhere.
      if (inside === 'cast') {
        if (n.t === 'qident') refs.casts.push({ name: n.v, line: lineAt(n) });
      } else {
        refs.outputAliases.add(n.v);
      }
      consumed.add(i + 1);
      continue;
    }

    if ((t.t === 'word' || t.t === 'qident') && n.t === 'op' && n.v === '.') {
      const c = toks[i + 2];
      if (c && (c.t === 'word' || c.t === 'qident')) {
        refs.qualified.push({
          alias: t.v,
          column: c.v,
          quoted: c.t === 'qident',
          line: lineAt(t),
        });
        consumed.add(i);
        consumed.add(i + 2);
        i += 2;
        continue;
      }
    }
  }

  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t === 'qident' && !consumed.has(i)) {
      refs.bare.push({ name: toks[i].v, line: lineAt(toks[i]) });
    }
  }
  return refs;
}

// The union of everything the file's templates declare. Used ONLY for fragments — templates that
// name no relation of their own and are spliced into a query written elsewhere in the file.
function mergeRefs(all) {
  const merged = { tables: new Set(), aliases: new Map(), outputAliases: new Set(), derived: new Set() };
  for (const refs of all) {
    for (const t of refs.tables) merged.tables.add(t.name);
    for (const [alias, tables] of refs.aliases) {
      if (!merged.aliases.has(alias)) merged.aliases.set(alias, new Set());
      for (const t of tables) merged.aliases.get(alias).add(t);
    }
    for (const a of refs.outputAliases) merged.outputAliases.add(a);
    for (const d of refs.derived) merged.derived.add(d);
  }
  return merged;
}

function validateRefs(file, refs, fileRefs, schema) {
  const drift = [];
  const unresolved = [];
  const known = new Set();

  for (const t of refs.tables) {
    if (schema.models.has(t.name)) known.add(t.name);
    else drift.push(`${file}:${t.line}  FROM/JOIN "${t.name}" — no such table in schema.prisma`);
  }

  // Only a fragment may borrow the file's aliases, CTE names, output aliases and tables. A
  // complete statement carries its own FROM: an alias it does not bind is unbound in Postgres too
  // ("missing FROM-clause entry"), and letting it borrow one from a neighbouring method was a
  // silent miss. A fragment may still contain a subquery of its own — that does not make it a
  // statement, and its outer alias still comes from the query it is spliced into.
  const isFragment = !refs.isStatement;
  const derived = new Set(refs.derived);
  if (isFragment) for (const d of fileRefs.derived) derived.add(d);

  // A relation this pass cannot read leaves the query unresolvable as a whole: saying so once is
  // the alternative to quietly checking its columns against some other query's tables.
  for (const o of refs.opaqueRelations) {
    unresolved.push(
      `${file}:${o.line}  FROM/JOIN \${…} — the relation is interpolated, this pass cannot read it`,
    );
  }

  // `FROM counted c`: the relation is unquoted, so it is a CTE — or nothing this pass can
  // resolve. Postgres folds unquoted names to lower case, so an unquoted table name is a defect
  // in its own right; either way the answer is the same and it is never silent.
  for (const r of refs.named) {
    if (derived.has(r.name)) {
      if (r.alias) derived.add(r.alias);
      continue;
    }
    unresolved.push(
      `${file}:${r.line}  FROM/JOIN ${r.name} — not a CTE of this query and not a quoted table name`,
    );
    if (r.alias) derived.add(r.alias); // the alias is already reported through its relation
  }

  const columnsOf = (tables) => {
    const cols = new Set();
    for (const name of tables) for (const col of schema.models.get(name) || []) cols.add(col);
    return cols;
  };
  // Own tables when the query names any; the file's only for a fragment. A query whose relation
  // did not resolve gets nothing — borrowing there is the cross-query leak in another guise.
  const tablesOfQuery = refs.tables.length
    ? [...known]
    : isFragment && !refs.opaqueRelations.length
      ? [...fileRefs.tables].filter((t) => schema.models.has(t))
      : [];

  for (const c of refs.casts) {
    // A quoted type is an enum, a row type of a model, or a Postgres base type someone chose to
    // quote. Only a name that is none of the three is a typo worth stopping the build for.
    if (
      !schema.enums.has(c.name) &&
      !schema.models.has(c.name) &&
      !BUILTIN_TYPES.has(c.name.toLowerCase())
    ) {
      drift.push(`${file}:${c.line}  cast to "${c.name}" — no such enum or model in schema.prisma`);
    }
  }

  for (const q of refs.qualified) {
    // `EXCLUDED.x` is the row proposed by an upsert: the columns are the target table's.
    if (q.alias.toLowerCase() === PSEUDO_RELATION) {
      if (tablesOfQuery.length && !columnsOf(tablesOfQuery).has(q.column)) {
        drift.push(
          `${file}:${q.line}  EXCLUDED.${q.column} — no such column in ${tablesOfQuery.join('/')}`,
        );
      }
      continue;
    }
    if (refs.aliases.has(q.alias)) {
      // Bound by this very query: the strictest and the most common case.
      const tables = [...refs.aliases.get(q.alias)].filter((t) => schema.models.has(t));
      if (!tables.length) continue; // the table itself is already reported above
      if (!columnsOf(tables).has(q.column)) {
        drift.push(`${file}:${q.line}  ${q.alias}.${q.column} — no column "${q.column}" in ${tables.join('/')}`);
        continue;
      }
    } else if (derived.has(q.alias)) {
      continue; // CTE or subquery: schema says nothing about its columns
    } else if (schema.models.has(q.alias)) {
      if (!(schema.models.get(q.alias) || new Set()).has(q.column)) {
        drift.push(`${file}:${q.line}  ${q.alias}.${q.column} — no column "${q.column}" in ${q.alias}`);
        continue;
      }
    } else if (isFragment && fileRefs.aliases.has(q.alias)) {
      // A fragment does not bind the letter; the query it is spliced into does. If the letter is
      // used for two tables in the file, any of them is accepted — nothing here can tell them
      // apart, and following values across functions is out of this pass's reach.
      const tables = [...fileRefs.aliases.get(q.alias)].filter((t) => schema.models.has(t));
      if (!tables.length) continue;
      if (!columnsOf(tables).has(q.column)) {
        drift.push(`${file}:${q.line}  ${q.alias}.${q.column} — no column "${q.column}" in ${tables.join('/')}`);
        continue;
      }
    } else {
      unresolved.push(
        `${file}:${q.line}  ${q.alias}.${q.column} — no raw SQL in this file binds "${q.alias}" to a table`,
      );
      continue;
    }
    // Postgres folds an unquoted identifier to lower case, so `bv.bookId` asks for `bookid`.
    if (!q.quoted && q.column !== q.column.toLowerCase()) {
      drift.push(
        `${file}:${q.line}  ${q.alias}.${q.column} — unquoted, Postgres reads it as "${q.column.toLowerCase()}"`,
      );
    }
  }

  const outputAliases = new Set(refs.outputAliases);
  if (isFragment) for (const a of fileRefs.outputAliases) outputAliases.add(a);

  for (const b of refs.bare) {
    if (outputAliases.has(b.name)) continue; // output alias of this same query
    // A table this query names may appear outside FROM/JOIN (`"Book"."id"` is split earlier, but
    // `INSERT INTO … RETURNING "Book"` is not). A model name this query does NOT use is a column
    // reference like any other and stays checked.
    if (tablesOfQuery.includes(b.name)) continue;
    if (!tablesOfQuery.length) {
      // Every relation this query names is already reported — as absent from the schema, or as
      // unreadable. Repeating the same news once per column would bury the line that matters.
      if (refs.tables.length || refs.opaqueRelations.length || refs.named.length) continue;
      unresolved.push(
        `${file}:${b.line}  "${b.name}" — no raw SQL in this file names a table, nothing to resolve it against`,
      );
      continue;
    }
    if (!columnsOf(tablesOfQuery).has(b.name)) {
      drift.push(`${file}:${b.line}  "${b.name}" — no such column in ${tablesOfQuery.join('/')}`);
    }
  }

  return { drift, unresolved };
}

// Comments removed, string literals left untouched — the opposite trade-off from
// `stripSqlLiterals`. That pass exists to keep literal content from being misread as an
// identifier; this one exists to read the content, so it cannot blank it. Newlines are kept in
// both branches so a match's line number is still `startLine + count of '\n' before it`.
function stripSqlCommentsKeepLiterals(sql) {
  let out = '';
  let i = 0;
  const keepNewlines = (from, to) => {
    for (let k = from; k < to; k++) if (sql[k] === '\n') out += '\n';
  };
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== '"') j++;
      out += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }
    if (c === '-' && n === '-') {
      const from = i;
      while (i < sql.length && sql[i] !== '\n') i++;
      keepNewlines(from, i);
      continue;
    }
    if (c === '/' && n === '*') {
      const from = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      keepNewlines(from, Math.min(i, sql.length));
      continue;
    }
    if (c === "'") {
      const from = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(from, Math.min(i, sql.length));
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const IDENT = '(?:[A-Za-z_]\\w*|"[^"]+")';
const LIT = "'(?:[^']|'')*'";
// `alias.column = 'value'` or `"Table"."column" = 'value'` — an optional qualifier, then `=`.
const ENUM_EQ_RE = new RegExp(`(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})\\s*=\\s*(${LIT})`, 'g');
// `alias.column IN ('a', 'b')` / `NOT IN (...)` — same qualifier, a literal list instead of one.
const ENUM_IN_RE = new RegExp(
  `(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})\\s+(?:NOT\\s+)?IN\\s*\\(\\s*(${LIT}(?:\\s*,\\s*${LIT})*)\\s*\\)`,
  'gi',
);
const unquoteIdent = (s) => (s.startsWith('"') ? s.slice(1, -1) : s);
const unquoteLit = (s) => s.slice(1, -1).replace(/''/g, "'");

// Every table THIS query's own FROM/JOIN names; the file's tables for a fragment that names
// none of its own — the same fallback `validateRefs` computes as `tablesOfQuery`.
function queryTables(refs, fileRefs, schema, isFragment) {
  const known = refs.tables.map((t) => t.name).filter((n) => schema.models.has(n));
  if (known.length) return known;
  if (isFragment) return [...fileRefs.tables].filter((n) => schema.models.has(n));
  return [];
}

// Resolves `alias` to the table(s) it can mean in THIS query, or in the file for a fragment —
// the same ladder `validateRefs` walks for `refs.qualified`, `EXCLUDED` included. Returns null
// when the alias is a CTE/subquery (no schema columns to check) or is not bound anywhere this
// pass can see: both cases are already reported, or deliberately not, by the identifier pass
// above, and are silently skipped here rather than reported a second time under a different
// heading.
function tablesForAlias(alias, refs, fileRefs, schema, isFragment) {
  if (alias.toLowerCase() === PSEUDO_RELATION) return queryTables(refs, fileRefs, schema, isFragment);
  if (refs.aliases.has(alias)) return [...refs.aliases.get(alias)].filter((t) => schema.models.has(t));
  if (refs.derived.has(alias)) return null;
  if (schema.models.has(alias)) return [alias];
  if (isFragment) {
    if (fileRefs.aliases.has(alias)) {
      return [...fileRefs.aliases.get(alias)].filter((t) => schema.models.has(t));
    }
    if (fileRefs.derived.has(alias)) return null;
  }
  return null;
}

// LEGACY-252: a literal compared against an enum-typed column, checked against that enum's
// current values. Independent of collectRefs on purpose — it needs the literal text, which the
// identifier pass above deliberately drops, and reusing the alias/table resolution above is
// enough without re-tokenizing the template a second time.
function checkEnumLiterals(file, tpl, refs, fileRefs, schema) {
  const drift = [];
  const isFragment = !refs.isStatement;
  const text = stripSqlCommentsKeepLiterals(tpl.text);
  const lineAt = (index) => tpl.line + (text.slice(0, index).match(/\n/g) || []).length;

  const checkOne = (aliasRaw, columnRaw, literals, index, shape) => {
    const column = unquoteIdent(columnRaw);
    const tables = aliasRaw
      ? tablesForAlias(unquoteIdent(aliasRaw), refs, fileRefs, schema, isFragment)
      : queryTables(refs, fileRefs, schema, isFragment);
    if (!tables || !tables.length) return;
    // An alias ambiguous between tables (a UNION reusing the same letter, or a fragment whose
    // alias is bound to two tables across the file) is accepted the same way the identifier pass
    // accepts it: the value only has to be valid in ONE of the candidates, not every one of them
    // — a candidate this column is not an enum on at all imposes no constraint at all.
    const enumNames = new Set();
    for (const table of tables) {
      const enumName = (schema.colEnumTypes.get(table) || new Map()).get(column);
      if (enumName) enumNames.add(enumName);
    }
    if (!enumNames.size) return; // not an enum column on any candidate — out of scope
    const ref = aliasRaw ? `${aliasRaw}.${columnRaw}` : columnRaw;
    for (const lit of literals) {
      const value = unquoteLit(lit);
      const okSomewhere = [...enumNames].some((e) => (schema.enums.get(e) || new Set()).has(value));
      if (!okSomewhere) {
        const names = [...enumNames].sort().join('/');
        drift.push(
          `${file}:${lineAt(index)}  ${ref} ${shape(value)} — no value "${value}" in "${names}"`,
        );
      }
    }
  };

  ENUM_EQ_RE.lastIndex = 0;
  let m;
  while ((m = ENUM_EQ_RE.exec(text))) {
    checkOne(m[1], m[2], [m[3]], m.index, (value) => `= '${value}'`);
  }
  ENUM_IN_RE.lastIndex = 0;
  while ((m = ENUM_IN_RE.exec(text))) {
    const literals = m[3].match(new RegExp(LIT, 'g')) || [];
    checkOne(m[1], m[2], literals, m.index, (value) => `IN (…, '${value}', …)`);
  }
  return drift;
}

function checkRawSql(repo, schema) {
  const problems = [];
  const out = [];
  const drift = [];
  const unresolved = [];
  const enumDrift = [];
  let files = 0;
  let templates = 0;
  let identifiers = 0;

  const paths = SOURCE_ROOTS.flatMap((root) => listSourceFiles(join(repo, root)));
  for (const path of paths) {
    const code = readFileSync(path, 'utf8');
    if (!/\$queryRaw|\$executeRaw|Prisma\.sql|Prisma\.raw/.test(code)) continue;
    const masked = maskJs(code);
    // A backticked sentence such as `do not use $queryRawUnsafe here` is prose. Only code outside
    // every template literal can be a call, so the opaque scan runs over a second mask where the
    // templates are blanked too.
    const maskedCode = maskJs(code, { blankTemplates: true });
    if (!/\$queryRaw|\$executeRaw|Prisma\.sql|Prisma\.raw/.test(masked)) continue; // all in comments
    const file = relative(repo, path).replace(/\\/g, '/');
    files++;

    RAW_SQL_OPAQUE.lastIndex = 0;
    let u;
    while ((u = RAW_SQL_OPAQUE.exec(maskedCode))) {
      unresolved.push(
        `${file}:${lineOf(code, u.index)}  ${u[0]} — SQL built as a string, this pass cannot read it`,
      );
    }

    const { found, unreadable } = extractTemplates(code, masked);
    for (const bad of unreadable) {
      unresolved.push(`${file}:${bad.line}  ${bad.text} — the tag does not parse, template not read`);
    }

    const perTemplate = found.map((tpl) => ({ tpl, refs: collectRefs(tpl.text, tpl.line) }));
    templates += found.length;
    const fileRefs = mergeRefs(perTemplate.map((p) => p.refs));
    for (const { tpl, refs } of perTemplate) {
      identifiers +=
        refs.tables.length + refs.casts.length + refs.qualified.length + refs.bare.length;
      const verdict = validateRefs(file, refs, fileRefs, schema);
      drift.push(...verdict.drift);
      unresolved.push(...verdict.unresolved);
      enumDrift.push(...checkEnumLiterals(file, tpl, refs, fileRefs, schema));
    }
  }

  out.push(
    `raw SQL       : ${templates} templates in ${files} files -> ${identifiers} identifiers checked`,
  );
  out.push('');

  // Zero coverage used to read as success: point the roots at the wrong directory, or break the
  // masking so every file is dropped, and the run said "agree" having checked nothing at all.
  if (templates === 0) {
    unresolved.push(
      `${SOURCE_ROOTS.join('/')}  no raw SQL template was read — the pass covered nothing`,
    );
  }

  if (drift.length) {
    problems.push('raw SQL identifiers');
    out.push(`## RAW SQL IDENTIFIERS ABSENT FROM SCHEMA (${drift.length})`);
    drift.forEach((d) => out.push(`  - ${d}`));
    out.push('');
  }
  if (enumDrift.length) {
    problems.push('raw SQL enum values');
    out.push(`## RAW SQL ENUM VALUES ABSENT FROM SCHEMA (${enumDrift.length})`);
    enumDrift.forEach((d) => out.push(`  - ${d}`));
    out.push('');
  }
  if (unresolved.length) {
    problems.push('unresolved raw SQL');
    out.push(`## RAW SQL THIS PASS COULD NOT RESOLVE (${unresolved.length}) — may hide drift`);
    unresolved.forEach((d) => out.push(`  ! ${d}`));
    out.push('');
  }

  return { problems, out };
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
  pageCount Int       @default(0)
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
  "pageCount" INTEGER NOT NULL DEFAULT 0,
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

// The raw-SQL fixture. Both shapes the third pass must handle are here: a `Prisma.sql` fragment
// whose alias is declared elsewhere in the file, and a query with an output alias reused in
// ORDER BY. `SELECT 1` is in it on purpose — health.service.ts has exactly that, and a pass that
// trips on identifier-free SQL would be red on a healthy repository.
const FIXTURE_SOURCE = `
import { Prisma } from '@prisma/client';

export class FixtureService {
  async chaptersPerBook(ids: string[]) {
    const where: Prisma.Sql[] = [Prisma.sql\`b."id" IN (\${Prisma.join(ids)})\`];
    where.push(Prisma.sql\`b.status = 'DRAFT'::"Status"\`);

    const rows = await this.prisma.$queryRaw<Array<{ id: string; total: number }>>\`
      SELECT b."id", b."title", COUNT(DISTINCT c."id")::int AS "total"
      FROM "Book" b
      JOIN "Chapter" c ON c."book_id" = b."id"
      WHERE \${Prisma.join(where, ' AND ')}
      GROUP BY b."id", b."title"
      ORDER BY "total" DESC
    \`;

    await this.prisma.$queryRaw\`SELECT 1\`;
    return rows;
  }
}
`;

// Second fixture: a CTE. The next batch of raw SQL work (LEGACY-128) moves a sort into SQL, and
// a checker that reddens on a correct CTE is a checker people switch off.
const FIXTURE_CTE_SOURCE = `
import { Prisma } from '@prisma/client';

export class FixtureCteService {
  async ranked() {
    return this.prisma.$queryRaw\`
      WITH counted AS (
        SELECT b."id" AS "bookId", COUNT(c."id")::int AS "chapters"
        FROM "Book" b
        LEFT JOIN "Chapter" c ON c."book_id" = b."id"
        GROUP BY b."id"
      )
      SELECT counted."bookId", counted."chapters"
      FROM counted
      ORDER BY counted."chapters" DESC
    \`;
  }
}
`;

// A mutation that misses its anchor silently returns the fixture unchanged, and the case that
// used it passes for having tested nothing (review found this against the three LEGACY-252
// cases below). `mustReplace` turns that into a thrown error instead of a quiet no-op.
function mustReplace(s, from, to) {
  if (!s.includes(from)) throw new Error(`fixture mutation anchor not found: ${JSON.stringify(from)}`);
  return s.replace(from, to);
}

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
  {
    // The failure LEGACY-123 is about: schema and migrations agree with each other, and the raw
    // SQL template is the only place still naming the old column. Two passes green, route broken.
    name: 'raw SQL: column renamed in schema and migration, the template left behind',
    schema: (s) => s.replace('  title     String', '  headline  String'),
    extraMigration: 'ALTER TABLE "Book" RENAME COLUMN "title" TO "headline";',
    expect: ['raw SQL identifiers'],
  },
  {
    name: 'raw SQL: table that the schema does not have',
    source: (s) => s.replace('FROM "Book" b', 'FROM "Shelf" b'),
    expect: ['raw SQL identifiers'],
  },
  {
    // Proves the fragments are read too, not only the query the driver is handed.
    name: 'raw SQL: bad column inside a Prisma.sql fragment',
    source: (s) => s.replace('b."id" IN', 'b."isbn" IN'),
    expect: ['raw SQL identifiers'],
  },
  {
    name: 'raw SQL: cast to a type that is not an enum of the schema',
    source: (s) => s.replace('::"Status"', '::"Statuz"'),
    expect: ['raw SQL identifiers'],
  },
  {
    // LEGACY-252: `b.status = 'DRAFT'` inside the fixture's `Prisma.sql` fragment is exactly the
    // shape that stayed invisible to all three passes before this case existed — schema and
    // migration agree with each other (both renamed together), the fragment did not.
    name: 'raw SQL: enum value renamed in schema and migration, the literal left behind',
    schema: (s) => mustReplace(s, '  DRAFT\n', '  OLD_DRAFT\n'),
    extraMigration: `ALTER TYPE "Status" RENAME VALUE 'DRAFT' TO 'OLD_DRAFT';`,
    expect: ['raw SQL enum values'],
    expectReport: `b.status = 'DRAFT' — no value "DRAFT" in "Status"`,
  },
  {
    // Same defect, `IN (...)` shape instead of `=` — the other form LEGACY-252 named explicitly.
    // The report must say `IN (...)`, not the `=` wording of the case above: a message naming a
    // form the source does not contain sends whoever reads it looking for text that is not there.
    name: 'raw SQL: enum value inside IN (...) that the enum no longer has',
    schema: (s) => mustReplace(s, '  DRAFT\n', '  OLD_DRAFT\n'),
    extraMigration: `ALTER TYPE "Status" RENAME VALUE 'DRAFT' TO 'OLD_DRAFT';`,
    source: (s) => mustReplace(s, `b.status = 'DRAFT'::"Status"`, `b.status IN ('DRAFT', 'PUBLISHED')`),
    expect: ['raw SQL enum values'],
    expectReport: `b.status IN (…, 'DRAFT', …) — no value "DRAFT" in "Status"`,
  },
  {
    // The gate this whole record is about: a literal compared against a plain string column must
    // stay silent. Flagging every literal, enum-typed or not, is the false positive LEGACY-252
    // warned against.
    name: 'raw SQL: a literal compared against a non-enum column is left alone',
    source: (s) => mustReplace(s, `b.status = 'DRAFT'::"Status"`, `b."title" = 'Some Title'`),
    expect: [],
  },
  {
    // The identifier pass accepts EXCLUDED.column against the query's own target table
    // (`PSEUDO_RELATION`); the enum check has to resolve the same alias the same way, or an
    // enum comparison inside an upsert's DO UPDATE SET stays unchecked — the exact class of miss
    // this whole record is about, just reached through a different alias.
    name: 'raw SQL: EXCLUDED resolves to the query target table for enum checking too',
    source: (s) =>
      mustReplace(
        s,
        'await this.prisma.$queryRaw`SELECT 1`;',
        `await this.prisma.$executeRaw\`
      INSERT INTO "Book" ("id", "title", "status") VALUES ('x', 'y', 'DRAFT')
      ON CONFLICT ("id") DO UPDATE SET "status" = EXCLUDED."status"
      WHERE EXCLUDED."status" = 'GONE'
    \`;`,
      ),
    expect: ['raw SQL enum values'],
    expectReport: `EXCLUDED."status" = 'GONE' — no value "GONE" in "Status"`,
  },
  {
    // The bug review found: the same alias letter bound to two different tables in one file (one
    // query names "Book", another names "Chapter") must accept a value valid on EITHER table's
    // enum when a fragment shares that letter — the same mercy the identifier pass already gives
    // a column name valid in either. Requiring every candidate table's enum to agree turned this
    // into a false positive on correct SQL: `DRAFT` is a real `Status` value (Book), and used to
    // be rejected anyway because `Chapter.status` is a *different* enum that does not have it.
    name: 'raw SQL: an alias shared between two tables accepts a value valid on either',
    schema: (s) =>
      mustReplace(
        s,
        'model Chapter {\n  id     String @id',
        'model Chapter {\n  id     String @id\n  status ChapterState @default(OPEN)',
      ) + '\nenum ChapterState {\n  OPEN\n  CLOSED\n}\n',
    extraMigration: `CREATE TYPE "ChapterState" AS ENUM ('OPEN', 'CLOSED');
ALTER TABLE "Chapter" ADD COLUMN "status" "ChapterState" NOT NULL DEFAULT 'OPEN';`,
    source: () => `
import { Prisma } from '@prisma/client';

export class ZprobeAmbiguousAlias {
  async a() {
    await this.prisma.$queryRaw\`SELECT b."id" FROM "Book" b\`;
    await this.prisma.$queryRaw\`SELECT b."id" FROM "Chapter" b\`;
    await this.prisma.$queryRaw\`SELECT 1 WHERE \${Prisma.sql\`b.status = 'DRAFT'\`}\`;
  }
}
`,
    expect: [],
  },
  {
    name: 'raw SQL: bare quoted identifier no referenced table has',
    source: (s) => s.replace('ORDER BY "total" DESC', 'ORDER BY "nope" DESC'),
    expect: ['raw SQL identifiers'],
  },
  {
    // An output alias is recognised by how it is declared, not by a list of known names.
    name: 'raw SQL: output alias under any name is not read as a column',
    source: (s) => s.replace('AS "total"', 'AS "grandTotal"').replace('"total" DESC', '"grandTotal" DESC'),
    expect: [],
  },
  {
    name: 'raw SQL: reference through an alias no query binds is reported',
    source: (s) => s.replace('c."book_id"', 'z."book_id"'),
    expect: ['unresolved raw SQL'],
  },
  {
    name: 'raw SQL: SQL built as a string is reported, not passed over',
    source: (s) => s.replace('this.prisma.$queryRaw`SELECT 1`', "this.prisma.$queryRawUnsafe('SELECT 1')"),
    expect: ['unresolved raw SQL'],
  },
  {
    name: 'raw SQL: a CTE and the columns of its result are not a finding',
    source: () => FIXTURE_CTE_SOURCE,
    expect: [],
  },
  {
    // The point of the previous case is not that CTEs are skipped, but that the real tables inside
    // them are still checked. Without this one, `derived` could swallow the whole query.
    name: 'raw SQL: a column inside a CTE is still checked against the schema',
    source: () => FIXTURE_CTE_SOURCE.replace('b."id" AS "bookId"', 'b."idd" AS "bookId"'),
    expect: ['raw SQL identifiers'],
  },
  // ---- cases below pin the holes that review found in the first draft of the raw SQL pass ----
  {
    // A derived relation must not switch off checking for the rest of the file, and ordinary
    // Postgres (`AT TIME ZONE`, window functions) must not be read as one. The first draft did
    // both, and the second query below came out green.
    name: 'raw SQL: ordinary Postgres words do not switch off the rest of the file',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT max("created_at") AT TIME ZONE 'UTC' FROM "Book"\`;
    await this.prisma.$queryRaw\`SELECT "totallyBogus" FROM "Book"\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    name: 'raw SQL: a CTE given an alias resolves through it',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      WITH counted AS (
        SELECT b."id" AS "bookId" FROM "Book" b
      )
      SELECT c."bookId" FROM counted c
    \`;
  }
}
`,
    expect: [],
  },
  {
    name: 'raw SQL: a subquery given an alias resolves through it',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      SELECT s."id" FROM (SELECT b."id" FROM "Book" b) s
    \`;
  }
}
`,
    expect: [],
  },
  {
    // A template nested in an interpolation is collapsed to `?` in the outer text, so it is read
    // only if the scan walks into the interpolation instead of jumping past the whole template.
    name: 'raw SQL: a template nested inside an interpolation is read',
    source: () => `
import { Prisma } from '@prisma/client';

export class Zprobe {
  async a(cond: boolean) {
    await this.prisma.$queryRaw\`
      SELECT b."id" FROM "Book" b
      WHERE \${cond ? Prisma.sql\`b."bogusCol" = 1\` : Prisma.sql\`1=1\`}
    \`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    name: 'raw SQL: Prisma.raw takes a string and is reported as unreadable',
    source: () => `
import { Prisma } from '@prisma/client';

export class Zprobe {
  async a() {
    await this.prisma.$queryRaw(Prisma.raw('SELECT "bogusCol" FROM "Book"'));
  }
}
`,
    expect: ['unresolved raw SQL'],
  },
  {
    name: 'raw SQL: an unquoted camelCase column is folded by Postgres and reported',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT b.pageCount FROM "Book" b\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
    expectReport: 'unquoted, Postgres reads it as "pagecount"',
  },
  {
    name: 'raw SQL: a generic with parentheses does not hide the template',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw<Array<(x: string) => void>>\`SELECT "bogusCol" FROM "Book"\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    // The line number is the whole value of the report. A multi-line interpolation used to shift
    // everything after it upwards, straight into a TypeScript argument list.
    name: 'raw SQL: a multi-line interpolation does not shift the reported line',
    source: () => `
import { Prisma } from '@prisma/client';

export class Zprobe {
  async a(ids: string[]) {
    await this.prisma.$queryRaw\`
      SELECT b."id"
      FROM "Book" b
      WHERE b."id" IN (\${Prisma.join(
        ids,
      )})
        AND b."bogusCol" = 1
    \`;
  }
}
`,
    expect: ['raw SQL identifiers'],
    expectReport: 'src/fixture.service.ts:12  b.bogusCol',
  },
  // ---- second round of review: seven more holes, four of them silent ----
  {
    name: 'raw SQL: a subquery aliased with an explicit AS resolves through it',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      SELECT s."id" FROM (SELECT b."id" FROM "Book" b) AS s
    \`;
  }
}
`,
    expect: [],
  },
  {
    // FROM inside EXTRACT/SUBSTRING is syntax, not a relation. Reading it as one turned a column
    // into a "missing table" on perfectly ordinary Postgres.
    name: 'raw SQL: FROM inside EXTRACT is not a relation',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      SELECT EXTRACT(EPOCH FROM b."created_at"), EXTRACT(EPOCH FROM "created_at")
      FROM "Book" b
    \`;
  }
}
`,
    expect: [],
  },
  {
    name: 'raw SQL: JOIN LATERAL binds the alias of its subquery',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      SELECT x."id"
      FROM "Book" b
      JOIN LATERAL (SELECT c."id" FROM "Chapter" c WHERE c."book_id" = b."id") x ON true
    \`;
  }
}
`,
    expect: [],
  },
  {
    // A commented-out query does not run, and the name of an unsafe method inside prose is prose.
    // Failing the build on either is the noise that teaches people to switch a checker off.
    name: 'raw SQL: commented-out SQL and prose are not code',
    source: () => `
export class Zprobe {
  // never use $queryRawUnsafe here
  async a() {
    // await this.prisma.$queryRaw\`SELECT "bogusCol" FROM "Book"\`;
    /* await this.prisma.$queryRaw\`SELECT "alsoBogus" FROM "Book"\`; */
    const note = 'do not call $queryRawUnsafe';
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b\`;
    return note;
  }
}
`,
    expect: [],
  },
  {
    name: 'raw SQL: CAST(x AS "Type") is checked as a cast',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      SELECT b."id" FROM "Book" b WHERE b."status" = CAST('DRAFT' AS "Statuz")
    \`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    name: 'raw SQL: CAST to a real enum of the schema is not a finding',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      SELECT b."id" FROM "Book" b WHERE b."status" = CAST('DRAFT' AS "Status")
    \`;
  }
}
`,
    expect: [],
  },
  {
    // A bare name belongs to its own query. Resolving it against every table of the file let a
    // renamed column hide behind a table that some unrelated query selects from.
    name: 'raw SQL: a bare name is resolved against its own query, not the whole file',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT "title" FROM "Chapter"\`;
    await this.prisma.$queryRaw\`SELECT b."id" FROM "Book" b\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    // prisma/scripts/** holds maintenance scripts with real raw SQL: the same rename breaks them.
    name: 'raw SQL: prisma/ is scanned too, not only src/',
    prismaSource: () => `
export async function main(prisma: any) {
  await prisma.$queryRaw\`SELECT b."bogusCol" FROM "Book" b\`;
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    name: 'raw SQL: a tag whose generic does not parse is reported, not dropped',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw<Array<{ a: string \`SELECT 1\`;
  }
}
`,
    expect: ['unresolved raw SQL'],
  },
  // ---- third round of review: scope. A name belongs to its query, not to its file ----
  {
    // Both queries are correct. Requiring the column in every table the file binds to the letter
    // `b` failed the build on them — and this pass gates the deploy path, with no flag to bypass.
    name: 'raw SQL: the same alias letter for two tables is resolved per query',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b\`;
    await this.prisma.$queryRaw\`SELECT b."book_id" FROM "Chapter" b\`;
  }
}
`,
    expect: [],
  },
  {
    // The other half of the same rule: the letter must not borrow columns from the table the
    // NEIGHBOURING query binds it to. `title` exists in Book, and the second query is still wrong.
    name: 'raw SQL: a column is checked against the table THIS query binds to the alias',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b\`;
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Chapter" b\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    // A CTE lives inside the query that declares it. Another query joining the same name is
    // joining nothing, and saying so is the whole point of the unresolved section.
    name: 'raw SQL: a CTE of one query is not a relation of another',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      WITH counted AS (SELECT b."id" FROM "Book" b)
      SELECT c."id" FROM counted c
    \`;
    await this.prisma.$queryRaw\`SELECT x."title" FROM "Book" x JOIN counted ON true\`;
  }
}
`,
    expect: ['unresolved raw SQL'],
  },
  {
    // A CTE named `c` in one method used to switch off checking for every other `c` in the file,
    // and single letters are the convention in this repository's raw SQL.
    name: 'raw SQL: a CTE alias does not silence the same letter in another query',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      WITH counted AS (SELECT b."id" AS "bookId" FROM "Book" b)
      SELECT c."bookId" FROM counted c
    \`;
    await this.prisma.$queryRaw\`SELECT c."bogusCol" FROM "Chapter" c\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    name: 'raw SQL: an output alias does not silence a bare name in another query',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT b."id" AS "bogusName" FROM "Book" b\`;
    await this.prisma.$queryRaw\`SELECT "bogusName" FROM "Chapter"\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    name: 'raw SQL: a comma-separated relation list binds every alias in it',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      SELECT b."title", c."book_id" FROM "Book" b, "Chapter" c WHERE c."book_id" = b."id"
    \`;
  }
}
`,
    expect: [],
  },
  {
    name: 'raw SQL: a typo in the second relation of the list is named as a table',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b, "Chapterr" c\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
    expectReport: 'FROM/JOIN "Chapterr" — no such table',
  },
  {
    // `EXCLUDED` is a pseudo-relation of an upsert, not an alias anybody declares.
    name: 'raw SQL: EXCLUDED in an upsert resolves against the target table',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      INSERT INTO "Book" ("id", "title") VALUES (?, ?)
      ON CONFLICT ("id") DO UPDATE SET "title" = EXCLUDED."title"
    \`;
  }
}
`,
    expect: [],
  },
  {
    name: 'raw SQL: a bogus column on EXCLUDED is still a finding',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      INSERT INTO "Book" ("id", "title") VALUES (?, ?)
      ON CONFLICT ("id") DO UPDATE SET "title" = EXCLUDED."bogusCol"
    \`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    // `s.replace(/'/g, "''")` is a quote-escaping helper — the kind of code that sits next to raw
    // SQL. Reading its `'` as the start of a string blanked the rest of the file, and the file was
    // then dropped as "all in comments": a whole service disappearing from the check, silently.
    name: 'raw SQL: a regex literal holding a quote does not swallow the file',
    source: () => `
export class Zprobe {
  esc(s: string) {
    return s.replace(/'/g, "''");
  }
  async a() {
    await this.prisma.$queryRaw\`SELECT b."bogusCol" FROM "Book" b\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  // ---- fourth round of review: what the masking and the scoping still got wrong ----
  {
    // `return /['"]/.test(s)` is a regex in keyword position. Read as division, its quote starts a
    // "string" that blanks the rest of the file, and the file leaves the check without a word.
    name: 'raw SQL: a regex after a keyword does not swallow the file',
    source: () => `
export class Zprobe {
  hasQuote(s: string) {
    return /['"]/.test(s);
  }
  async a() {
    await this.prisma.$queryRaw\`SELECT b."bogusCol" FROM "Book" b\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    // A fragment carrying its own subquery still needs the alias of the query it is spliced into.
    name: 'raw SQL: a fragment with its own subquery still resolves the outer alias',
    source: () => `
import { Prisma } from '@prisma/client';

export class Zprobe {
  async a() {
    const where = Prisma.sql\`b."id" IN (SELECT c."book_id" FROM "Chapter" c)\`;
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b WHERE \${where}\`;
  }
}
`,
    expect: [],
  },
  {
    name: 'raw SQL: the name of an unsafe method inside a template literal is prose',
    source: () => `
export class Zprobe {
  warn(n: string) {
    return \`do not use $queryRawUnsafe in \${n}\`;
  }
  async a() {
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b\`;
  }
}
`,
    expect: [],
  },
  {
    name: 'raw SQL: a schema-qualified relation is read as its table',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT p."title" FROM public."Book" p\`;
  }
}
`,
    expect: [],
  },
  {
    name: 'raw SQL: a schema-qualified relation is still checked against the schema',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT p."title" FROM public."Bookk" p\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    // The column list is quoted on purpose: unquoted names are not checked at all, so an
    // unquoted fixture would pass without exercising anything.
    name: 'raw SQL: a set-returning function in FROM is a relation the schema does not describe',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      SELECT b."title", g."n"
      FROM "Book" b, generate_series(1, 3) WITH ORDINALITY AS g("n")
    \`;
  }
}
`,
    expect: [],
  },
  {
    // `FROM ${table}` is dynamic SQL. Its columns cannot be checked, and silently checking them
    // against a neighbouring query's tables is the cross-query leak in another guise.
    name: 'raw SQL: an interpolated relation is reported, not resolved from elsewhere',
    source: () => `
export class Zprobe {
  async a(tbl: any) {
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b\`;
    await this.prisma.$queryRaw\`SELECT "bogusCol" FROM \${tbl}\`;
  }
}
`,
    expect: ['unresolved raw SQL'],
  },
  // ---- fifth round of review, and the /qa reviewer of posadki ----
  {
    // The interpolation is code, not SQL text: `${Prisma.raw(...)}` builds identifiers as a string
    // and must be reported. Blanking the whole template for that scan hid it completely.
    name: 'raw SQL: Prisma.raw inside an interpolation is still reported',
    source: () => `
import { Prisma } from '@prisma/client';

export class Zprobe {
  async a(dir: string) {
    await this.prisma.$queryRaw\`
      SELECT b."title" FROM "Book" b ORDER BY \${Prisma.raw(\`b."title" \${dir}\`)}
    \`;
  }
}
`,
    expect: ['unresolved raw SQL'],
  },
  {
    name: 'raw SQL: $queryRawUnsafe inside an interpolation is still reported',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b WHERE \${this.prisma.$queryRawUnsafe('x')}\`;
  }
}
`,
    expect: ['unresolved raw SQL'],
  },
  {
    name: 'raw SQL: a CTE with a column list and MATERIALIZED is read',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`
      WITH counted ("bookId", "n") AS MATERIALIZED (SELECT b."id", 1 FROM "Book" b)
      SELECT counted."bookId", "n" FROM counted
    \`;
  }
}
`,
    expect: [],
  },
  {
    // A complete statement answers for its own aliases: Postgres would refuse it with
    // "missing FROM-clause entry for table b", and borrowing the letter from a neighbouring
    // method turned that into a green run.
    name: 'raw SQL: a statement may not borrow an alias from another query',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b\`;
    await this.prisma.$queryRaw\`SELECT c."id", b."title" FROM "Chapter" c\`;
  }
}
`,
    expect: ['unresolved raw SQL'],
  },
  {
    name: 'raw SQL: DELETE ... USING binds the alias of the used relation',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$executeRaw\`
      DELETE FROM "Chapter" c USING "Book" b WHERE c."book_id" = b."id"
    \`;
  }
}
`,
    expect: [],
  },
  {
    name: 'raw SQL: $executeRaw templates are read like $queryRaw ones',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$executeRaw\`UPDATE "Book" SET "bogusCol" = 1\`;
  }
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    name: 'raw SQL: $executeRawUnsafe is reported like its query twin',
    source: () => `
export class Zprobe {
  async a() {
    await this.prisma.$executeRawUnsafe('DELETE FROM "Book"');
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b\`;
  }
}
`,
    expect: ['unresolved raw SQL'],
  },
  {
    // A file whose only raw SQL is a `Prisma.sql` statement — no `$queryRaw` anywhere near it.
    name: 'raw SQL: a file with only Prisma.sql is read',
    source: () => `
import { Prisma } from '@prisma/client';

export const q = Prisma.sql\`SELECT b."bogusCol" FROM "Book" b\`;
`,
    expect: ['raw SQL identifiers'],
  },
  {
    // Zero coverage used to read as success: point the roots at a directory with no code and the
    // run said "schema and migrations agree" while checking nothing at all.
    name: 'raw SQL: reading no template at all is a failure, not a pass',
    source: () => `
export class Zprobe {
  async a() {
    return 1;
  }
}
`,
    expect: ['unresolved raw SQL'],
    expectReport: 'no raw SQL template was read',
  },
  {
    name: 'raw SQL: libs/ is scanned as well',
    libsSource: () => `
export async function q(prisma: any) {
  return prisma.$queryRaw\`SELECT b."bogusCol" FROM "Book" b\`;
}
`,
    expect: ['raw SQL identifiers'],
  },
  {
    // The known limit, pinned on purpose: a fragment names no relation, so it is resolved against
    // every table the file names. A column that belongs to a different table of the same file is
    // therefore accepted. Tightening this needs following values across functions.
    name: 'raw SQL: a fragment borrows any table of its file — the known limit',
    source: () => `
import { Prisma } from '@prisma/client';

export class Zprobe {
  async a() {
    const where = Prisma.sql\`"book_id" = 1\`;
    await this.prisma.$queryRaw\`SELECT b."title" FROM "Book" b WHERE \${where}\`;
    await this.prisma.$queryRaw\`SELECT c."id" FROM "Chapter" c\`;
  }
}
`,
    expect: [],
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
  mkdirSync(join(root, 'src'), { recursive: true });
  if (caseDef.libsSource) {
    mkdirSync(join(root, 'libs', 'api-client'), { recursive: true });
    writeFileSync(join(root, 'libs', 'api-client', 'fixture.query.ts'), caseDef.libsSource());
  }
  if (caseDef.prismaSource) {
    mkdirSync(join(root, 'prisma', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'prisma', 'scripts', 'fixture.script.ts'), caseDef.prismaSource());
  }
  writeFileSync(
    join(root, 'src', 'fixture.service.ts'),
    caseDef.source ? caseDef.source(FIXTURE_SOURCE) : FIXTURE_SOURCE,
  );
  writeFileSync(join(migDir, '20260101000000_init', 'migration.sql'), FIXTURE_MIGRATION);
  if (caseDef.extraMigration) {
    mkdirSync(join(migDir, '20260102000000_extra'), { recursive: true });
    writeFileSync(join(migDir, '20260102000000_extra', 'migration.sql'), caseDef.extraMigration);
  }
  return root;
}

// LEGACY-251 regression guard: every case above can report the right verdict and still leak its
// fixture — the case assertions never looked at the filesystem. This counts `drift-check-*`
// directories in the OS temp dir before and after the run, independently of any case's outcome.
// Deliberately does not swallow a read failure into 0: "could not look" and "nothing leaked" are
// different facts, and folding them together is the exact mistake this guard exists to avoid.
function countDriftCheckDirs() {
  return readdirSync(tmpdir()).filter((d) => d.startsWith('drift-check-')).length;
}

function runSelfTest() {
  let failed = 0;
  const dirsBefore = countDriftCheckDirs();
  for (const caseDef of SELF_TEST_CASES) {
    let root, problems, out;
    try {
      // `buildFixture` writes files before there is anything to clean up on failure — LEGACY-251
      // was first found as an ENOSPC thrown from inside it, on a case that never reached a
      // verdict. Both calls sit inside the same try for exactly that reason.
      root = buildFixture(caseDef);
      ({ problems, out } = checkRepo(root));
    } catch (err) {
      // A case that throws never reaches the pass/fail branch below, so without this the
      // fixture would leak the same as it did before LEGACY-251 — silently, on every failure.
      console.log(`  FAIL ${caseDef.name}\n         threw: ${err.message}`);
      if (root) console.log(`         fixture left for inspection: ${root}`);
      failed++;
      continue;
    }
    // Some cases are about WHAT the report says — a line number, a wording — not only about
    // which kind of problem was raised. A kind alone stays green on a report pointing at the
    // wrong line, and the line is most of what this pass is for.
    const reportOk =
      !caseDef.expectReport || out.some((line) => line.includes(caseDef.expectReport));
    const expected = [...caseDef.expect].sort().join(', ') || '(none)';
    const actual = [...problems].sort().join(', ') || '(none)';
    if (expected === actual && reportOk) {
      console.log(`  ok   ${caseDef.name}`);
      // Only a passing case is removed: a red one is left in place on purpose (LEGACY-251) —
      // it is the only way to see what the fixture actually looked like when it went wrong.
      rmSync(root, { recursive: true, force: true });
    } else {
      failed++;
      console.log(
        `  FAIL ${caseDef.name}\n         expected: ${expected}\n         actual:   ${actual}`,
      );
      if (!reportOk) console.log(`         report is missing: ${caseDef.expectReport}`);
      console.log(`         fixture left for inspection: ${root}`);
    }
  }
  console.log('');
  // Only counted as a leak when every case's own verdict was right: a case left on disk on
  // purpose after a real mismatch is diagnostic, not the defect LEGACY-251 was about.
  if (failed === 0) {
    const leaked = countDriftCheckDirs() - dirsBefore;
    if (leaked > 0) {
      failed++;
      console.log(
        `FAIL  self-test cleanup: ${leaked} drift-check-* fixture(s) left behind in ${tmpdir()}`,
      );
    }
  }
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
  if (problems.includes('raw SQL identifiers')) {
    console.log('Raw SQL names tables or columns that schema.prisma does not have.');
    console.log('Renaming a column by hand leaves those templates behind — see LEGACY-123.');
  }
  if (problems.includes('raw SQL enum values')) {
    console.log('Raw SQL compares an enum-typed column against a value the enum no longer has.');
    console.log('Renaming an enum value by hand leaves those literals behind — see LEGACY-252.');
  }
  if (problems.includes('unresolved raw SQL')) {
    console.log('Some raw SQL could not be read at all — see the section above for what and where.');
    console.log('An unread template hides drift, so it counts as a failure — see LEGACY-123.');
  }
  if (problems.some((p) => !p.includes('raw SQL'))) {
    console.log('schema.prisma and the hand-written migrations describe different databases.');
    console.log('Fix the migration (or the schema) before this reaches the VPS — see ADR-011.');
  }
  process.exit(1);
}

console.log('RESULT: schema and migrations agree');
