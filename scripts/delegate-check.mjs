#!/usr/bin/env node
// R0 / SUSPECT-04 / LEGACY-045: every Prisma delegate touched from code must exist in
// schema.prisma. The delegate-interface + cast pattern (ADR-011) hides bad model names from
// tsc — that is the exact failure mode that broke Phase 14 in production.
//
// LEGACY-045 closed this file's original defects: field names of unrelated interfaces were
// reported as "declared delegates NOT IN SCHEMA", and models reached only through the
// cast-and-call pattern (`this.getDatabase().model.method()`, `const client = tx as unknown
// as XyzClient`) were invisible to the scanner and reported as "never accessed" even when
// used correctly every day. Both classes are fixed below; see the self-test for the exact
// regressions they cover. What is NOT fixed, by design: a receiver whose ONLY occurrence in
// a file is already wrong (no correct sibling call to bootstrap from) stays invisible — a
// documented limit of a regex scanner, not a silent gap.
//
// Usage:
//   node scripts/delegate-check.mjs [repoPath]
//   node scripts/delegate-check.mjs --self-test

import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// Repo root from the script's own location, the way `drift-check.mjs` and
// `check-migration-compat.mjs` do it — `process.cwd()` made the same `yarn` script work or die
// with ENOENT depending on the directory it was called from, while its neighbours did not.
const DEFAULT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Directories that hold TypeScript naming Prisma models. `prisma/**` is here for the same reason
// `drift-check.mjs` reads it: `prisma/seed.ts` and the maintenance scripts in `prisma/scripts/**`
// call delegates, are covered by neither `tsconfig.json` (it compiles `src/**` only) nor eslint,
// and a typo in the seed reddens the FRONTEND's pipeline (it runs `prisma db seed` in the backend
// image to fill the e2e database — LEGACY-294), not this repo's.
const SOURCE_ROOTS = ['src', 'prisma', 'libs'];

const CLIENT_MEMBERS = new Set([
  '$transaction', '$connect', '$disconnect', '$on', '$use', '$extends', '$queryRaw',
  '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe', '$runCommandRaw', '$metrics',
  'onModuleInit', 'onModuleDestroy', 'enableShutdownHooks', 'constructor',
]);

// `PrismaService` extends `PrismaClient`, so `this.prisma.<anything it declares>` is a method
// call, not a delegate. Read those names off the class instead of hardcoding them: with a fixed
// list, the day someone adds a public helper to `PrismaService` (`this.prisma.healthPing()`)
// this gate goes red on a correct commit with the nonsense message "model does not exist in
// schema.prisma" — and the cheapest way out of a gate that lies is to switch it off.
function prismaServiceMembers(repo) {
  const names = new Set();
  try {
    const text = maskQuotes(maskComments(readFileSync(join(repo, 'src/prisma/prisma.service.ts'), 'utf8')));
    for (const m of text.matchAll(/^\s{2}(?:(?:public|private|protected|readonly|async|static)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/gm)) {
      names.add(m[1]);
    }
  } catch {
    // No PrismaService in this repo (self-test fixtures, for one) — the fixed list stands alone.
  }
  return names;
}

// Base receivers assumed prisma-like in every file, regardless of what the bootstrap pass
// finds. These are the names this codebase actually uses for a Prisma handle — read off the code,
// not off a documented rule: neither `AGENTS.md` nor `STYLE_GUIDE.md` states one. `transaction`
// is a fourth such name (`geo-block-rule.service.ts`, `rights-claims.service.ts`) and is covered
// through the bootstrap list rather than here, since it needs a confirmed model call to count.
//
// `this.client` is deliberately NOT here. It is a Prisma handle in this codebase by convention,
// but `private readonly client: S3Client` in `src/shared/storage/r2.storage.ts` is not — and the
// only thing keeping that file quiet was that it happens to mention no Prisma type today. One
// `Prisma.JsonValue` added there for an unrelated reason would have turned every `this.client
// .send(...)` into a delegate report on a perfectly correct commit. A bare `client` still counts
// when a type annotation or a confirmed model call proves it (both cover `this.client.x` too:
// `\b` matches after the dot).
const BASE_RECEIVERS = ['this.prisma', 'prisma', 'tx', 'trx', 'this.tx', 'this.db'];

/* ---------------- masking: comments and string/template literals are not code ---------------- */

// A field name spelled out inside a JSDoc comment (`@db.Text`) or a mock's string literal used
// as a plain label (`'tx.count'`) is not a delegate access — but the original script's regex
// could not tell the difference and flagged both. Comments and template literals never carry a
// real delegate access in this codebase (raw SQL lives inside templates and is out of scope for
// this checker) and are masked out unconditionally.
//
// Quoted strings ('...'/"...") are masked in two different ways for two different purposes:
// bracket-notation property access (`prisma['book']`) is real code that NEEDS its quoted content
// visible, while every other quoted string (a jest label, a URL, an error message) is just data
// and must NOT be read as a dotted `receiver.prop` accident. `maskComments` alone (quotes intact)
// feeds the bracket-access scan; `maskQuotes(maskComments(text))` additionally blanks quoted
// content and feeds the dot-access scan.
function maskComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  const keep = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') { out += keep(text[i]); i++; }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { out += keep(text[i]); i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (ch === '`') {
      out += ' ';
      i++;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        out += keep(text[i]);
        i++;
      }
      if (i < n) { out += ' '; i++; }
      continue;
    }
    // Quotes are intentionally left untouched here — see the note above.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < n) { out += text[i] + text[i + 1]; i += 2; continue; }
        out += text[i];
        i++;
      }
      if (i < n && text[i] === quote) { out += quote; i++; }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function maskQuotes(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ' ';
      i++;
      while (i < n && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n && text[i] === quote) { out += ' '; i++; }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/* ---------------- schema ---------------- */

// Prisma derives a delegate name by lowercasing the model's FIRST letter only — not by
// camel-casing an acronym. All 67 models here are single-leading-capital PascalCase (`Seo`, not
// `SEO`), and the derivation was checked character-for-character against the generated client.
function loadModels(repo) {
  const schema = readFileSync(join(repo, 'prisma/schema.prisma'), 'utf8');
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
  return new Set(models.map((m) => m[0].toLowerCase() + m.slice(1)));
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a root that does not exist in this repo (or in a self-test fixture)
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (e !== 'node_modules' && e !== 'dist') walk(p, out); }
    else if (/\.ts$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p);
  }
  return out;
}

function sourceFiles(repo) {
  return SOURCE_ROOTS.flatMap((root) => walk(join(repo, root)));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ---------------- per-file receiver discovery (bootstrap) ---------------- */

// Two independent ways a name earns the right to be treated as a Prisma client/transaction
// receiver in THIS file: (a) a type annotation the codebase actually uses for that purpose,
// (b) at least one confirmed-good access elsewhere in the same file. Either is enough — a file
// need not have both to be checked, and most files only ever have one.
//
// (a) is matched against a CLOSED world of type names — `Prisma.TransactionClient`/
// `PrismaClient`/`PrismaService` plus whatever interface this repo itself declares in the shape
// `interface X { ...; $transaction<T>(...): ...; }` (see `findClientShapedInterfaces`) — never
// against a generic "ends in Client" naming guess. A generic guess matches unrelated SDK types
// by pure naming coincidence: `private readonly client: S3Client` in
// `src/shared/storage/r2.storage.ts` matched an early "any `[A-Z]\w*Client`" version of this
// pattern and turned every `this.client.*` call in that file into a false delegate report.
function buildTypeReceiverPatterns(knownClientTypeNames) {
  const typeAlt = ['Prisma\\.TransactionClient', 'PrismaClient', 'PrismaService']
    .concat([...knownClientTypeNames].map(escapeRegExp))
    .join('|');
  return {
    typeRe: new RegExp(`\\b(\\w+)\\s*:\\s*(?:${typeAlt})\\b`, 'g'),
    // The cast must land directly on a bare identifier/member chain right after `=` (an
    // optional single wrapping paren aside) — NOT anywhere later on the line. A lazy `[^;]*?`
    // scan here previously matched `const fresh = new SitemapService(prisma as unknown as
    // PrismaService)` and bound `fresh` to `PrismaService`, when the cast actually targets the
    // constructor's inner argument, not the variable being declared.
    castRe: new RegExp(`\\b(?:const|let)\\s+(\\w+)\\s*=\\s*\\(?\\s*[\\w.]+\\s+as\\s+unknown\\s+as\\s+(?:${typeAlt})\\b`, 'g'),
    methodReturnRe: new RegExp(`\\b(\\w+)\\s*\\([^()]*\\)\\s*:\\s*(?:${typeAlt})\\s*\\{`, 'g'),
    // A getter hands out the same cast client, but is read WITHOUT parentheses:
    // `private get database(): RightsLicenseDatabaseClient` in `rights-licenses.service.ts:88`,
    // used as `this.database.rightsLicense.findMany(...)`. Registering only the `this.x()` form
    // left that whole module — the one written with a getter instead of a method — unchecked.
    getterReturnRe: new RegExp(`\\bget\\s+(\\w+)\\s*\\(\\s*\\)\\s*:\\s*(?:${typeAlt})\\s*\\{`, 'g'),
  };
}

function discoverTypedReceivers(masked, patterns) {
  const { typeRe, castRe, methodReturnRe, getterReturnRe } = patterns;
  const names = new Set();
  const methodAliases = new Set();
  const getterAliases = new Set();
  for (const m of masked.matchAll(typeRe)) names.add(m[1]);
  for (const m of masked.matchAll(castRe)) names.add(m[1]);
  for (const m of masked.matchAll(getterReturnRe)) getterAliases.add(m[1]);
  for (const m of masked.matchAll(methodReturnRe)) {
    // A getter matches the method pattern too (`get database(): X {`), but is read without
    // parentheses — it must not also register `this.database()`.
    if (!getterAliases.has(m[1])) methodAliases.add(m[1]);
  }
  return { names, methodAliases, getterAliases };
}

// Bootstrap: an untyped identifier (a plain callback parameter, never annotated because its
// type is inferred from a generic) is confirmed as a receiver when BOTH hold: its name follows
// this codebase's own naming convention for a database handle (`writeClient`, `rrTx`, `eventTx`
// — ends in Client/client/Tx/tx, or is exactly tx/trx/db/client/database), AND it has at least
// one real-model access elsewhere in the same file to bootstrap from.
//
// The name filter is load-bearing, not cosmetic: model names are ordinary English nouns
// (`category`, `book`, `author`, `tag`, `user`), so a DTO or query object with a same-named
// field (`dto.book`, `query.category`, `record.author`) would otherwise "confirm" `dto`/
// `query`/`record` as Prisma receivers and turn every OTHER field on that object into a false
// "unknown delegate access" — this exact explosion (600+ hits on a healthy repo) is what an
// unfiltered version of this bootstrap produced during development. Prisma-handle naming in
// this codebase is consistent enough (`AGENTS.md`) that the filter costs real coverage only
// on a hypothetically unconventionally-named receiver, which is the documented residual limit.
//
// The suffix is checked with a CAPITAL letter (`writeClient`, `rrTx`), never lowercase: `/[Tt]x$/`
// also matches `ctx` and `httpCtx` — the NestJS `ExecutionContext`/`ArgumentsHost` parameters this
// codebase uses in every interceptor, filter and decorator. `ctx.user` on a request context would
// then confirm `ctx` as a Prisma receiver and turn `ctx.switchToHttp()` next to it into a delegate
// report on correct code — the same collision the leading `\b` fixed for the dot-access pass.
const BOOTSTRAP_NAME_RE = /^(?:tx|trx|db|client|database|transaction)$/i;
const BOOTSTRAP_NAME_SUFFIX_RE = /(?:Client|Tx)$/;

function bootstrapConfirmedReceivers(masked, delegates) {
  const confirmed = new Set();
  // No dots in the receiver group: `writeClient.book.update(` must bind recv=writeClient,
  // prop=book, not swallow both segments into one greedy receiver ending at `.update`.
  for (const m of masked.matchAll(/\b([A-Za-z_$]\w*(?:\(\))?)\.(\w+)\b/g)) {
    const [, recv, prop] = m;
    if (!BOOTSTRAP_NAME_RE.test(recv) && !BOOTSTRAP_NAME_SUFFIX_RE.test(recv)) continue;
    if (delegates.has(prop)) confirmed.add(recv);
  }
  return confirmed;
}

/* ---------------- cast-wrapped access: the dominant ADR-011 shape ---------------- */

// `(this.prisma as unknown as Record<string, unknown>)['rightsReviewImport']` — the model name
// is a string inside a cast expression, which is exactly the shape ADR-011 warns about and by
// far the most common one here: 53 sites in src/ against 6 written as a bare `prisma['model']`.
// Two of the models (`rightsReviewImport`, `rightsAgentSubmission`) are reached from product
// code through this shape and no other, so a checker blind to it is blind to them entirely.
//
// Scanned over the whole file rather than line by line because the key is often on its own line:
//   return (this.prisma as unknown as Record<string, unknown>)[
//     'rightsAgentUploadToken'
//   ] as RightsAgentUploadTokenDelegate;
//
// The cast tail is `[^)\n]*`, not `[^)]*`: allowed to cross a newline it once ran from a
// `t as unknown as Prisma.TransactionClient,` argument on one line all the way down to an
// unrelated `(intakeRecord as Record<string, unknown>)['candidateAuthor']` three lines later
// (`rights-materialization.service.ts:914`) and reported a plain record field as a bad model.
// The key may still sit on its own line — that newline falls after the `)`, not inside the cast.
//
// The cast subject is captured, not just skipped: `(service as unknown as Record<string,
// unknown>)['delete']` in `rights-notifications.service.spec.ts:170` asserts that the service
// under test exposes no deletion path — the same syntax, a completely different object. Only a
// subject the file already knows as a Prisma handle counts.
const CAST_BRACKET_RE = /\(\s*([\w.]+)\s+as\s+unknown\s+as\s+[^)\n]*\)\s*\[\s*['"](\w+)['"]\s*\]/g;

// The same access hidden one call deeper: a helper whose body is that cast with the key coming
// from its own parameter (`private delegate(model: string) { return (this.prisma as unknown as
// Record<string, unknown>)[model] as Delegate; }` in `rights-files.service.ts:62`), called as
// `this.delegate('rightsReviewImport')`. Without this the model name is a plain string argument
// that no pass looks at, and a typo in it reaches production as a runtime
// "Cannot read properties of undefined".
const DELEGATE_HELPER_RE = /(?:private|public|protected)?\s*(?:get\s+)?(\w+)\s*\([^)]*\)\s*(?::[^{;]+)?\{[^}]*?\(\s*([\w.]+)\s+as\s+unknown\s+as\s+[^)\n]*\)\s*\[\s*\w+\s*\]/g;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/* ---------------- core scan ---------------- */

function checkRepo(repo) {
  const delegates = loadModels(repo);
  const files = sourceFiles(repo);
  const serviceMembers = prismaServiceMembers(repo);
  const isClientMember = (name) => CLIENT_MEMBERS.has(name) || serviceMembers.has(name) || name.startsWith('$');

  const badDelegates = new Map(); // "receiver.prop" -> locations[]
  const badBrackets = [];
  const seenGood = new Set();
  const out = [];
  const problems = [];

  // Discovered once, up front, from every `-interface.ts` file: the closed world of type names
  // this repo itself declares as a typed subset of the Prisma client. Feeds both the receiver
  // discovery below and the interface-declares-unknown-model report further down — one scan,
  // two consumers, so the two can never drift into disagreeing about what counts as such a type.
  // Every source file, not only `*-interface.ts`: the naming is a convention, and a convention is
  // not a barrier. Moving `rights-recheck-interface.ts` to `rights-recheck.types.ts` used to
  // switch the check off for that whole module without a word in the output.
  const clientInterfacesByFile = new Map(); // rel path -> [{name, props}]
  const knownClientTypeNames = new Set();
  for (const file of files) {
    const rel = relative(repo, file).replace(/\\/g, '/');
    const masked = maskQuotes(maskComments(readFileSync(file, 'utf8')));
    const ifaces = findClientShapedInterfaces(masked);
    if (ifaces.length === 0) continue;
    clientInterfacesByFile.set(rel, ifaces);
    for (const iface of ifaces) knownClientTypeNames.add(iface.name);
  }
  // Compiled once, not per file: the set they are built from does not change inside the loop.
  const typeReceiverPatterns = buildTypeReceiverPatterns(knownClientTypeNames);

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    // `maskedBrackets` keeps quoted content (bracket access needs it); `maskedDot` additionally
    // blanks it (an arbitrary string must never read as a dotted access) — see the comment on
    // `maskComments`/`maskQuotes` above.
    const maskedBrackets = maskComments(raw);
    const maskedDot = maskQuotes(maskedBrackets);
    const rel = relative(repo, file).replace(/\\/g, '/');

    // Pass A — loose, whole-file: any receiver at all reaching a real model marks it used.
    // Kept separate from pass B on purpose: this direction only feeds an informational report
    // (dead schema), so it can afford to be generous about what counts as a receiver.
    // Every segment of a chain is credited, not just the last one. A single greedy pattern
    // captured only the trailing name — on `this.prisma.book.findMany()` it bound `findMany` and
    // never `book` — so the one pass that is supposed to be generous about receivers missed the
    // most ordinary call shape in the codebase, and a model reached only that way would have been
    // reported dead.
    for (const m of maskedDot.matchAll(/\b[A-Za-z_$][\w$]*(?:\s*\(\s*\))?(?:\.[A-Za-z_$][\w$]*(?:\s*\(\s*\))?)+/g)) {
      const segments = m[0].split('.').map((s) => s.replace(/\s*\(\s*\)\s*$/, '').trim());
      for (let i = 1; i < segments.length; i += 1) {
        if (delegates.has(segments[i])) seenGood.add(segments[i]);
      }
    }
    for (const m of maskedBrackets.matchAll(/\[\s*['"](\w+)['"]\s*\]/g)) {
      if (delegates.has(m[1])) seenGood.add(m[1]);
    }

    // Pass B — precise: base receivers, plus this file's typed/cast receivers, plus whatever
    // bootstraps from a confirmed-good call in this same file.
    //
    // The generic base names (`tx`, `db`, `client`, ...) are gated on the file mentioning Prisma
    // at all. Without this, `this.client` collided with an S3 client field
    // (`src/shared/storage/r2.storage.ts`) that has nothing to do with Prisma — a name this
    // codebase's own convention (`AGENTS.md`) uses for a Prisma handle everywhere else, but not
    // a name reserved for it language-wide. Typed/cast/bootstrap receivers need no such gate:
    // their own signal (a `*DatabaseClient`/`Prisma.TransactionClient` type, or a confirmed
    // model call) already ties them to Prisma.
    // Tested against `maskedBrackets`, not `maskedDot`, and with `Prisma\w*` rather than a bare
    // word: a standalone script like `prisma/seed.ts` names Prisma only as `PrismaClient` and in
    // the quoted import path `'@prisma/client'` — quotes are blanked in `maskedDot`, and
    // `\bPrisma\b` does not match `PrismaClient`. With both mistakes in place the gate skipped the
    // seed entirely, and a `prisma.rolee.upsert` typo there passed green (probe, 05.09.2026).
    const touchesPrisma = /\bPrisma\w*|@prisma\/client|this\.prisma/.test(maskedBrackets);
    const { names: typedNames, methodAliases, getterAliases } = discoverTypedReceivers(
      maskedDot,
      typeReceiverPatterns,
    );
    const bootstrapped = bootstrapConfirmedReceivers(maskedDot, delegates);
    const receivers = new Set(touchesPrisma ? BASE_RECEIVERS : []);
    for (const n of typedNames) receivers.add(n);
    for (const n of bootstrapped) receivers.add(n);
    for (const n of methodAliases) receivers.add(`this.${n}()`);
    for (const n of getterAliases) receivers.add(`this.${n}`);

    if (receivers.size === 0) continue;

    const receiverAlt = [...receivers].map(escapeRegExp).sort((a, b) => b.length - a.length).join('|');
    // Leading `\b` matters: without it, a receiver as short as `tx` matches as a bare substring
    // inside an unrelated identifier — `ctx.getResponse()` was read as `tx.getResponse` this way
    // during development, and `httpCtx.getRequest()` as `tx.getRequest`.
    //
    // `[?!]?\.` covers `tx?.model` and `tx!.model` — `rights-notifications.service.ts:52` declares
    // `tx?: AgentDatabaseClient` and every call on it is optional-chained. `\s*` before the dot
    // covers a chain prettier split across lines (`this.prisma` ⏎ `.book`), which is why both
    // scans below run over the whole file text instead of line by line.
    const dotRe = new RegExp(`\\b(?:${receiverAlt})\\s*[?!]?\\.\\s*(\\w+)\\b`, 'g');
    // `[\\w$]+` in the key, not `\\w+`: without the `$` the `['$transaction']` form simply did not
    // match, so the client-member guard that the self-test claims to exercise was never reached.
    const bracketRe = new RegExp(`\\b(?:${receiverAlt})\\s*\\[\\s*['"]([\\w$]+)['"]\\s*\\]`, 'g');

    for (const m of maskedDot.matchAll(dotRe)) {
      const prop = m[1];
      if (isClientMember(prop)) continue;
      if (delegates.has(prop)) { seenGood.add(prop); continue; }
      const key = m[0].replace(/\s+/g, '');
      if (!badDelegates.has(key)) badDelegates.set(key, []);
      badDelegates.get(key).push(`${rel}:${lineOf(maskedDot, m.index)}`);
    }
    for (const m of maskedBrackets.matchAll(bracketRe)) {
      const model = m[1];
      if (isClientMember(model)) continue;
      if (delegates.has(model)) { seenGood.add(model); continue; }
      badBrackets.push({ model, loc: `${rel}:${lineOf(maskedBrackets, m.index)}` });
    }

    // Cast-wrapped bracket access, whole-file scan (the key is often on its own line).
    const isPrismaHandle = (subject) => {
      if (receivers.has(subject)) return true;
      const tail = subject.includes('.') ? subject.slice(subject.lastIndexOf('.') + 1) : subject;
      return receivers.has(tail) || BOOTSTRAP_NAME_RE.test(tail) || BOOTSTRAP_NAME_SUFFIX_RE.test(tail);
    };
    for (const m of maskedBrackets.matchAll(CAST_BRACKET_RE)) {
      const [, subject, model] = m;
      if (!isPrismaHandle(subject)) continue;
      if (isClientMember(model)) continue;
      if (delegates.has(model)) { seenGood.add(model); continue; }
      badBrackets.push({ model, loc: `${rel}:${lineOf(maskedBrackets, m.index)}` });
    }

    // A helper that takes the model name as a string argument: find the helper, then check every
    // literal handed to it. The helper's own cast subject must be a Prisma handle for the same
    // reason the cast-bracket scan checks it — `readField(key, record)` doing
    // `(record as unknown as Record<string, unknown>)[key]` is a field reader, not a delegate
    // lookup, and every key passed to it would otherwise be reported as a missing model.
    const helperNames = new Set();
    for (const m of maskedDot.matchAll(DELEGATE_HELPER_RE)) {
      if (isPrismaHandle(m[2])) helperNames.add(m[1]);
    }
    for (const helper of helperNames) {
      const callRe = new RegExp(`\\b${escapeRegExp(helper)}\\s*\\(\\s*['"](\\w+)['"]`, 'g');
      for (const m of maskedBrackets.matchAll(callRe)) {
        const model = m[1];
        if (isClientMember(model)) continue;
        if (delegates.has(model)) { seenGood.add(model); continue; }
        badBrackets.push({ model, loc: `${rel}:${lineOf(maskedBrackets, m.index)}` });
      }
    }
  }

  out.push(`schema.prisma delegates : ${delegates.size}`);
  out.push(`files read              : ${files.length}`);
  out.push(`delegates actually used : ${seenGood.size}`);
  out.push('');

  // Reading nothing and reporting agreement is the failure this whole file exists to prevent —
  // `drift-check.mjs` counts a zero-template run as a failure for the same reason. A renamed root,
  // a module moved to `apps/**`, or the documented `[repoPath]` argument pointed at the wrong
  // directory all end here, and without this the step stays green having checked no code at all.
  if (files.length === 0) {
    problems.push('no source files read');
    out.push(`## NO SOURCE FILES READ — looked in ${SOURCE_ROOTS.map((r) => `${r}/`).join(', ')} under ${repo}`);
    out.push('  A green verdict on zero files says nothing about the code. Check the repo path');
    out.push('  and SOURCE_ROOTS before trusting this run.');
    out.push('');
  }

  if (badDelegates.size) {
    problems.push('unknown delegate access');
    out.push(`## UNKNOWN DELEGATE ACCESSES (${badDelegates.size}) — model does not exist in schema.prisma`);
    for (const [key, locs] of [...badDelegates].sort()) {
      out.push(`  ${key}   (${locs.length}x)  e.g. ${locs[0]}`);
    }
    out.push('');
  } else {
    out.push('## UNKNOWN DELEGATE ACCESSES: none');
    out.push('');
  }

  if (badBrackets.length) {
    problems.push('bracket access to unknown model');
    out.push(`## BRACKET-ACCESS TO UNKNOWN MODEL (${badBrackets.length})`);
    for (const b of badBrackets) out.push(`  ['${b.model}']  ${b.loc}`);
    out.push('');
  }

  // Delegate-interface report: scoped to interfaces shaped like a typed subset of the Prisma
  // client (they declare `$transaction<T>(callback: (client: Self) => Promise<T>): ...`), not
  // to every interface in a `*-interface.ts` file. Plain data-record interfaces
  // (`PersonRecord`, `LawyerClaimRecord`, ...) live in the same files and are not delegate
  // maps — their fields are not model names, and reporting them as "NOT IN SCHEMA" was the
  // original LEGACY-045 defect.
  const interfaceIssues = [];
  for (const [rel, ifaces] of clientInterfacesByFile) {
    for (const iface of ifaces) {
      const bad = iface.props.filter((p) => !delegates.has(p) && !CLIENT_MEMBERS.has(p));
      if (bad.length) interfaceIssues.push({ rel, name: iface.name, bad });
    }
  }
  if (interfaceIssues.length) {
    problems.push('interface declares unknown model');
    out.push(`## DATABASE-CLIENT INTERFACES DECLARING UNKNOWN MODELS (${interfaceIssues.length})`);
    for (const issue of interfaceIssues) {
      out.push(`  ${issue.rel}  ${issue.name}: ${issue.bad.join(', ')}`);
    }
    out.push('');
  }

  // Known false-positive shape, left as-is on purpose: a model reached only through a relation
  // (`select: { translations: true }` on its parent, never `prisma.personTranslation.*`
  // directly — see `PersonTranslation`/LEGACY-045 closure notes) has no dot/bracket delegate
  // access to find at all. Resolving that would mean walking `schema.prisma` relations, which
  // is drift-check's job, not this one; this list is informational only for exactly that reason.
  const unusedDelegates = [...delegates].filter((d) => !seenGood.has(d));
  if (unusedDelegates.length) {
    out.push(`## MODELS NEVER ACCESSED FROM CODE (${unusedDelegates.length}) — dead schema, or reached only via a relation include/select on another model (informational, does not fail this check)`);
    out.push(`  ${unusedDelegates.join(', ')}`);
    out.push('');
  }

  return { problems, out };
}

// Finds declarations shaped like `interface Foo { ...; $transaction<T>(callback: ... ): ...; }`
// by brace-matching the header and checking the body for the `$transaction` marker, then
// collecting that body's own `key: Type;` property lines.
//
// The header accepts what TypeScript accepts, not one hand-picked spelling: type parameters
// (`interface X<T> {`), `extends`, and the `type X = { ... }` alias form. With only
// `interface NAME {` matched, renaming a file or adding `extends` to its client interface took a
// whole module out of the check without a word in the output.
const CLIENT_DECL_RE = /\b(?:interface\s+(\w+)[^{;]*|type\s+(\w+)\s*=\s*)\{/g;

function findClientShapedInterfaces(masked) {
  const results = [];
  for (const m of masked.matchAll(CLIENT_DECL_RE)) {
    const name = m[1] || m[2];
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let j = bodyStart;
    while (j < masked.length && depth > 0) {
      if (masked[j] === '{') depth++;
      else if (masked[j] === '}') depth--;
      j++;
    }
    const body = masked.slice(bodyStart, j - 1);
    if (!/\$transaction\s*</.test(body)) continue;
    // The type side is deliberately loose (`Prisma.XDelegate`, `XDelegate<Y>`, `unknown`, a
    // union): what identifies a delegate declaration is the KEY — it is the model name — and a
    // narrow `[A-Z]\w*` type pattern silently skipped the property instead of checking it.
    // `\??` is here for the same reason: an optional property is still a declared model.
    const props = [...body.matchAll(/^[ \t]*(\w+)\s*\??\s*:\s*[^;(){}]+;/gm)].map((p) => p[1]);
    results.push({ name, props });
  }
  return results;
}

/* ---------------- self-test ---------------- */

// The failure mode of a checker like this is a silent false "agree" or a false alarm loud
// enough that people learn to ignore it — LEGACY-045 was closed once, then reopened, for
// exactly the second kind. Every case below pins one concrete defect class, named after the
// real file/line it was first found at (`checkRepo` output above, before this rewrite).

const FIXTURE_SCHEMA = `
generator client {
  provider = "prisma-client-js"
}

model Book {
  id     String @id
  title  String
}

model Chapter {
  id     String @id
  bookId String
}
`;

function mustReplace(s, from, to) {
  if (!s.includes(from)) throw new Error(`fixture mutation anchor not found: ${JSON.stringify(from)}`);
  return s.replace(from, to);
}

// Both fixture models are accessed here on purpose. With `Chapter` left untouched, every case in
// the suite reported it under "MODELS NEVER ACCESSED", which made the dead-model case below
// vacuous: it passed identically with its own schema mutation removed, because the section it
// asserted on was never empty in the first place.
const FIXTURE_SOURCE = `
export class FixtureService {
  async list() {
    await this.prisma.chapter.findMany();
    return this.prisma.book.findMany();
  }
}
`;

const SELF_TEST_CASES = [
  {
    name: 'baseline: correct base-receiver access agrees',
    expect: [],
  },
  {
    name: 'unknown delegate access via base receiver (this.prisma)',
    source: (s) => mustReplace(s, 'this.prisma.book.findMany()', 'this.prisma.boook.findMany()'),
    expect: ['unknown delegate access'],
  },
  {
    // Regression for src/common/selects/public-author.select.ts:41 and
    // src/devops/dockerfiles.spec.ts:20 — a comment mentioning a field or a config file by a
    // name that happens to look like `receiver.prop` must not be read as code.
    name: 'comment mentioning a receiver-shaped name is not code',
    source: (s) => `${s}\n// see db.Text and prisma.config for context\n/* db.Text again */\n`,
    expect: [],
  },
  {
    // Regression for src/modules/category/category.service.spec.ts:605,609 — a string literal
    // used as a jest mock label ('tx.read', 'tx.count') is not a delegate access.
    name: 'string literal shaped like a receiver access is not code',
    source: (s) => `${s}\nexport const label = 'tx.count';\nexport const label2 = "tx.read";\n`,
    expect: [],
  },
  {
    // Regression for the 34 `prisma['$transaction']` hits in *.service.spec.ts — bracket
    // access to a real client member is not a model access and must not be reported.
    name: 'bracket access to a client member ($transaction) is not a model',
    source: (s) => `${s}\nexport async function run(prisma) {\n  await prisma['$transaction'](async () => {});\n}\n`,
    expect: [],
  },
  {
    name: 'bracket access to an unknown model via base receiver',
    source: (s) => `${s}\nexport async function run(prisma) {\n  return prisma['boook'];\n}\n`,
    expect: ['bracket access to unknown model'],
  },
  {
    // Regression for the getDatabase()/database/writeClient pattern in
    // rights-legal-change.service.ts and rights-content-hash.service.ts: a locally-named
    // receiver, confirmed by one correct call, must have its OTHER calls checked too.
    name: 'bootstrap: local receiver confirmed by a correct call, then misused',
    source: (s) => `${s}
export class FixtureBootstrapService {
  async run(writeClient) {
    await writeClient.book.update({ where: { id: '1' }, data: {} });
    await writeClient.boook.update({ where: { id: '1' }, data: {} });
  }
}
`,
    expect: ['unknown delegate access'],
  },
  {
    name: 'bootstrap: a receiver with no correct call anywhere stays invisible (documented limit)',
    source: (s) => `${s}
export class FixtureNoBootstrapService {
  async run(mystery) {
    await mystery.boook.update({ where: { id: '1' }, data: {} });
  }
}
`,
    expect: [],
  },
  {
    // Pins the bootstrap NAME filter, which nothing else does: model names are ordinary nouns, so
    // an ordinary object with a `book` field would otherwise be confirmed as a Prisma receiver and
    // every other field on it reported. Removing the filter turns this case red; before it existed
    // the whole suite stayed green with the filter deleted.
    name: 'bootstrap: an ordinary object with a model-named field is not a receiver',
    source: (s) => `${s}
export function describeDto(dto) {
  return [dto.book, dto.someOtherField, dto.yetAnother];
}
`,
    expect: [],
  },
  {
    // Same filter from the other side: `ctx`/`httpCtx` (NestJS ExecutionContext) end in "tx" and
    // were matched by a lowercase-tolerant suffix pattern, which made every `ctx.switchToHttp()`
    // next to a `ctx.user` a delegate report.
    name: 'bootstrap: ctx is not a transaction handle',
    schema: (s) => `${s}\nmodel User {\n  id String @id\n}\n`,
    source: (s) => `${s}
export function fromContext(ctx) {
  const current = ctx.user;
  return [current, ctx.switchToHttp(), ctx.getHandler()];
}
`,
    expect: [],
  },
  {
    // The dominant ADR-011 shape in this codebase (53 sites): the model name is a string inside a
    // cast. Blind to it, the gate is blind to `rightsReviewImport` and `rightsAgentSubmission`
    // entirely — product code reaches them this way and no other.
    name: 'cast-wrapped bracket access to an unknown model',
    source: (s) => `${s}
export class FixtureCastService {
  boook() {
    return (this.prisma as unknown as Record<string, unknown>)['boook'];
  }
}
`,
    expect: ['bracket access to unknown model'],
  },
  {
    // Same shape with the key on its own line (`rights-agent-token.service.ts:54-56`): caught only
    // because this scan runs over the whole file instead of line by line.
    name: 'cast-wrapped bracket access spanning lines',
    source: (s) => `${s}
export class FixtureMultilineCastService {
  boook() {
    return (this.prisma as unknown as Record<string, unknown>)[
      'boook'
    ] as unknown;
  }
}
`,
    expect: ['bracket access to unknown model'],
  },
  {
    // The same cast syntax on something that is not a Prisma handle: a spec asserting the service
    // under test exposes no `delete` (`rights-notifications.service.spec.ts:170`).
    name: 'cast-wrapped bracket access on a non-Prisma subject is ignored',
    source: (s) => `${s}
export function assertNoDeletion(service) {
  return (service as unknown as Record<string, unknown>)['delete'];
}
`,
    expect: [],
  },
  {
    // One call deeper: the helper takes the model name as a string argument
    // (`rights-files.service.ts:62`), so the name never appears next to a receiver at all.
    name: 'model name passed as a string to a delegate helper',
    source: (s) => `${s}
export class FixtureHelperService {
  private delegate(model: string) {
    return (this.prisma as unknown as Record<string, unknown>)[model];
  }
  load() {
    return this.delegate('boook');
  }
}
`,
    expect: ['bracket access to unknown model'],
  },
  {
    // The second defect class named in this file's own header, tested from the good side: a model
    // reached only through the alias path must NOT be reported dead.
    name: 'a model reached only via this.getX() is not reported dead',
    schema: (s) => `${s}\nmodel Tag {\n  id String @id\n}\n`,
    libSource: () => `
export interface FixtureDatabaseClient {
  tag: unknown;
  $transaction<T>(callback: (client: FixtureDatabaseClient) => Promise<T>): Promise<T>;
}
`,
    source: (s) => `${s}
import { FixtureDatabaseClient } from './fixture-db-interface';
export class FixtureAliasLiveService {
  private getDatabase(): FixtureDatabaseClient {
    return null as unknown as FixtureDatabaseClient;
  }
  async run() {
    return this.getDatabase().tag.findMany();
  }
}
`,
    expect: [],
    expectNoReport: 'tag',
  },
  {
    // Regression for rights-legal-change.service.ts:284 / rights-recheck-scheduler.service.ts —
    // a typed parameter (`database: FixtureDatabaseClient`) is a receiver even before any call
    // in this file bootstraps it, and even when it is never actually confirmed by a good call.
    name: 'typed parameter receiver catches a bad call with no prior good call',
    libSource: () => `
export interface FixtureBookDelegate {
  findMany(args?: Record<string, unknown>): Promise<unknown[]>;
}
export interface FixtureDatabaseClient {
  book: FixtureBookDelegate;
  $transaction<T>(callback: (client: FixtureDatabaseClient) => Promise<T>): Promise<T>;
}
`,
    source: (s) => `${s}
import { FixtureDatabaseClient } from './fixture-db-interface';
export class FixtureTypedParamService {
  async run(database: FixtureDatabaseClient) {
    await database.boook.findMany();
  }
}
`,
    expect: ['unknown delegate access'],
  },
  {
    // Regression for rights-legal-change.service.ts:59 (`private getDatabase(): RecheckDatabaseClient`)
    // — a method's declared return type registers `this.<method>()` as a receiver alias.
    name: 'method-return-type alias catches this.getX().model chains',
    libSource: () => `
export interface FixtureDatabaseClient {
  book: unknown;
  $transaction<T>(callback: (client: FixtureDatabaseClient) => Promise<T>): Promise<T>;
}
`,
    source: (s) => `${s}
import { FixtureDatabaseClient } from './fixture-db-interface';
export class FixtureMethodAliasService {
  private getDatabase(): FixtureDatabaseClient {
    return null as unknown as FixtureDatabaseClient;
  }
  async run() {
    await this.getDatabase().boook.findMany();
  }
}
`,
    expect: ['unknown delegate access'],
  },
  {
    // Regression for `const fresh = new SitemapService(prisma as unknown as PrismaService)` in
    // sitemap.service.spec.ts (and the same shape in rights-lawyer-review.service.spec.ts,
    // rights-recheck.service.spec.ts, import.service.spec.ts): the cast targets the
    // constructor's inner argument, not the variable being declared — `fresh`/`atomicService`/
    // `service` must NOT be treated as a Prisma-typed receiver just because a cast happens to
    // appear later on the same statement.
    name: 'a cast nested inside a constructor call does not type the outer variable',
    libSource: () => `
export interface FixtureDatabaseClient {
  book: unknown;
  $transaction<T>(callback: (client: FixtureDatabaseClient) => Promise<T>): Promise<T>;
}
`,
    source: (s) => `${s}
import { FixtureDatabaseClient } from './fixture-db-interface';
class SomeOtherService {
  constructor(_client: FixtureDatabaseClient) {}
  boook() { return undefined; }
}
export function build(prisma: unknown) {
  const built = new SomeOtherService(prisma as unknown as FixtureDatabaseClient);
  return built.boook();
}
`,
    expect: [],
  },
  {
    // Regression for the PersonRecord/LawyerClaimRecord pollution: a plain data interface's
    // fields (id, type, ...) in the same file as a real *DatabaseClient interface must not be
    // reported, only the client interface's own bad property.
    name: 'plain data-record interface fields are not delegate declarations',
    interfaceSource: () => `
export interface FixtureRecord {
  id: string;
  type: string;
  canonicalName: string;
}
export interface FixtureBookDelegate {
  findMany(args?: Record<string, unknown>): Promise<unknown[]>;
}
export interface FixtureBoookDelegate {
  findMany(args?: Record<string, unknown>): Promise<unknown[]>;
}
export interface FixtureDatabaseClient {
  book: FixtureBookDelegate;
  boook: FixtureBoookDelegate;
  $transaction<T>(callback: (client: FixtureDatabaseClient) => Promise<T>): Promise<T>;
}
`,
    expect: ['interface declares unknown model'],
    expectReport: 'boook',
  },
  {
    // Names the dead model itself, not the section header: with `Chapter` left unused in the base
    // fixture, that header was present in every case including the baseline, and this case passed
    // unchanged with its own schema mutation removed — it tested nothing of its own.
    name: 'a genuinely dead model is reported but does not fail the check',
    schema: (s) => `${s}\nmodel Tag {\n  id String @id\n}\n`,
    expect: [],
    expectReport: '  tag',
  },
  {
    // `rights-licenses.service.ts:88` is the one module that hands out its cast client through a
    // GETTER (`private get database(): RightsLicenseDatabaseClient`), read without parentheses.
    // Registering only the `this.x()` form left that module unchecked end to end.
    name: 'getter-return alias catches this.database.model without parens',
    libSource: () => `
export interface FixtureDatabaseClient {
  book: unknown;
  $transaction<T>(callback: (client: FixtureDatabaseClient) => Promise<T>): Promise<T>;
}
`,
    source: (s) => `${s}
import { FixtureDatabaseClient } from './fixture-db-interface';
export class FixtureGetterService {
  private get database(): FixtureDatabaseClient {
    return null as unknown as FixtureDatabaseClient;
  }
  async run() {
    return this.database.boook.findMany();
  }
}
`,
    expect: ['unknown delegate access'],
  },
  {
    // `rights-notifications.service.ts:52` declares `tx?: AgentDatabaseClient`; every call on it
    // is optional-chained, and a dot-only pattern matched none of them.
    name: 'optional and non-null chaining are still delegate access',
    libSource: () => `
export interface FixtureDatabaseClient {
  book: unknown;
  $transaction<T>(callback: (client: FixtureDatabaseClient) => Promise<T>): Promise<T>;
}
`,
    source: (s) => `${s}
import { FixtureDatabaseClient } from './fixture-db-interface';
export class FixtureOptionalChainService {
  async run(tx?: FixtureDatabaseClient) {
    return tx?.boook.findMany();
  }
}
`,
    expect: ['unknown delegate access'],
  },
  {
    // The closed world of client types is collected from every source file, and the header may
    // carry type parameters or `extends`: renaming `*-interface.ts` or adding `extends` used to
    // take a whole module out of the check silently.
    name: 'client interface is recognised in any file, with generics and extends',
    libSource: () => `
export interface FixtureBase {
  book: unknown;
}
export interface FixtureDatabaseClient<T = unknown> extends FixtureBase {
  $transaction<R>(callback: (client: FixtureDatabaseClient<T>) => Promise<R>): Promise<R>;
}
`,
    source: (s) => `${s}
import { FixtureDatabaseClient } from './fixture-db-interface';
export class FixtureGenericIfaceService {
  async run(database: FixtureDatabaseClient) {
    return database.boook.findMany();
  }
}
`,
    expect: ['unknown delegate access'],
  },
  {
    // A helper reading an arbitrary record field by name is not a delegate lookup: without the
    // subject check every key it is called with was reported as a missing model.
    name: 'a field-reading helper on a non-Prisma subject is ignored',
    source: (s) => `${s}
export class FixtureFieldReader {
  private readField(key: string, record: unknown) {
    return (record as unknown as Record<string, unknown>)[key];
  }
  run(row: unknown) {
    return this.readField('candidateAuthor', row);
  }
}
`,
    expect: [],
  },
  {
    // Reading nothing and reporting agreement is the failure this file exists to prevent.
    name: 'a run that reads no source files fails instead of passing',
    omitSource: true,
    expect: ['no source files read'],
    expectReport: 'NO SOURCE FILES READ',
  },
  {
    // Optional delegate property: `book?: BookDelegate;` is still a declared model, and a typo in
    // one was the single shape of this defect class the interface scan could not see.
    name: 'an optional delegate property is checked like any other',
    interfaceSource: () => `
export interface FixtureBoookDelegate {
  findMany(args?: Record<string, unknown>): Promise<unknown[]>;
}
export interface FixtureDatabaseClient {
  boook?: FixtureBoookDelegate;
  $transaction<T>(callback: (client: FixtureDatabaseClient) => Promise<T>): Promise<T>;
}
`,
    expect: ['interface declares unknown model'],
    expectReport: 'boook',
  },
];

/** The model names listed under "MODELS NEVER ACCESSED" — the line right after the header. */
function deadModels(out) {
  const header = out.findIndex((line) => line.includes('MODELS NEVER ACCESSED'));
  if (header === -1 || !out[header + 1]) return [];
  return out[header + 1].split(',').map((s) => s.trim()).filter(Boolean);
}

function countFixtureDirs() {
  return readdirSync(tmpdir()).filter((d) => d.startsWith('delegate-check-')).length;
}

function buildFixture(caseDef) {
  const root = mkdtempSync(join(tmpdir(), 'delegate-check-'));
  mkdirSync(join(root, 'prisma'), { recursive: true });
  const schemaText = caseDef.schema ? caseDef.schema(FIXTURE_SCHEMA) : FIXTURE_SCHEMA;
  writeFileSync(join(root, 'prisma', 'schema.prisma'), schemaText);
  if (caseDef.omitSource) return root; // no `src/` at all — the zero-files case
  mkdirSync(join(root, 'src'), { recursive: true });
  const sourceText = caseDef.source ? caseDef.source(FIXTURE_SOURCE) : FIXTURE_SOURCE;
  writeFileSync(join(root, 'src', 'fixture.service.ts'), sourceText);
  if (caseDef.libSource) {
    writeFileSync(join(root, 'src', 'fixture-db-interface.ts'), caseDef.libSource());
  }
  if (caseDef.interfaceSource) {
    writeFileSync(join(root, 'src', 'fixture-interface.ts'), caseDef.interfaceSource());
  }
  return root;
}

function runSelfTest() {
  let failed = 0;
  const dirsBefore = countFixtureDirs();
  for (const caseDef of SELF_TEST_CASES) {
    let root, problems, out;
    try {
      root = buildFixture(caseDef);
      ({ problems, out } = checkRepo(root));
    } catch (err) {
      console.log(`  FAIL ${caseDef.name}\n         threw: ${err.message}`);
      if (root) console.log(`         fixture left for inspection: ${root}`);
      failed++;
      continue;
    }
    const reportOk = !caseDef.expectReport || out.some((line) => line.includes(caseDef.expectReport));
    // `expectNoReport` pins the good half of a report section: "this model must NOT be listed as
    // dead". Asserting only on presence leaves the false-positive direction untested, and for the
    // informational sections that is the only direction that can go wrong quietly.
    const noReportOk = !caseDef.expectNoReport || !deadModels(out).includes(caseDef.expectNoReport);
    const expected = [...caseDef.expect].sort().join(', ') || '(none)';
    const actual = [...problems].sort().join(', ') || '(none)';
    if (expected === actual && reportOk && noReportOk) {
      console.log(`  ok   ${caseDef.name}`);
      rmSync(root, { recursive: true, force: true });
    } else {
      failed++;
      console.log(`  FAIL ${caseDef.name}\n         expected: ${expected}\n         actual:   ${actual}`);
      if (!reportOk) console.log(`         report is missing: ${caseDef.expectReport}`);
      console.log(`         fixture left for inspection: ${root}`);
    }
  }
  console.log('');
  if (failed === 0) {
    const leaked = countFixtureDirs() - dirsBefore;
    if (leaked > 0) {
      failed++;
      console.log(`FAIL  self-test cleanup: ${leaked} delegate-check-* fixture(s) left behind in ${tmpdir()}`);
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
const selfTest = argv.includes('--self-test');
const repo = argv.find((a) => !a.startsWith('--')) || DEFAULT_REPO;

if (selfTest) {
  process.exit(runSelfTest());
}

const { problems, out } = checkRepo(repo);
console.log(out.join('\n'));

if (problems.length) {
  console.log(`RESULT: DELEGATE-CHECK FAILED (${problems.join(', ')})`);
  console.log('');
  console.log('A cast (`as unknown as SomeClient`, `prisma[\'model\']`) hides a bad model name');
  console.log('from tsc — that is the exact failure mode ADR-011 documents (Phase 14). Fix the');
  console.log('model name, or the *DatabaseClient interface that declares it. See LEGACY-045.');
  process.exit(1);
}

console.log('RESULT: delegate-check passed');
