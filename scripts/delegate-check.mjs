#!/usr/bin/env node
// R0 / SUSPECT-04: every Prisma delegate touched from code must exist in schema.prisma.
// The delegate-interface + cast pattern (ADR-011) hides bad model names from tsc; this is the
// exact failure mode that broke Phase 14 in production. Read-only.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = process.argv[2] || 'D:/newDev/books';
const SRC = join(REPO, 'src');

const schema = readFileSync(join(REPO, 'prisma/schema.prisma'), 'utf8');
const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
const delegates = new Set(models.map((m) => m[0].toLowerCase() + m.slice(1)));
const modelSet = new Set(models);

// PrismaClient members that are not model delegates
const CLIENT_MEMBERS = new Set([
  '$transaction', '$connect', '$disconnect', '$on', '$use', '$extends', '$queryRaw',
  '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe', '$runCommandRaw', '$metrics',
  'onModuleInit', 'onModuleDestroy', 'enableShutdownHooks', 'constructor',
]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (e !== 'node_modules' && e !== 'dist') walk(p, out); }
    else if (/\.ts$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const badDelegates = new Map();   // "receiver.prop" -> [locations]
const bracketAccess = [];         // prisma['model'] style
const seenGood = new Set();

// receivers that hold a Prisma client / transaction client
const RECEIVER = /\b(?:this\.prisma|prisma|tx|trx|client|db|this\.tx|this\.db|this\.client)\b/;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(REPO, file).replace(/\\/g, '/');
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    // dot access: prisma.foo / this.prisma.foo / tx.foo
    for (const m of line.matchAll(/\b(this\.prisma|prisma|tx|trx|this\.tx|this\.db|db)\.(\w+)\b/g)) {
      const [, recv, prop] = m;
      if (CLIENT_MEMBERS.has(prop) || prop.startsWith('$')) continue;
      // skip obvious non-delegate helpers
      if (/^(service|module|schema|client|constructor|then|catch|finally)$/.test(prop)) continue;
      const key = `${recv}.${prop}`;
      if (delegates.has(prop)) { seenGood.add(prop); continue; }
      if (!badDelegates.has(key)) badDelegates.set(key, []);
      badDelegates.get(key).push(`${rel}:${i + 1}`);
    }
    // bracket access: prisma['rightsClaim'] — used to reach models tsc does not know
    for (const m of line.matchAll(/\b(?:this\.prisma|prisma|tx|trx)\s*\[\s*'([^']+)'\s*\]/g)) {
      bracketAccess.push({ model: m[1], loc: `${rel}:${i + 1}`, ok: delegates.has(m[1]) });
    }
  });
}

console.log(`schema.prisma delegates : ${delegates.size}`);
console.log(`delegates actually used : ${seenGood.size}`);
console.log('');

const unusedDelegates = [...delegates].filter((d) => !seenGood.has(d));

if (badDelegates.size) {
  console.log(`## UNKNOWN DELEGATE ACCESSES (${badDelegates.size}) — model does not exist in schema.prisma`);
  for (const [key, locs] of [...badDelegates].sort()) {
    console.log(`  ${key}   (${locs.length}x)  e.g. ${locs[0]}`);
  }
  console.log('');
} else {
  console.log('## UNKNOWN DELEGATE ACCESSES: none\n');
}

const badBrackets = bracketAccess.filter((b) => !b.ok);
if (badBrackets.length) {
  console.log(`## BRACKET-ACCESS TO UNKNOWN MODEL (${badBrackets.length})`);
  badBrackets.forEach((b) => console.log(`  prisma['${b.model}']  ${b.loc}`));
  console.log('');
}

// delegate interfaces: which model names do they claim to expose?
console.log('## DELEGATE INTERFACE FILES — model names declared');
for (const file of files.filter((f) => /-interface\.ts$/.test(f))) {
  const rel = relative(REPO, file).replace(/\\/g, '/');
  const text = readFileSync(file, 'utf8');
  const props = [...text.matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1]);
  const bad = props.filter((p) => !delegates.has(p));
  console.log(`  ${rel}`);
  console.log(`    declared: ${props.length ? props.join(', ') : '(none matched)'}`);
  if (bad.length) console.log(`    !! NOT IN SCHEMA: ${bad.join(', ')}`);
}
console.log('');

if (unusedDelegates.length) {
  console.log(`## MODELS NEVER ACCESSED FROM CODE (${unusedDelegates.length}) — dead schema or access via another path`);
  console.log(`  ${unusedDelegates.join(', ')}`);
}
