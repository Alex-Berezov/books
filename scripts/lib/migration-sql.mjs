// LEGACY-397: what both migration parsers (drift-check.mjs, check-migration-compat.mjs) must agree
// on — the index DDL heads, the marker for DDL that cannot be read, and the EXECUTE unwrap inside a
// DO block. Before this file each script kept its own copy; the unwrap landed in drift-check
// (LEGACY-367) and never reached check-migration-compat, which kept passing such migrations.
// What each script then does with a statement (model it, flag it) stays in that script.

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
