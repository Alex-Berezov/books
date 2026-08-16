#!/usr/bin/env node
// Env-key check: does every environment key the code reads exist in `.env.example`, and does
// every key declared there still have a consumer?
//
// Nothing else compares the two. There is no `validationSchema` on `ConfigModule.forRoot`
// (src/app.module.ts) and no test over `.env.example`, so a key the code reads can be missing
// from the example for years — that is exactly how LEGACY-171 lived: the geo-block policy
// variable was absent, so its default was picked by the absence of a line rather than by anyone.
//
// Names only, never values: `.env.example` holds no production secrets and must not start to.
//
// The one thing this script must never do is stay green while a key is invisible to it. Every
// read it cannot follow to a name is an error, not a shrug — see `unresolved` below.
//
// Pure Node (>= 20), no dependencies, read-only.
//
// Usage:
//   node scripts/check-env.mjs
//   node scripts/check-env.mjs --self-test
//
// A directory argument exists for the self-test fixtures and for debugging. It is not a general
// "check any repo" mode: the exception lists below describe THIS repository, so pointing the
// script at another tree reports all of them as stale.
//
// Exit code: 0 — code and `.env.example` agree; 1 — divergence, or a read this script could
// not resolve to a key name.

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
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = join(SCRIPT_DIR, '..');

/* ---------------- what counts as an environment key ---------------- */

const KEY_SHAPE = /^[A-Z][A-Z0-9_]*$/;

/** Directories whose code counts as a consumer of the environment. */
const SCAN_ROOTS = ['src', 'prisma'];

/**
 * Keys the code reads that deliberately have no line in `.env.example`.
 * A silent exception is indistinguishable from a forgotten key, so every entry carries its
 * reason here, in the script, where whoever hits the guard will read it. An entry that stops
 * matching the code is reported (see "stale exceptions") instead of quietly living on.
 */
const READ_BUT_NOT_IN_EXAMPLE = {
  SKIP_DB_CONNECT:
    'Test-only escape hatch that skips the database connection; offering it in the example would invite it into a real environment.',
  ENABLE_GEO_TEST_HEADERS:
    'Removed from the example on 15.08.2026 by LEGACY-172: it lets a client name its own country and must not be suggested for production. Still read by the code — see LEGACY-208.',
  APPLY:
    'Argument of a one-off maintenance script in prisma/scripts, passed on the command line of that run, not part of the service environment.',
  DRY_RUN:
    'Argument of a one-off maintenance script in prisma/scripts, passed on the command line of that run, not part of the service environment.',
  BATCH_SIZE:
    'Argument of a one-off maintenance script in prisma/scripts, passed on the command line of that run, not part of the service environment.',
  EXCEL_PATH:
    'Argument of the category import script in prisma/scripts, passed on the command line of that run, not part of the service environment.',
};

/**
 * Keys declared in `.env.example` that no application code reads, on purpose.
 * The second difference is otherwise counted against `src/` and `prisma/` plus every
 * `docker-compose*.yml`, so only keys with no consumer at all end up here.
 */
const IN_EXAMPLE_BUT_NOT_READ = {
  ALERT_EMAIL_FROM:
    'Superseded by the Telegram receiver (LEGACY-096): alerts go to a private channel, and Alertmanager never expands env vars. Kept in the example as a future SMTP fallback only.',
  ALERT_EMAIL_TO:
    'Superseded by the Telegram receiver (LEGACY-096): alerts go to a private channel, and Alertmanager never expands env vars. Kept in the example as a future SMTP fallback only.',
  SMTP_HOST: 'Superseded by the Telegram receiver (LEGACY-096): alerts go to a private channel, and Alertmanager never expands env vars. Kept in the example as a future SMTP fallback only.',
  SMTP_USERNAME:
    'Superseded by the Telegram receiver (LEGACY-096): alerts go to a private channel, and Alertmanager never expands env vars. Kept in the example as a future SMTP fallback only.',
  SMTP_PASSWORD:
    'Superseded by the Telegram receiver (LEGACY-096): alerts go to a private channel, and Alertmanager never expands env vars. Kept in the example as a future SMTP fallback only.',
  SLACK_WEBHOOK_URL:
    'Superseded by the Telegram receiver (LEGACY-096): alerts go to a private channel, and Alertmanager never expands env vars. Kept in the example as a future SMTP fallback only.',
  SLACK_CHANNEL:
    'Superseded by the Telegram receiver (LEGACY-096): alerts go to a private channel, and Alertmanager never expands env vars. Kept in the example as a future SMTP fallback only.',
};

/**
 * Call sites where the key name is a parameter, so it cannot be resolved by substitution.
 * Each one is a pass-through reader: the names it forwards are read at its call sites and are
 * collected there. Registered by file, argument name and a snippet of the reading line, because
 * `key` and `name` are the two most ordinary local names in this project — a whole-file pardon
 * would swallow the next genuine read that happens to use one of them. A line NUMBER would be
 * worse than either: it turns an unrelated added import into a red pipeline. An entry that
 * matches nothing is reported.
 */
const FORWARDED_READS = [
  {
    file: 'src/common/config/jwt-secrets.ts',
    arg: 'name',
    snippet: 'processEnvReader: EnvReader = (name) => process.env[name]',
    reason:
      '`processEnvReader` forwards whatever name it is handed; the names come from requireJwtSecret(JWT_*_SECRET_ENV) below it.',
  },
  {
    file: 'src/common/guards/global-rate-limit.guard.ts',
    arg: 'key',
    snippet: 'requireJwtAccessSecret((key) =>',
    reason: 'EnvReader handed to requireJwtAccessSecret(), which supplies the name itself.',
  },
  {
    file: 'src/modules/auth/auth.module.ts',
    arg: 'key',
    snippet: 'requireJwtAccessSecret((key) =>',
    reason: 'EnvReader handed to requireJwtAccessSecret(), which supplies the name itself.',
  },
  {
    file: 'src/modules/auth/auth.service.ts',
    arg: 'key',
    snippet: 'requireJwtSecret(name, (key) =>',
    reason:
      'EnvReader handed to requireJwtSecret(name), whose name is a JWT_*_SECRET_ENV constant.',
  },
  {
    file: 'src/modules/auth/auth.service.ts',
    arg: 'name',
    snippet: 'requireJwtSecret(name, (key) =>',
    reason:
      '`secret(name)` forwards its argument; its call sites pass JWT_ACCESS_SECRET_ENV / JWT_REFRESH_SECRET_ENV.',
  },
  {
    file: 'src/modules/auth/strategies/jwt.strategy.ts',
    arg: 'key',
    snippet: 'requireJwtAccessSecret((key) =>',
    reason: 'EnvReader handed to requireJwtAccessSecret(), which supplies the name itself.',
  },
];

/**
 * Helper functions whose first argument is an environment key name. Without them the JWT
 * secrets would be invisible: every read of them goes through an EnvReader callback.
 */
const KEY_TAKING_HELPERS = ['requireJwtSecret'];

/* ---------------- source scan ---------------- */

function listSourceFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
    // Keys read only by tests are not something an operator has to set.
    if (/\.(spec|e2e-spec)\.ts$/.test(entry.name)) continue;
    acc.push(full);
  }
  return acc;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Blanks out comments, keeping every other character at its original offset so reported line
 * numbers stay true. Without this a historical note mentioning an old variable turns the guard
 * red for a key nobody reads — the fastest way to teach people to ignore it (LEGACY-045).
 * Strings, template literals (including nested `${...}` expressions) and regex literals are
 * preserved: a `//` inside `` `${base}//${path}` `` is not a comment, and mistaking it for one
 * blanks the rest of a real source line and drops whatever key it reads.
 */
function blankComments(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  // One entry per open template literal: `null` while inside its plain text, otherwise the
  // `{` nesting depth inside the `${ ... }` expression currently being read as code.
  const templates = [];
  const top = () => templates.length - 1;
  let i = 0;
  let prev = '';
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];

    if (templates.length && templates[top()] === null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        templates.pop();
        prev = '`';
        i++;
        continue;
      }
      if (c === '$' && n === '{') {
        templates[top()] = 0;
        prev = '{';
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (templates.length) {
      if (c === '{') {
        templates[top()]++;
        prev = c;
        i++;
        continue;
      }
      if (c === '}') {
        if (templates[top()] === 0) templates[top()] = null;
        else templates[top()]--;
        prev = c;
        i++;
        continue;
      }
    }

    if (c === '/' && n === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && n === '*') {
      let j = i + 2;
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, text.length));
      i = j + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        if (text[j] === '\n') break;
        j++;
      }
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '`') {
      templates.push(null);
      i++;
      continue;
    }
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^<>]|^$/.test(prev)) {
      // Regex literal, not division: skip it whole so a `//` inside it is not read as a comment.
      let j = i + 1;
      let inClass = false;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        else if (text[j] === '\n') break;
        j++;
      }
      i = j + 1;
      prev = '/';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

/** `const NAME = 'KEY'` and `const OBJ = { PROP: 'KEY' }`, so a read through a constant resolves. */
function collectConstants(text) {
  const scalars = new Map();
  const members = new Map();

  const scalarRe =
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*(['"`])([^'"`\n]*)\2/g;
  for (const m of text.matchAll(scalarRe)) scalars.set(m[1], m[3]);

  const objectRe = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*\{([^{}]*)\}/g;
  for (const m of text.matchAll(objectRe)) {
    for (const p of m[2].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(['"])([^'"\n]*)\2/g)) {
      members.set(`${m[1]}.${p[1]}`, p[3]);
    }
  }
  return { scalars, members };
}

/** Names this file imports — the only ones allowed to resolve against another file's constants. */
function collectImportedNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  for (const m of text.matchAll(/import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) {
    names.add(m[1]);
  }
  return names;
}

/** Reads the first argument of a call whose `(` sits at `open`. Returns null if unbalanced. */
function firstArgument(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i).trim();
    } else if (c === ',' && depth === 1) return text.slice(open + 1, i).trim();
  }
  return null;
}

/**
 * Skips an optional-call `?.` and an optional generic argument list, so both
 * `config.get<string>('X')` and `config.get?.('X')` find their `(`. Returns -1 when the shape
 * is not understood; the caller reports that, it must never quietly skip the call.
 */
function callOpenParen(text, from) {
  let i = from;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  skipSpace();
  if (text[i] === '?' && text[i + 1] === '.') {
    i += 2;
    skipSpace();
  }
  if (text[i] === '<') {
    let depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === '<') depth++;
      // `=>` inside a generic (`get<() => string>`) is not a closing angle bracket.
      else if (text[i] === '>' && text[i - 1] !== '=' && --depth === 0) {
        i++;
        break;
      }
    }
    skipSpace();
  }
  return text[i] === '(' ? i : -1;
}

// `getOrThrow` comes first: the alternation is left-to-right, so `get|getOrThrow` would match
// the `get` of `getOrThrow` and then look for `(` where `OrThrow` stands — dropping the key
// without a word about it. The lookahead keeps `getSomething()` from matching either.
const READER_CALL_RE =
  /(?:^|[^\w$.])((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*\.\s*(?:getOrThrow|get)(?![\w$])/g;
const CONFIG_SERVICE_NAME_RE = /([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*ConfigService\b/g;
// `const cfg = app.get(ConfigService)` — the bootstrap shape, which carries no type annotation.
const CONFIG_SERVICE_FACTORY_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*[\w$.]+\s*\.\s*get(?:OrThrow)?\s*(?:<[^<>]*>)?\s*\(\s*ConfigService\s*\)/g;
const PROCESS_ENV_DOT_RE = /\bprocess\s*\.\s*env\s*\.\s*([A-Za-z_$][\w$]*)/g;
const PROCESS_ENV_BRACKET_RE = /\bprocess\s*\.\s*env\s*\[/g;
// `env: PublicSiteUrlEnv = process.env` — the alias reads keys as plain properties afterwards.
const ENV_ALIAS_RE = /([A-Za-z_$][\w$]*)\s*(?::\s*[^=,()]+?)?=\s*process\s*\.\s*env\b/g;
const ENV_DESTRUCTURE_RE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\s*\.\s*env\b/g;

/**
 * Collects every environment key `src/` reads, with the site that reads it.
 * Returns `{ reads, unresolved }`; `unresolved` is a hard error, not a warning — a read this
 * script cannot follow is a key it would silently drop, and the whole point is not dropping any.
 */
function scanSources(
  repo,
  { forwardedReads = FORWARDED_READS, helpers = KEY_TAKING_HELPERS } = {},
) {
  // `prisma/` is a consumer too, not test scaffolding: `prisma db seed` runs on every deploy
  // and the import/cleanup scripts read R2 credentials. Leaving it out made both directions
  // wrong there — a key read only from `prisma/` would be proposed for deletion.
  const files = SCAN_ROOTS.flatMap((root) => listSourceFiles(join(repo, root)));
  const reads = new Map(); // key -> ['src/x.ts:12', ...]
  const unresolved = [];
  const usedForwards = new Set();
  const configReceivers = new Set();

  // Constants are resolved file-locally first, then project-wide: `LAWYER_ENV` lives in
  // rights-lawyer.constants.ts but is read from three other modules. A name that means two
  // different keys in two files is reported rather than resolved to whichever came first.
  const perFile = new Map();
  const globalScalars = new Map(); // name -> Map(value -> file)
  const globalMembers = new Map();
  const remember = (bag, name, value, file) => {
    if (!bag.has(name)) bag.set(name, new Map());
    if (!bag.get(name).has(value)) bag.get(name).set(value, file);
  };
  for (const file of files) {
    const text = blankComments(readFileSync(file, 'utf8'));
    const consts = collectConstants(text);
    perFile.set(file, { text, consts });
    for (const [k, v] of consts.scalars) remember(globalScalars, k, v, file);
    for (const [k, v] of consts.members) remember(globalMembers, k, v, file);
    // Collected project-wide, not per file: a base class can declare `settings: ConfigService`
    // in one module while the subclass that reads keys through it lives in another.
    for (const m of text.matchAll(CONFIG_SERVICE_NAME_RE)) configReceivers.add(m[1]);
    for (const m of text.matchAll(CONFIG_SERVICE_FACTORY_RE)) configReceivers.add(m[1]);
  }

  for (const file of files) {
    const rel = relative(repo, file);
    const relPosix = rel.split(sep).join('/');
    const { text, consts } = perFile.get(file);
    const imported = collectImportedNames(text);

    const note = (key, index) => {
      const site = `${relPosix}:${lineOf(text, index)}`;
      if (!reads.has(key)) reads.set(key, []);
      if (!reads.get(key).includes(site)) reads.get(key).push(site);
    };

    const lines = text.split('\n');
    // Matched by file, argument name and a snippet of the reading line — not by line number.
    // A number pins the pardon to whatever edit happens above it: one added import turns this
    // step red on a change that has nothing to do with the environment (LEGACY-078).
    const forwardsFor = (arg, line) => {
      const hit = forwardedReads.find(
        (f) =>
          f.file.split('/').join(sep) === rel &&
          f.arg === arg &&
          (!f.snippet || (lines[line - 1] ?? '').includes(f.snippet)),
      );
      if (hit) usedForwards.add(forwardedReads.indexOf(hit));
      return Boolean(hit);
    };

    const resolveArgument = (arg, index) => {
      const line = lineOf(text, index);
      const fail = (why) => unresolved.push({ site: `${relPosix}:${line}`, arg, why });
      if (!arg) return fail('empty or unbalanced argument list');

      const literal = /^(['"`])([^'"`]*)\1$/.exec(arg);
      if (literal) {
        // A literal that is not shaped like an env key is still a read: dropping it silently
        // is the one outcome this script must not produce.
        if (KEY_SHAPE.test(literal[2])) note(literal[2], index);
        else fail(`literal "${literal[2]}" is not shaped like an environment key`);
        return;
      }
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(arg)) {
        return fail('not a literal and not a plain constant reference');
      }

      // Registered pass-throughs are checked before the constants: those are collected per file
      // without scope, so an unrelated `const key = ...` elsewhere in the file would otherwise
      // answer for a parameter that happens to share its name.
      if (forwardsFor(arg, line)) return; // keys collected at the reader's call sites

      const local = consts.members.get(arg) ?? consts.scalars.get(arg);
      if (local !== undefined) {
        if (KEY_SHAPE.test(local)) note(local, index);
        else fail(`${arg} resolves to "${local}", which is not shaped like an environment key`);
        return;
      }
      // Cross-file resolution only for names this file actually imports. Without that check a
      // `const key = 'cache:v1'` in some unrelated module answers for the parameter named `key`
      // here, the value fails the key shape, and the read disappears without a word.
      const base = arg.split('.')[0];
      const global = imported.has(base) ? (globalMembers.get(arg) ?? globalScalars.get(arg)) : null;
      if (global) {
        if (global.size > 1) {
          return fail(
            `constant ${arg} means different things in ${[...global.values()]
              .map((f) => relative(repo, f).split(sep).join('/'))
              .join(' and ')}`,
          );
        }
        const [value] = [...global.keys()];
        if (KEY_SHAPE.test(value)) note(value, index);
        else fail(`${arg} resolves to "${value}", which is not shaped like an environment key`);
        return;
      }
      fail('cannot be resolved to a name');
    };

    // Receivers of `.get()` that are a ConfigService: by declared type anywhere in the project,
    // by `app.get(ConfigService)`, plus the naming convention. Without those a service injected
    // as `cfg`, or reached through a base class, reads nothing at all.
    for (const m of text.matchAll(READER_CALL_RE)) {
      // `this.config`, `b.settings`, `svc` — the last segment is the object being read from.
      const receiver = m[1].split('.').pop().trim();
      if (!configReceivers.has(receiver) && !/config/i.test(receiver)) continue;
      const at = m.index + m[0].length;
      const open = callOpenParen(text, at);
      if (open === -1) {
        unresolved.push({
          site: `${relPosix}:${lineOf(text, m.index)}`,
          arg: m[0].trim(),
          why: 'call shape not understood, so its argument was never read',
        });
        continue;
      }
      resolveArgument(firstArgument(text, open), m.index);
    }

    for (const helper of helpers) {
      const re = new RegExp(`\\b${helper}\\s*\\(`, 'g');
      for (const m of text.matchAll(re)) {
        // The declaration of the helper is not a read: its parameter list would resolve to
        // `name: string` and be reported as an unresolvable key.
        if (/\bfunction\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
        resolveArgument(firstArgument(text, m.index + m[0].length - 1), m.index);
      }
    }

    for (const m of text.matchAll(PROCESS_ENV_DOT_RE)) {
      if (KEY_SHAPE.test(m[1])) note(m[1], m.index);
    }
    // The whole bracket expression goes through the same resolver as `config.get(...)`, so an
    // index this script cannot follow (`process.env[names[i]]`) is reported rather than missed.
    for (const m of text.matchAll(PROCESS_ENV_BRACKET_RE)) {
      resolveArgument(firstArgument(text, m.index + m[0].length - 1), m.index);
    }
    for (const m of text.matchAll(ENV_DESTRUCTURE_RE)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/[:=]/)[0].trim();
        if (KEY_SHAPE.test(name)) note(name, m.index);
      }
    }

    // Aliases of `process.env`: `resolvePublicSiteUrl(env = process.env)` then `env.PUBLIC_SITE_URL`.
    const aliases = new Set();
    for (const m of text.matchAll(ENV_ALIAS_RE)) aliases.add(m[1]);
    for (const alias of aliases) {
      const dotted = new RegExp(
        `\\b(?:this\\s*\\.\\s*)?${alias}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`,
        'g',
      );
      for (const m of text.matchAll(dotted)) if (KEY_SHAPE.test(m[1])) note(m[1], m.index);
      const indexed = new RegExp(
        `\\b(?:this\\s*\\.\\s*)?${alias}\\s*\\[\\s*(['"\`])([^'"\`\\n]*)\\1\\s*\\]`,
        'g',
      );
      for (const m of text.matchAll(indexed)) if (KEY_SHAPE.test(m[2])) note(m[2], m.index);
    }
  }

  const staleForwards = forwardedReads
    .filter((_, i) => !usedForwards.has(i))
    .map((f) => `${f.file} (${f.arg}) — registered as a pass-through, matched nothing`);

  return { reads, unresolved, staleForwards, fileCount: files.length };
}

/* ---------------- declarations and other consumers ---------------- */

/**
 * Keys declared in `.env.example`. A commented-out line counts: it documents the key.
 * On a repeated key the last line wins, the way dotenv itself reads the file — reporting the
 * first one would point at a line that does not decide anything.
 */
function parseEnvExample(text) {
  const declared = new Map(); // key -> line number
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = /^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)\s*=/.exec(raw);
    if (m) declared.set(m[1], i + 1);
  });
  return declared;
}

/**
 * Keys the Compose stack interpolates. Half of `.env.example` is read by Compose and not by the
 * application at all (`POSTGRES_*`, the monitoring ports); without this the guard would demand
 * that working settings be deleted. Comments do not count as a consumer.
 */
function scanCompose(repo) {
  const used = new Map(); // key -> ['docker-compose.yml:12', ...]
  for (const dir of ['.', '.devcontainer']) {
    const full = join(repo, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full).sort()) {
      if (!/^docker-compose.*\.ya?ml$/.test(name)) continue;
      const text = readFileSync(join(full, name), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
        .join('\n');
      const label = dir === '.' ? name : `${dir}/${name}`;
      for (const m of text.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g)) {
        const site = `${label}:${lineOf(text, m.index)}`;
        if (!used.has(m[1])) used.set(m[1], []);
        if (!used.get(m[1]).includes(site)) used.get(m[1]).push(site);
      }
    }
  }
  return used;
}

/* ---------------- compare ---------------- */

function compare(
  { reads, unresolved, staleForwards, fileCount },
  declared,
  compose,
  exceptions = {},
) {
  const notInExample = exceptions.readButNotInExample ?? READ_BUT_NOT_IN_EXAMPLE;
  const notRead = exceptions.inExampleButNotRead ?? IN_EXAMPLE_BUT_NOT_READ;
  const problems = [];
  const out = [];

  out.push(`src/ + prisma/  : ${fileCount} files -> ${reads.size} environment keys read`);
  out.push(`.env.example    : ${declared.size} keys declared`);
  out.push(`docker-compose* : ${compose.size} keys interpolated`);
  out.push('');

  const undeclared = [...reads.keys()]
    .filter((k) => !declared.has(k) && !(k in notInExample))
    .sort();
  const unused = [...declared.keys()]
    .filter((k) => !reads.has(k) && !compose.has(k) && !(k in notRead))
    .sort();

  if (unresolved.length) {
    problems.push('unresolved reads');
    out.push(`## READS THIS SCRIPT COULD NOT RESOLVE TO A KEY NAME (${unresolved.length})`);
    out.push('   A read it cannot follow is a key it would drop, so it stops instead.');
    out.push('   Name the key with a constant, or register the site in FORWARDED_READS.');
    for (const u of unresolved) out.push(`  ! ${u.arg} <- ${u.site} (${u.why})`);
    out.push('');
  }

  if (undeclared.length) {
    problems.push('read but not declared');
    out.push(`## READ BY THE CODE, MISSING FROM .env.example (${undeclared.length})`);
    for (const key of undeclared) out.push(`  - ${key} <- ${reads.get(key).join(', ')}`);
    out.push('');
  }

  if (unused.length) {
    problems.push('declared but never read');
    out.push(`## DECLARED IN .env.example, READ BY NOTHING (${unused.length})`);
    out.push('   Not read by src/ or prisma/, not interpolated by any docker-compose*.yml.');
    for (const key of unused) out.push(`  - ${key} <- .env.example:${declared.get(key)}`);
    out.push('');
  }

  // An exception that no longer describes anything is worse than no exception: it keeps a key
  // silenced after the situation that justified it is gone.
  const stale = [...staleForwards];
  for (const key of Object.keys(notInExample)) {
    if (declared.has(key))
      stale.push(
        `${key} — listed as absent on purpose, but .env.example:${declared.get(key)} declares it`,
      );
    else if (!reads.has(key)) stale.push(`${key} — listed as read by src/, but nothing reads it`);
  }
  for (const key of Object.keys(notRead)) {
    if (!declared.has(key))
      stale.push(`${key} — listed as declared but unread, and .env.example does not declare it`);
    else if (reads.has(key))
      stale.push(`${key} — listed as read by nothing, but ${reads.get(key)[0]} reads it`);
    else if (compose.has(key))
      stale.push(`${key} — listed as read by nothing, but ${compose.get(key)[0]} interpolates it`);
  }
  if (stale.length) {
    problems.push('stale exceptions');
    out.push(`## EXCEPTION LIST NO LONGER MATCHES THE CODE (${stale.length})`);
    for (const line of stale) out.push(`  ! ${line}`);
    out.push('');
  }

  return { problems: [...new Set(problems)], out };
}

function checkRepo(repo, options = {}) {
  const scan = scanSources(repo, options);
  const examplePath = join(repo, '.env.example');
  if (!existsSync(examplePath)) {
    return {
      problems: ['no .env.example'],
      out: [`## NO .env.example AT ${examplePath}`, '   Nothing to compare the code against.'],
    };
  }
  return compare(
    scan,
    parseEnvExample(readFileSync(examplePath, 'utf8')),
    scanCompose(repo),
    options,
  );
}

/* ---------------- self-test ---------------- */

// The failure mode of a checker like this is a silent green: a scanner gap turns a missing key
// into "everything agrees". Each fixture pins one thing the script claims to detect, and the
// cases that expect nothing carry a mutation of their own, so they cannot pass by being the
// baseline in disguise.

const FIXTURE_SOURCE = `
import { Injectable } from '@nestjs/common';
import { FIXTURE_SHARED_ENV } from './shared.constants';

const UNKNOWN_COUNTRY_POLICY_ENV = 'FIXTURE_POLICY';

export const FIXTURE_ENV = {
  FLAG: 'FIXTURE_FLAG',
} as const;

@Injectable()
export class FixtureService {
  constructor(private readonly cfg: ConfigService) {}

  read(): void {
    this.cfg.get<string>('FIXTURE_PLAIN');
    this.cfg.getOrThrow<string>('FIXTURE_REQUIRED');
    this.cfg.get?.('FIXTURE_OPTIONAL_CALL');
    this.cfg.get<() => string>('FIXTURE_GENERIC_ARROW');
    this.cfg.getSettings('FIXTURE_NOT_A_GETTER_AT_ALL');
    this.cfg.get<string>(UNKNOWN_COUNTRY_POLICY_ENV);
    this.cfg.get(FIXTURE_ENV.FLAG);
    this.cfg.get(FIXTURE_SHARED_ENV.SHARED);
    const host = process.env.FIXTURE_HOST;
    const port = process.env['FIXTURE_PORT'];
    const { FIXTURE_DESTRUCTURED } = process.env;
    void host;
    void port;
    void FIXTURE_DESTRUCTURED;
  }
}

export function resolveFixtureUrl(env: FixtureEnv = process.env): string {
  return env.FIXTURE_ALIASED ?? 'fallback';
}
`;

// Kept apart from the main fixture so the cases that assert "this is not a read" fail on their
// own rather than only together with the baseline.
const FIXTURE_COMMENT_TRAP = `
// A historical note about this.config.get('FIXTURE_FROM_LINE_COMMENT') must not count.
/** And a doc block mentioning process.env.FIXTURE_FROM_BLOCK_COMMENT must not either. */
export const joined = (base: string, path: string): string => \`\${base}//\${path}\`;
// This line comment follows a template literal containing a double slash, which is where a
// naive scanner loses track of the mode and starts blanking real code:
// this.config.get('FIXTURE_FROM_COMMENT_AFTER_TEMPLATE')
`;

const FIXTURE_SHARED = `
export const FIXTURE_SHARED_ENV = {
  SHARED: 'FIXTURE_SHARED',
} as const;
`;

const FIXTURE_EXAMPLE = `
# Fixture example file
FIXTURE_PLAIN=1
FIXTURE_REQUIRED=1
FIXTURE_OPTIONAL_CALL=1
FIXTURE_GENERIC_ARROW=1
FIXTURE_POLICY=deny
FIXTURE_FLAG=false
FIXTURE_SHARED=1
FIXTURE_HOST=localhost
# FIXTURE_PORT=3000
FIXTURE_DESTRUCTURED=1
FIXTURE_ALIASED=https://example.com
FIXTURE_COMPOSE_ONLY=postgres
`;

const FIXTURE_COMPOSE = `
services:
  db:
    image: postgres
    # \${FIXTURE_MENTIONED_IN_A_COMMENT} is not a consumer
    environment:
      POSTGRES_DB: \${FIXTURE_COMPOSE_ONLY}
`;

const lineIn = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;

const SELF_TEST_CASES = [
  {
    name: 'baseline: code and .env.example agree',
    expect: [],
  },
  {
    name: 'key read by code, missing from the example',
    example: (t) => t.replace('FIXTURE_PLAIN=1\n', ''),
    expect: ['read but not declared'],
    // §6 of the record: the report must name key and site, not a count.
    expectOut: (out) =>
      out.includes(
        `  - FIXTURE_PLAIN <- src/fixture.service.ts:${lineIn(FIXTURE_SOURCE, "'FIXTURE_PLAIN'")}`,
      ),
  },
  {
    // `get|getOrThrow` matches the `get` of `getOrThrow` and then loses the key entirely.
    name: 'getOrThrow is read like get, not silently dropped',
    example: (t) => t.replace('FIXTURE_REQUIRED=1\n', ''),
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('- FIXTURE_REQUIRED <- src/fixture.service.ts:'),
  },
  {
    // `cfg.get?.('K')` — the `?` stands where the `(` is looked for.
    name: 'an optional call is read, not skipped',
    example: (t) => t.replace('FIXTURE_OPTIONAL_CALL=1\n', ''),
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('- FIXTURE_OPTIONAL_CALL <-'),
  },
  {
    // `get<() => string>(...)` — the `>` of `=>` closes the generic early.
    name: 'a generic containing an arrow type is read',
    example: (t) => t.replace('FIXTURE_GENERIC_ARROW=1\n', ''),
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('- FIXTURE_GENERIC_ARROW <-'),
  },
  {
    // The lookahead after `get`, not the order of the alternation, is what keeps `getSettings`
    // out. The fixture calls `cfg.getSettings('FIXTURE_NOT_A_GETTER_AT_ALL')` and nothing
    // declares that key, so reading it would show up here.
    name: 'a method whose name merely starts with get is not a config read',
    expect: [],
  },
  {
    name: 'a key named only inside a comment is not a read',
    commentTrap: true,
    expect: [],
  },
  {
    // A `//` inside `${...}` is not a comment; treating it as one blanks the rest of the line.
    name: 'a double slash inside a template literal does not blank the code after it',
    commentTrap: true,
    extraFile: {
      name: 'template.ts',
      body: `export const url = (h: string) => \`\${h}//x\`;\nexport const read = (config: ConfigService) => config.get<string>('FIXTURE_AFTER_TEMPLATE');\n`,
    },
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('- FIXTURE_AFTER_TEMPLATE <- src/template.ts:2'),
  },
  {
    name: 'key declared in the example, read by nothing',
    example: (t) => `${t}FIXTURE_ORPHAN=1\n`,
    expect: ['declared but never read'],
    expectOut: (out) => /- FIXTURE_ORPHAN <- \.env\.example:\d+/.test(out),
  },
  {
    // The reason this check exists: RIGHTS_GEO_UNKNOWN_COUNTRY_POLICY is read through a
    // constant, and a scanner that misses it proposes deleting the line from the example.
    name: 'read through a local constant is seen, not proposed for deletion',
    example: (t) => t.replace('FIXTURE_POLICY=deny\n', ''),
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('- FIXTURE_POLICY <-'),
  },
  {
    name: 'read through a constant object is seen',
    example: (t) => t.replace('FIXTURE_FLAG=false\n', ''),
    expect: ['read but not declared'],
  },
  {
    // `LAWYER_ENV` is declared in one module and read from three others.
    name: 'read through a constant imported from another file is seen',
    example: (t) => t.replace('FIXTURE_SHARED=1\n', ''),
    expect: ['read but not declared'],
  },
  {
    // `PUBLIC_SITE_URL` is read exactly this way; missing it kept the guard green over a live
    // instance of the defect the record was opened for.
    name: 'read through an alias of process.env is seen',
    example: (t) => t.replace('FIXTURE_ALIASED=https://example.com\n', ''),
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('- FIXTURE_ALIASED <-'),
  },
  {
    name: 'read through destructuring of process.env is seen',
    example: (t) => t.replace('FIXTURE_DESTRUCTURED=1\n', ''),
    expect: ['read but not declared'],
  },
  {
    name: 'a receiver named something other than config is still a ConfigService',
    // The whole fixture injects `cfg`, so a scanner keyed on the name reads nothing at all.
    example: (t) => t.replace('FIXTURE_PLAIN=1\n', '').replace('FIXTURE_FLAG=false\n', ''),
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('FIXTURE_PLAIN') && out.includes('FIXTURE_FLAG'),
  },
  {
    // A ConfigService reached through a base class declared in another file, or taken from
    // `app.get(ConfigService)`, has neither the name nor a local type annotation to go by.
    name: 'a ConfigService named in another file is still a config read',
    extraFile: {
      name: 'base.ts',
      body: `export abstract class Base {\n  protected readonly settings: ConfigService;\n}\nexport const read = (b: Base) => b.settings.get<string>('FIXTURE_VIA_BASE_CLASS');\n`,
    },
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('- FIXTURE_VIA_BASE_CLASS <-'),
  },
  {
    name: 'a ConfigService taken from app.get(ConfigService) is still a config read',
    extraFile: {
      name: 'bootstrap.ts',
      body: `const svc = app.get(ConfigService);\nexport const port = svc.get<string>('FIXTURE_FROM_BOOTSTRAP');\n`,
    },
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('- FIXTURE_FROM_BOOTSTRAP <-'),
  },
  {
    name: 'an index into process.env that is not a literal is reported, not dropped',
    extraFile: {
      name: 'dynamic-index.ts',
      body: `export const read = (names: string[], i: number) => process.env[names[i]];\n`,
    },
    expect: ['unresolved reads'],
  },
  {
    name: 'a key read only from prisma/ counts as read',
    prismaFile: `const admins = process.env.FIXTURE_PRISMA_ONLY;\nvoid admins;\n`,
    example: (t) => `${t}FIXTURE_PRISMA_ONLY=1\n`,
    expect: [],
  },
  {
    name: 'and it is required in the example like any other',
    prismaFile: `const admins = process.env.FIXTURE_PRISMA_ONLY;\nvoid admins;\n`,
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('- FIXTURE_PRISMA_ONLY <- prisma/seed.ts:1'),
  },
  {
    name: 'a commented-out line counts as declared',
    // FIXTURE_PORT exists in the example only as `# FIXTURE_PORT=3000`; uncommenting it must
    // change nothing, and removing it must turn the check red.
    example: (t) => t.replace('# FIXTURE_PORT=3000', 'FIXTURE_PORT=3000'),
    expect: [],
  },
  {
    name: 'removing that commented-out line does turn the check red',
    example: (t) => t.replace('# FIXTURE_PORT=3000\n', ''),
    expect: ['read but not declared'],
  },
  {
    name: 'key used only by docker-compose is not reported as unused',
    // Prove the compose file is what saves it: without the file the same key is reported.
    expect: [],
  },
  {
    name: 'without the compose file the compose-only key is reported',
    compose: null,
    expect: ['declared but never read'],
    expectOut: (out) => out.includes('- FIXTURE_COMPOSE_ONLY <-'),
  },
  {
    name: 'a key mentioned only in a compose comment is not a consumer',
    example: (t) => `${t}FIXTURE_MENTIONED_IN_A_COMMENT=1\n`,
    expect: ['declared but never read'],
  },
  {
    name: 'key read only by a .spec.ts file is not required in the example',
    extraFile: { name: 'fixture.spec.ts', body: `const x = process.env.FIXTURE_TEST_ONLY;\n` },
    expect: [],
  },
  {
    name: 'read this script cannot resolve fails loudly instead of dropping the key',
    extraFile: {
      name: 'dynamic.ts',
      body: `export const read = (config: ConfigService, name: string) => config.get<string>(name);\n`,
    },
    expect: ['unresolved reads'],
    expectOut: (out) => out.includes('! name <- src/dynamic.ts:1'),
  },
  {
    name: 'a string literal that is not shaped like a key is reported, not dropped',
    extraFile: {
      name: 'lowercase.ts',
      body: `export const read = (config: ConfigService) => config.get<string>('database.host');\n`,
    },
    expect: ['unresolved reads'],
  },
  {
    name: 'a registered pass-through reader is accepted',
    extraFile: {
      name: 'dynamic.ts',
      body: `export const read = (config: ConfigService, name: string) => config.get<string>(name);\n`,
    },
    forwardedReads: [{ file: 'src/dynamic.ts', arg: 'name', line: 1, reason: 'fixture' }],
    expect: [],
  },
  {
    name: 'a pass-through registration whose snippet does not match does not pardon the read',
    extraFile: {
      name: 'dynamic.ts',
      body: `export const read = (config: ConfigService, name: string) => config.get<string>(name);\n`,
    },
    forwardedReads: [
      { file: 'src/dynamic.ts', arg: 'name', snippet: 'somethingElse(', reason: 'fixture' },
    ],
    expect: ['unresolved reads', 'stale exceptions'],
  },
  {
    // The pardon is per argument name, not per site: another unresolvable read on the same
    // line must still be reported.
    name: 'a pass-through registration pardons only the argument it names',
    extraFile: {
      name: 'dynamic.ts',
      body: `export const read = (config: ConfigService, name: string, other: string) => config.get<string>(name) ?? config.get<string>(other);\n`,
    },
    forwardedReads: [{ file: 'src/dynamic.ts', arg: 'name', reason: 'fixture' }],
    expect: ['unresolved reads'],
    expectOut: (out) => out.includes('! other <-') && !out.includes('! name <-'),
  },
  {
    name: 'a pass-through registration that matches nothing is reported',
    forwardedReads: [{ file: 'src/nowhere.ts', arg: 'name', reason: 'fixture' }],
    expect: ['stale exceptions'],
  },
  {
    // Without this the JWT secrets would be invisible: they are only ever read through a callback.
    name: 'a key handed to a registered helper is seen',
    extraFile: {
      name: 'helper.ts',
      body: `export function requireFixtureSecret(name: string): string { return name; }\nexport const value = requireFixtureSecret('FIXTURE_HELPER_KEY');\n`,
    },
    helpers: ['requireFixtureSecret'],
    expect: ['read but not declared'],
    expectOut: (out) => out.includes('- FIXTURE_HELPER_KEY <- src/helper.ts:2'),
  },
  {
    name: 'the declaration of that helper is not itself read as a key',
    extraFile: {
      name: 'helper.ts',
      body: `export function requireFixtureSecret(name: string): string { return name; }\n`,
    },
    helpers: ['requireFixtureSecret'],
    expect: [],
  },
  {
    name: 'one constant name meaning two keys is reported, not resolved to whichever came first',
    extraFile: {
      name: 'collision.ts',
      body: `export const FIXTURE_SHARED_ENV = { SHARED: 'FIXTURE_OTHER' } as const;\n`,
    },
    example: (t) => t.replace('FIXTURE_SHARED=1\n', ''),
    expect: ['unresolved reads'],
  },
  {
    name: 'an exception list entry silences a key that is genuinely absent on purpose',
    example: (t) => t.replace('FIXTURE_PLAIN=1\n', ''),
    readButNotInExample: { FIXTURE_PLAIN: 'fixture reason' },
    expect: [],
  },
  {
    name: 'an exception the code outgrew is reported instead of staying silent',
    readButNotInExample: { FIXTURE_PLAIN: 'fixture reason' }, // the key is declared again
    expect: ['stale exceptions'],
  },
  {
    name: 'an exception for a key nothing reads any more is reported',
    readButNotInExample: { FIXTURE_GONE: 'fixture reason' },
    expect: ['stale exceptions'],
  },
  {
    name: 'an exception for a key nothing declares is reported too',
    inExampleButNotRead: { FIXTURE_GONE: 'fixture reason' },
    expect: ['stale exceptions'],
  },
  {
    name: 'an unread-exception for a key that is in fact read is reported',
    inExampleButNotRead: { FIXTURE_PLAIN: 'fixture reason' },
    expect: ['stale exceptions'],
  },
  {
    name: 'an unread-exception for a key compose interpolates is reported',
    inExampleButNotRead: { FIXTURE_COMPOSE_ONLY: 'fixture reason' },
    expect: ['stale exceptions'],
  },
  {
    name: 'a repeated declaration is read the way dotenv reads it — the last one wins',
    example: (t) => `${t}FIXTURE_ORPHAN=1\n# FIXTURE_ORPHAN=2\n`,
    expect: ['declared but never read'],
    expectOut: (out) => /- FIXTURE_ORPHAN <- \.env\.example:(\d+)/.test(out),
  },
  {
    name: 'a missing .env.example is a failure with a readable message',
    example: null,
    expect: ['no .env.example'],
  },
];

function buildFixture(caseDef) {
  const root = mkdtempSync(join(tmpdir(), 'check-env-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'fixture.service.ts'), FIXTURE_SOURCE);
  writeFileSync(join(root, 'src', 'shared.constants.ts'), FIXTURE_SHARED);
  if (caseDef.commentTrap) writeFileSync(join(root, 'src', 'comments.ts'), FIXTURE_COMMENT_TRAP);
  if (caseDef.prismaFile) {
    mkdirSync(join(root, 'prisma'), { recursive: true });
    writeFileSync(join(root, 'prisma', 'seed.ts'), caseDef.prismaFile);
  }
  if (caseDef.example !== null) {
    writeFileSync(
      join(root, '.env.example'),
      caseDef.example ? caseDef.example(FIXTURE_EXAMPLE) : FIXTURE_EXAMPLE,
    );
  }
  if (caseDef.compose !== null) writeFileSync(join(root, 'docker-compose.yml'), FIXTURE_COMPOSE);
  if (caseDef.extraFile) {
    writeFileSync(join(root, 'src', caseDef.extraFile.name), caseDef.extraFile.body);
  }
  return root;
}

function runSelfTest() {
  let failed = 0;
  for (const caseDef of SELF_TEST_CASES) {
    const root = buildFixture(caseDef);
    let problems;
    let out;
    try {
      ({ problems, out } = checkRepo(root, {
        forwardedReads: caseDef.forwardedReads ?? [],
        helpers: caseDef.helpers ?? [],
        readButNotInExample: caseDef.readButNotInExample ?? {},
        inExampleButNotRead: caseDef.inExampleButNotRead ?? {},
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const expected = [...caseDef.expect].sort().join(', ') || '(none)';
    const actual = [...problems].sort().join(', ') || '(none)';
    const report = out.join('\n');
    const outOk = !caseDef.expectOut || caseDef.expectOut(report);
    if (expected === actual && outOk) {
      console.log(`  ok   ${caseDef.name}`);
    } else {
      failed++;
      console.log(`  FAIL ${caseDef.name}`);
      if (expected !== actual)
        console.log(`         expected: ${expected}\n         actual:   ${actual}`);
      if (!outOk) console.log(`         report did not contain what the case asserts:\n${report}`);
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
const repo = argv.find((a) => !a.startsWith('--')) || DEFAULT_REPO;

if (argv.includes('--self-test')) {
  process.exit(runSelfTest());
}

const { problems, out } = checkRepo(repo);
console.log(out.join('\n'));

if (problems.length) {
  console.log(`RESULT: ENV KEYS OUT OF SYNC (${problems.join(', ')})`);
  console.log('');
  console.log('Either the code reads a key nobody documented, or .env.example offers a key');
  console.log('nothing reads. Fix the example, or add the key to the exception list in this');
  console.log('script with the reason it belongs there.');
  process.exit(1);
}

console.log('RESULT: code and .env.example agree on key names');
