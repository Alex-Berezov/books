import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { SRC_ROOT } from './controller-decorators';

/**
 * Сгенерированный клиент `libs/api-client/src/types.ts` против снимка схемы
 * `libs/api-client/api-schema.json` (`LEGACY-016`, пачка `T42`).
 *
 * Снимок сверялся на каждом прогоне (`openapi-snapshot.spec.ts`), а клиент из него — нет:
 * к 26.09.2026 он отстал на `+17602 / -1697` строк и держал снятые операции
 * `CategoryController_list`, `TagsController_list`. Здесь клиент генерируется заново тем же
 * путём, что `yarn openapi:types:from-schema` (`openapi-typescript`, затем `prettier`),
 * и обязан совпасть с закоммиченным побайтно. Режима обновления у спеки нет:
 * при заданном переключателе сторож переписывал бы ожидание под изменившийся код.
 */
const ROOT = resolve(SRC_ROOT, '..');
const SCHEMA = join(ROOT, 'libs', 'api-client', 'api-schema.json');
const CLIENT = join(ROOT, 'libs', 'api-client', 'src', 'types.ts');
const GENERATOR = join(ROOT, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');
const PRETTIER = join(ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs');

const run = (script: string, args: string[]): void => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')}: exit ${result.status}\n${result.stderr}`);
  }
};

const generateClient = (schemaPath: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'api-client-types-'));
  try {
    const out = join(dir, 'types.ts');
    run(GENERATOR, [schemaPath, '-o', out]);
    run(PRETTIER, ['--config', join(ROOT, '.prettierrc'), '--write', out]);
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const normalize = (text: string): string => text.replace(/\r\n/g, '\n');

describe('LEGACY-016: сгенерированный клиент совпадает со снимком схемы', () => {
  it('libs/api-client/src/types.ts — вывод генератора по api-schema.json', () => {
    const expected = normalize(generateClient(SCHEMA));
    const actual = normalize(readFileSync(CLIENT, 'utf8'));
    if (actual !== expected) {
      throw new Error(
        'libs/api-client/src/types.ts разошёлся с libs/api-client/api-schema.json. ' +
          'Пересобрать: yarn openapi:types:from-schema',
      );
    }
  }, 120_000);

  it('проба на отказ: снятый маршрут в снимке даёт другой клиент', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as { paths: Record<string, unknown> };
    const [firstPath] = Object.keys(schema.paths);
    delete schema.paths[firstPath];
    const dir = mkdtempSync(join(tmpdir(), 'api-client-schema-'));
    try {
      const mutated = join(dir, 'api-schema.json');
      writeFileSync(mutated, JSON.stringify(schema));
      expect(normalize(generateClient(mutated))).not.toBe(normalize(readFileSync(CLIENT, 'utf8')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
