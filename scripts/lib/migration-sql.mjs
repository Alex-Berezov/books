// LEGACY-397: what both migration parsers (drift-check.mjs, check-migration-compat.mjs) must agree
// on — the index DDL heads, the marker for DDL that cannot be read, the EXECUTE unwrap inside a DO
// block, and the lexing under all of it: comments, statement splitting. The qualified table name
// (qualifiedIdent, tableKey) is check-migration-compat's only: drift-check still reads names with
// its own pattern (LEGACY-397). Before this file each script kept its own copy; the unwrap landed in drift-check (LEGACY-367) and
// never reached check-migration-compat, which kept passing such migrations. What each script then
// does with a statement (model it, flag it) stays in that script, and so does its DO-block
// expansion: drift-check flattens a block into marked text, check-migration-compat into statements
// (arbiter decision 30.09.2026). drift-check.mjs stripSqlCommentsKeepLiterals is not a copy of
// stripSqlComments: it keeps literals and line breaks for line numbers in the src/ pass.

export const INDEX_HEADS = {
  create: String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\b`,
  drop: String.raw`DROP\s+INDEX\b`,
  alter: String.raw`ALTER\s+INDEX\b`,
};

export const INDEX_DDL_HEAD = `(?:${Object.values(INDEX_HEADS).join('|')})`;

export const startsWithHead = (head, s) => new RegExp(`^${head}`, 'i').test(s);

export const UNREADABLE_MARK = 'UNREADABLE ';

/**
 * Rewrites `EXECUTE` statements in a DO-block body.
 *
 * `EXECUTE '<index DDL>';` becomes the statement itself, prefixed with `mark` (`''` escapes
 * undone). Any other `EXECUTE ...;` becomes an `UNREADABLE_MARK` statement when `isUnreadable`
 * says so; otherwise it is erased, or left as written with `keepOther` — erasing takes its `;`
 * along and glues the neighbouring statements together, which a scanner of statement heads
 * cannot afford.
 *
 * @param {string} body
 * @param {{ mark?: string, keepOther?: boolean, isUnreadable: (stmt: string) => boolean }} opts
 */
export function unwrapExecute(body, { mark = '', keepOther = false, isUnreadable }) {
  const unwrapped = body.replace(
    new RegExp(String.raw`\bEXECUTE\s+'(${INDEX_DDL_HEAD}(?:[^']|'')*)'\s*;`, 'gi'),
    (_m, inner) => `\n${mark}${inner.replace(/''/g, "'")};\n`,
  );
  return unwrapped.replace(/\bEXECUTE\b[^;]*;/gi, (x) => {
    if (isUnreadable(x)) return `\n${UNREADABLE_MARK}${x.replace(/;$/, '').replace(/\s+/g, ' ')};\n`;
    return keepOther ? x : ' ';
  });
}

/**
 * SQL without comments, character by character: `--` or `/*` inside a string literal or a quoted
 * identifier is not a comment, and a regex would eat half the statement with it. A block comment
 * is removed without a trace, as drift-check did before the merge. Comments inside a dollar-quoted body are stripped too: that body is the PL/pgSQL of a `DO` block,
 * and DDL inside it is DDL all the same.
 *
 * `legacyCompat` returns what check-migration-compat did before the merge, unchanged: dollar-quoted
 * bodies kept as written with their comments, a backslash as an escape in every literal, `"` not
 * tracked (LEGACY-397, arbiter decision 30.09.2026). LEGACY-427 drops the flag.
 *
 * @param {string} sql
 * @param {{ legacyCompat?: boolean }} [opts]
 */
export function stripSqlComments(sql, { legacyCompat = false } = {}) {
  if (legacyCompat) return stripSqlCommentsCompat(sql);
  let out = '';
  let i = 0;
  let inS = false,
    inD = false;
  while (i < sql.length) {
    const c = sql[i],
      n = sql[i + 1];
    if (!inS && !inD) {
      if (c === '-' && n === '-') {
        while (i < sql.length && sql[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && n === '*') {
        i += 2;
        while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }
    if (!inD && c === "'") inS = !inS;
    else if (!inS && c === '"') inD = !inD;
    out += c;
    i++;
  }
  return out;
}

/** check-migration-compat.mjs stripSqlComments as it was before the merge, behind `legacyCompat`. */
function stripSqlCommentsCompat(sql) {
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
 * Top-level statements, split on `;` outside string literals, quoted identifiers and dollar-quoted
 * bodies — a `DO $$ ... $$` block stays one statement. Trimmed, empty ones dropped.
 *
 * @param {string} sql
 */
export function splitStatements(sql) {
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

/** An identifier, quoted or bare, as a regex source. */
export const ident = '(?:"[^"]+"|\\w+)';

/**
 * A table name, possibly schema-qualified: `"public"."Book"`, `public.Book`, bare `Book`. Two
 * groups — schema (may be absent) and table. Before LEGACY-423 only the first part was taken, and
 * `"public"."X"` became `public`: the schema was mistaken for the table.
 */
export const qualifiedIdent = `(?:(${ident})\\.)?(${ident})`;

export const unquote = (name) => name.replace(/"/g, '');

/**
 * Table key `schema.table` from a `qualifiedIdent` match whose schema group is `at`. One bare name
 * would glue `"audit"."Like"` to `"public"."Like"`. A bare name gets `bareSchema`: `public`, or an
 * unknown `?` when the migration sets `search_path` — such a key matches no qualified one.
 */
export const tableKey = (m, at, bareSchema) => `${m[at] ? unquote(m[at]) : bareSchema}.${unquote(m[at + 1])}`;
