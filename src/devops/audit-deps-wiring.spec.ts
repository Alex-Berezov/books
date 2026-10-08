import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Сторож LEGACY-450: аудит зависимостей стоит в обоих местах проверок и может покраснеть.
 *
 * Проверок два места, и они обязаны совпадать: `scripts/ci.sh` (его зовёт `ci.yml`) и
 * `deploy.yml` (выкат по тегу `v*`, где `ci.yml` не запускается вовсе). Шаг, заведённый
 * в одном, на втором пути отсутствует молча — так уезжали релизы мимо проверки
 * (LEGACY-078, LEGACY-207, LEGACY-209).
 *
 * Форма строки allowlist здесь не повторяется: её описывает одно место —
 * `entryError` в `scripts/audit-deps.mjs`, спека зовёт его через `--check-allowlist` (L-017).
 * Self-test тоже гоняется отсюда: сам конвейер может перестать его звать, а пустой набор
 * кейсов отвечает «ok» (L-017, LEGACY-045).
 *
 * YAML разбирается вручную по той же причине, что и в `ci-e2e-wiring.spec.ts`:
 * `yaml` и `js-yaml` не объявлены в `package.json`.
 */

const ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'audit-deps.mjs');
const SELF_TEST_CASES = 20;

const linesOf = (...parts: string[]): string[] =>
  readFileSync(join(ROOT, ...parts), 'utf8').split(/\r?\n/);
const isMeaningful = (line: string): boolean => line.trim() !== '' && !/^\s*#/.test(line);
const indentOf = (line: string): number => /^\s*/.exec(line)![0].length;

/** Тело блока, открытого строкой `start`: всё, что вложено глубже неё, без пустых строк и комментариев. */
const blockAt = (lines: string[], start: number): string[] => {
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!isMeaningful(lines[i])) continue;
    if (indentOf(lines[i]) <= indentOf(lines[start])) break;
    body.push(lines[i]);
  }
  return body;
};

const runScript = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

const advisoryRow = (id: string, severity: string): string =>
  JSON.stringify({
    type: 'auditAdvisory',
    data: { advisory: { github_advisory_id: id, severity, module_name: 'pkg' } },
  });
const SUMMARY = JSON.stringify({ type: 'auditSummary', data: {} });

describe('аудит зависимостей в конвейерах (LEGACY-450)', () => {
  it('scripts/ci.sh: self-test, затем аудит — отдельными строками верхнего уровня, без смягчений', () => {
    const lines = linesOf('scripts', 'ci.sh').filter(isMeaningful);
    const selfTest = lines.indexOf('yarn audit:deps:self-test');
    const audit = lines.indexOf('yarn audit:deps');
    expect(selfTest).toBeGreaterThanOrEqual(0);
    expect(audit).toBe(selfTest + 1);
    // Скрипт под `set -e`: вызов на верхнем уровне, а не внутри `if`, функции или после `exit`.
    expect(lines.slice(0, audit).some((line) => /^exit\b/.test(line))).toBe(false);
    // Без `set -e` код 1 от аудита не роняет `ci.sh`, и шаг становится формальным.
    expect(lines.slice(0, selfTest).some((line) => /^set -[a-z]*e/.test(line))).toBe(true);
  });

  it('deploy.yml: шаг в job `test`, от которого зависит `deploy`, без условий и смягчений', () => {
    const lines = linesOf('.github', 'workflows', 'deploy.yml');
    const jobs = lines
      .map((line, i) => [line, i] as const)
      .filter(([line]) => /^ {2}[\w-]+:\s*$/.test(line));
    const testJob = jobs.find(([line]) => line.trim() === 'test:');
    expect(testJob).toBeDefined();
    const testBody = blockAt(lines, testJob![1]);
    const stepStart = testBody.findIndex((line) => /^\s*- name: .*Dependency Audit/.test(line));
    expect(stepStart).toBeGreaterThanOrEqual(0);
    const stepIndent = indentOf(testBody[stepStart]);
    const nextStep = testBody.findIndex((line, i) => i > stepStart && indentOf(line) <= stepIndent);
    const step = testBody
      .slice(stepStart + 1, nextStep === -1 ? undefined : nextStep)
      .map((line) => line.trim());
    expect(step).toEqual(['run: |', 'yarn audit:deps:self-test', 'yarn audit:deps']);

    const deployJob = jobs.find(([line]) => line.trim() === 'deploy:');
    const needs = blockAt(lines, deployJob![1]).find((line) => /^\s*needs:/.test(line));
    expect(needs).toMatch(/\btest\b/);
  });

  it('скрипты объявлены в package.json', () => {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['audit:deps']).toBe('node scripts/audit-deps.mjs');
    expect(scripts['audit:deps:self-test']).toBe('node scripts/audit-deps.mjs --self-test');
  });

  it('LEGACY-449: axios снят, xlsx (патча нет) — не в рабочих зависимостях', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies.axios).toBeUndefined();
    expect(pkg.devDependencies.axios).toBeUndefined();
    expect(pkg.dependencies.xlsx).toBeUndefined();
  });

  describe('сам шаг на подложенном выводе yarn audit', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'audit-deps-'));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const runOn = (name: string, output: string) => {
      const file = join(dir, name);
      writeFileSync(file, output);
      return runScript('--audit-output', file);
    };

    it('чистый аудит — пропуск', () => {
      const run = runOn('clean.jsonl', [advisoryRow('GHSA-mod', 'moderate'), SUMMARY].join('\n'));
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(/ok: high\/critical в рабочих зависимостях — 0/);
    });

    it('совет high вне allowlist — отказ с его id', () => {
      const run = runOn('high.jsonl', [advisoryRow('GHSA-test-high', 'high'), SUMMARY].join('\n'));
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/GHSA-test-high \(high, pkg\): нет в allowlist/);
    });

    it('вывод без итога (сбой реестра) — отказ, а не «чисто»', () => {
      const run = runOn('broken.jsonl', 'error An unexpected error occurred: "ETIMEDOUT".');
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/аудит не дошёл до итога/);
    });
  });

  it('self-test проходит и не потерял кейсы', () => {
    const run = runScript('--self-test');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const count = Number(/self-test ok \((\d+) проверок\)/.exec(run.stdout)?.[1]);
    expect(count).toBeGreaterThanOrEqual(SELF_TEST_CASES);
  });

  it('строки allowlist по форме принимает сам скрипт', () => {
    const run = runScript('--check-allowlist');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
