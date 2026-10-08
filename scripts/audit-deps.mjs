#!/usr/bin/env node
/**
 * LEGACY-450. Аудит рабочих зависимостей: любой совет уровня high/critical, которого нет
 * в `scripts/audit-allowlist.json`, роняет шаг. Строка allowlist — id совета (GHSA или npm-<число>), а не пакет.
 *
 * Классы строки:
 *  - `недостижим` — нужны `reason` (почему вход не доходит) и `expires`;
 *  - `достижим, принят до пачки` — дополнительно `batch` (пачка-починка), `expires` не дальше 30 дней.
 * Истёкшая строка (срок включительно, по UTC) роняет шаг так же, как совет вне списка; строка, чьего
 * совета в аудите уже нет, — только предупреждение, истёкшая тоже. Повтор id — отказ.
 *
 * `--self-test` проверяет сам оценщик на подложенных входах: проверка, которая не краснеет
 * на дефекте, приучает игнорировать свой вывод (LEGACY-045). `--check-allowlist` проверяет только
 * форму строк allowlist, без реестра: его зовёт `src/devops/audit-deps-wiring.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ALLOWLIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audit-allowlist.json');
const FAIL_LEVELS = new Set(['high', 'critical']);
const CLASS_UNREACHABLE = 'недостижим';
const CLASS_ACCEPTED = 'достижим, принят до пачки';
const MAX_ACCEPT_DAYS = 30;
const DAY_MS = 86_400_000;
const ID_RE = /^(GHSA-[\w-]+|npm-\d+)$/;

/** Разбор вывода `yarn audit --json`: уникальные советы high/critical и признак того, что аудит дошёл до конца. */
function parseAudit(output) {
  const found = new Map();
  let summary = false;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === 'auditSummary') summary = true;
    if (row.type !== 'auditAdvisory') continue;
    const adv = row.data?.advisory;
    if (!adv || !FAIL_LEVELS.has(adv.severity)) continue;
    const id = adv.github_advisory_id || `npm-${adv.id}`;
    if (!found.has(id)) found.set(id, { id, severity: adv.severity, module: adv.module_name });
  }
  return { advisories: [...found.values()], complete: summary };
}

/**
 * Ошибка формы строки allowlist или null. Единственное место, где описана строка: спека
 * зовёт его через `--check-allowlist`, а не держит свою копию правила (L-017).
 * `expires` включительно: строка действует до конца этого дня по UTC.
 */
function entryError(entry, today) {
  const expires = Date.parse(`${entry?.expires}T00:00:00Z`);
  // `Date.parse` переносит несуществующую дату (`2026-02-31` → 3 марта): форма сверяется обратным ходом.
  const isRealDate =
    !Number.isNaN(expires) && new Date(expires).toISOString().slice(0, 10) === entry?.expires;
  if (!ID_RE.test(String(entry?.id ?? '')) || !String(entry?.reason ?? '').trim() || !isRealDate) {
    return 'нужны id (GHSA-… или npm-<число>), reason и expires (YYYY-MM-DD)';
  }
  if (entry.class !== CLASS_UNREACHABLE && entry.class !== CLASS_ACCEPTED) {
    return `class — «${CLASS_UNREACHABLE}» или «${CLASS_ACCEPTED}»`;
  }
  if (entry.class === CLASS_ACCEPTED) {
    if (!/^T\d+$/.test(String(entry.batch ?? ''))) {
      return `для «${CLASS_ACCEPTED}» нужна пачка-починка в batch (например T121)`;
    }
    // Срок включительный: строка живёт до конца дня `expires`. Считаем от начала сегодняшнего дня
    // по UTC до конца последнего — так потолок не зависит от времени суток прогона.
    const startOfToday = Math.floor(today.getTime() / DAY_MS) * DAY_MS;
    if (expires + DAY_MS - startOfToday > MAX_ACCEPT_DAYS * DAY_MS) {
      return `принятие дольше ${MAX_ACCEPT_DAYS} дней от сегодняшней даты`;
    }
  }
  return null;
}

const isExpired = (entry, today) =>
  Date.parse(`${entry.expires}T00:00:00Z`) + DAY_MS <= today.getTime();

/** Возвращает { failures, warnings }; чистая функция — на ней держится self-test. */
function evaluate(advisories, allowlist, today) {
  const failures = [];
  const warnings = [];
  const present = new Set(advisories.map((adv) => adv.id));
  const byId = new Map();
  for (const entry of allowlist) {
    const where = `allowlist ${entry?.id ?? '<без id>'}`;
    const error = entryError(entry, today);
    if (error) {
      failures.push(`${where}: ${error}`);
      continue;
    }
    if (byId.has(entry.id)) {
      failures.push(`${where}: строка повторяется — оставь одну`);
      continue;
    }
    byId.set(entry.id, entry);
    if (!present.has(entry.id)) {
      warnings.push(`${where}: совета в аудите уже нет — строку можно снять`);
    } else if (isExpired(entry, today)) {
      failures.push(`${where}: срок истёк ${entry.expires}`);
    }
  }
  for (const adv of advisories) {
    if (!byId.has(adv.id))
      failures.push(`${adv.id} (${adv.severity}, ${adv.module}): нет в allowlist`);
  }
  return { failures, warnings };
}

function selfTest() {
  const today = new Date('2026-10-09T12:00:00Z');
  const adv = [{ id: 'GHSA-aaaa', severity: 'high', module: 'pkg' }];
  const ok = {
    id: 'GHSA-aaaa',
    class: CLASS_UNREACHABLE,
    reason: 'вход не доходит',
    expires: '2027-01-01',
  };
  const accepted = {
    id: 'GHSA-aaaa',
    class: CLASS_ACCEPTED,
    reason: 'ждёт починки',
    batch: 'T121',
    expires: '2026-11-01',
  };
  const cases = [
    ['чистый аудит', [], [], 0],
    ['совет вне списка', adv, [], 1],
    ['совет в списке', adv, [ok], 0],
    ['строка истекла', adv, [{ ...ok, expires: '2026-10-08' }], 1],
    ['последний день строки ещё действует', adv, [{ ...ok, expires: '2026-10-09' }], 0],
    [
      'истёкшая строка без совета — только предупреждение',
      [],
      [{ ...ok, expires: '2026-10-08' }],
      0,
    ],
    ['строка-дубль', adv, [ok, ok], 1],
    ['нет причины', adv, [{ ...ok, reason: ' ' }], 1],
    ['id не GHSA и не npm-<число>', adv, [{ ...ok, id: 'pkg' }], 1],
    [
      'совет без GHSA-номера в списке',
      [{ id: 'npm-1234', severity: 'high', module: 'pkg' }],
      [{ ...ok, id: 'npm-1234' }],
      0,
    ],
    ['неизвестный класс', adv, [{ ...ok, class: 'потом' }], 1],
    ['принятие без пачки', adv, [{ ...accepted, batch: undefined }], 1],
    ['принятие на срок больше 30 дней', adv, [{ ...accepted, expires: '2026-12-01' }], 1],
    ['принятие в пределах 30 дней', adv, [accepted], 0],
    ['принятие ровно на 30 дней', adv, [{ ...accepted, expires: '2026-11-07' }], 0],
    ['принятие на 31 день', adv, [{ ...accepted, expires: '2026-11-08' }], 1],
    ['несуществующая дата', adv, [{ ...ok, expires: '2027-02-31' }], 1],
  ];
  let bad = 0;
  for (const [name, a, list, want] of cases) {
    const got = evaluate(a, list, today).failures.length > 0 ? 1 : 0;
    if (got !== want) {
      console.error(`[audit-deps] self-test: «${name}» — ждали ${want ? 'отказ' : 'пропуск'}`);
      bad++;
    }
  }
  const stale = evaluate([], [ok], today);
  if (stale.failures.length || stale.warnings.length !== 1) {
    console.error(
      '[audit-deps] self-test: лишняя строка allowlist должна давать только предупреждение',
    );
    bad++;
  }
  const row = (advisory) =>
    JSON.stringify({
      type: 'auditAdvisory',
      data: { advisory: { module_name: 'm', ...advisory } },
    });
  const parsed = parseAudit(
    [
      row({ github_advisory_id: 'GHSA-x', severity: 'moderate' }),
      row({ github_advisory_id: 'GHSA-y', severity: 'high' }),
      row({ github_advisory_id: 'GHSA-y', severity: 'high' }),
      row({ id: 1234, severity: 'critical' }),
      '{"type":"auditSummary","data":{}}',
    ].join('\n'),
  );
  const ids = parsed.advisories.map((a) => a.id).join(',');
  if (ids !== 'GHSA-y,npm-1234' || !parsed.complete) {
    console.error(`[audit-deps] self-test: разбор вывода yarn audit — получили ${ids}`);
    bad++;
  }
  if (parseAudit('network error').complete) {
    console.error('[audit-deps] self-test: вывод без auditSummary не должен считаться полным');
    bad++;
  }
  if (bad) process.exit(1);
  console.log(`[audit-deps] self-test ok (${cases.length + 3} проверок)`);
}

/**
 * Строки allowlist без обращения к реестру — для спеки. Тот же `evaluate`, что и в `main`, но советы
 * подставлены из самого списка: так ловятся форма, дубли и истёкшие строки, а «совета уже нет» не мешает.
 */
function checkAllowlist() {
  const list = readAllowlist();
  const advisories = list.map((entry) => ({ id: entry?.id, severity: 'high', module: '-' }));
  const { failures } = evaluate(advisories, list, new Date());
  for (const f of failures) console.error(`[audit-deps] ${f}`);
  if (failures.length) process.exit(1);
  console.log('[audit-deps] allowlist ok');
}

function readAllowlist() {
  const list = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${ALLOWLIST}: ждали массив строк`);
  return list;
}

function runAudit() {
  // `--audit-output <файл>` подменяет вызов реестра готовым выводом `yarn audit --json`: так спека
  // исполняет `main` целиком (отказ на совете, на оборванном выводе, пропуск на чистом) без сети.
  const flag = process.argv.indexOf('--audit-output');
  if (flag !== -1) return parseAudit(readFileSync(process.argv[flag + 1], 'utf8'));
  const run = spawnSync('yarn', ['audit', '--groups', 'dependencies', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  // Код возврата yarn audit — битовая маска уровней, годится только как «что-то нашлось»; решает разбор.
  const audit = parseAudit(run.stdout ?? '');
  if (!audit.complete) {
    // Причина отказа — в деталях запуска: нет yarn (ENOENT), переполнен буфер (ENOBUFS), ответ реестра.
    const detail =
      run.error?.message ?? `код ${run.status}: ${(run.stderr ?? '').trim().slice(-500)}`;
    console.error(`[audit-deps] yarn audit без итога — ${detail}`);
  }
  return audit;
}

function main() {
  // Один повтор: сбой реестра на выкате по тегу иначе требует ручного перезапуска задания.
  let audit = runAudit();
  if (!audit.complete) audit = runAudit();
  if (!audit.complete) {
    console.error(
      '[audit-deps] аудит не дошёл до итога (сеть или реестр) — шаг не может сказать «чисто»',
    );
    process.exit(1);
  }
  const { failures, warnings } = evaluate(audit.advisories, readAllowlist(), new Date());
  for (const w of warnings) console.warn(`[audit-deps] ${w}`);
  if (failures.length) {
    for (const f of failures) console.error(`[audit-deps] ${f}`);
    process.exit(1);
  }
  console.log(
    `[audit-deps] ok: high/critical в рабочих зависимостях — ${audit.advisories.length}, все разрешены списком`,
  );
}

// Без проверки «запущен ли файл напрямую»: сравнение путей на Windows расходится в регистре диска,
// и шаг молча выходил бы с кодом 0. Скрипт ничего не экспортирует — импортировать его некому.
if (process.argv.includes('--self-test')) selfTest();
else if (process.argv.includes('--check-allowlist')) checkAllowlist();
else main();
