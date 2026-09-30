// LEGACY-397: what both migration parsers (drift-check.mjs, check-migration-compat.mjs) must agree
// on — the index DDL heads, the marker for DDL that cannot be read, the EXECUTE unwrap inside a DO
// block, and the lexing under all of it: quoted text (quotedTextEnd), comments, statement splitting,
// comma lists. The qualified table name (qualifiedIdent, identName, tableKey) is
// check-migration-compat's only: drift-check still reads names with its own pattern (LEGACY-397).
// Before this file each script kept its own copy; the unwrap landed in drift-check (LEGACY-367) and
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
 * Index just past the literal or quoted identifier that opens at `i`, read the way PostgreSQL lexes
 * it (LEGACY-427): `'...'` with `''`, `E'...'` with backslash escapes as well, `"..."` with `""`.
 * Before, each lexer flipped an in-literal flag on every quote, and `E'it\'s'` left it open to the
 * end of the file: the rest of the migration read as one literal, its DDL unseen.
 */
function quotedEnd(sql, i) {
  const q = sql[i];
  const escapes = q === "'" && /(?:^|[^\w$])[Ee]$/.test(sql.slice(Math.max(0, i - 2), i));
  let j = i + 1;
  while (j < sql.length) {
    if (escapes && sql[j] === '\\') j += 2;
    else if (sql[j] === q && sql[j + 1] === q) j += 2;
    else if (sql[j] === q) return j + 1;
    else j += 1;
  }
  return sql.length;
}

/**
 * The `$tag$` that opens a dollar-quoted body at `i`, or null. The tag follows the identifier rule —
 * `$1$` is a positional parameter, not a tag — and `a$b$c` is one identifier, not a body.
 */
export const dollarTagAt = (sql, i) =>
  sql[i] === '$' && !/[\w$]/.test(sql[i - 1] ?? '')
    ? (/^\$(?:[A-Za-z_][\w]*)?\$/.exec(sql.slice(i, i + 64)) || [null])[0]
    : null;

/**
 * Index just past the literal, quoted identifier or dollar-quoted body that opens at `i`, or -1 when
 * none opens there. The one place every scanner here skips over quoted text.
 */
export function quotedTextEnd(sql, i) {
  if (sql[i] === "'" || sql[i] === '"') return quotedEnd(sql, i);
  const tag = dollarTagAt(sql, i);
  if (!tag) return -1;
  const end = sql.indexOf(tag, i + tag.length);
  return end === -1 ? sql.length : end + tag.length;
}

/**
 * SQL without comments, character by character: `--` or `/*` inside a string literal or a quoted
 * identifier is not a comment, and a regex would eat half the statement with it. A block comment
 * becomes a space, as PostgreSQL reads it — `ALTER TABLE/* x *\/"Book"` must stay two tokens.
 *
 * A dollar-quoted body `$tag$ ... $tag$` ends at its own tag whatever it contains, and is stripped
 * on its own: it is the PL/pgSQL of a `DO` block, where DDL is DDL all the same, and a statement led
 * by a comment there (`-- why` + `ALTER TABLE`) would not start with its head. Stripping the body
 * separately keeps a stray `'` or `--` inside it from reaching past its closing tag; in a body that
 * is plain text (`COMMENT ... IS $$...$$`) the text may lose a piece, which no detector reads.
 *
 * @param {string} sql
 */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i],
      n = sql[i + 1];
    if (c === '-' && n === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      const end = quotedEnd(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    const tag = dollarTagAt(sql, i);
    if (tag) {
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end;
      out += tag + stripSqlComments(sql.slice(i + tag.length, stop)) + (end === -1 ? '' : tag);
      i = end === -1 ? sql.length : end + tag.length;
      continue;
    }
    out += c;
    i++;
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
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const quoted = quotedTextEnd(sql, i);
    if (quoted !== -1) {
      i = quoted;
      continue;
    }
    if (sql[i] === ';') {
      stmts.push(sql.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  stmts.push(sql.slice(start));
  return stmts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Items of a list, split on commas outside parentheses, literals, quoted identifiers and
 * dollar-quoted bodies (`quotedTextEnd`).
 */
export function splitTopLevelCommas(s) {
  const parts = [];
  let start = 0,
    depth = 0,
    i = 0;
  while (i < s.length) {
    const quoted = quotedTextEnd(s, i);
    if (quoted !== -1) {
      i = quoted;
      continue;
    }
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** An identifier, quoted or bare, as a regex source. */
export const ident = '(?:"(?:[^"]|"")+"|\\w+)';

/**
 * A table name, possibly schema-qualified: `"public"."Book"`, `public.Book`, bare `Book`,
 * `"public" . "Book"` (PostgreSQL allows spaces around the dot — LEGACY-427). Two groups — schema
 * (may be absent) and table. Before LEGACY-423 only the first part was taken, and `"public"."X"`
 * became `public`: the schema was mistaken for the table.
 */
export const qualifiedIdent = `(?:(${ident})\\s*\\.\\s*)?(${ident})`;

/**
 * The name PostgreSQL stores for an identifier: quoted — as written, `""` undone; bare — folded to
 * lower case (LEGACY-427: `CREATE TABLE Foo` creates `foo`, not `"Foo"`).
 */
export const identName = (name) =>
  name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name.toLowerCase();

/**
 * Table key `schema.table` from a `qualifiedIdent` match whose schema group is `at`. One bare name
 * would glue `"audit"."Like"` to `"public"."Like"`. A bare name gets `bareSchema`: `public`, or an
 * unknown `?` when the migration sets `search_path` — such a key matches no qualified one.
 */
export const tableKey = (m, at, bareSchema) =>
  `${m[at] ? identName(m[at]) : bareSchema}.${identName(m[at + 1])}`;
