import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `scripts/check-prod-config.mjs` — ручная сверка боевого окружения перед выкатом
 * (`books-app-docs/backend/deployment/quick-commands.md`). Её вывод читают глазами
 * и копируют в чат, поэтому значения ключей хранилищ в нём печататься не должны:
 * до 08.10.2026 скрипт выводил `R2_SECRET_ACCESS_KEY` и `BACKUP_S3_SECRET_ACCESS_KEY`
 * открытым текстом. Тем же днём снята проверка `SWAGGER_ENABLED=0`: переменную
 * приложение не читает (Swagger включён всегда, `src/main.ts`), и проверка
 * требовала значение, ни на что не влияющее.
 */
const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'check-prod-config.mjs');
const ENV_FILE = ['.env', 'prod'].join('.');

/** Полный годный набор: без него провал «пустого ключа» нельзя приписать именно ключу. */
const VALID_ENV = [
  'NODE_ENV=production',
  'RATE_LIMIT_GLOBAL_ENABLED=1',
  'TRUST_PROXY=1',
  `JWT_ACCESS_SECRET=${'a'.repeat(40)}`,
  `JWT_REFRESH_SECRET=${'b'.repeat(40)}`,
  'DATABASE_URL=postgresql://user:pass@postgres:5432/books',
  'DEFAULT_LANGUAGE=en',
  'STORAGE_DRIVER=r2',
  'R2_ENDPOINT=https://r2.example.test',
  'R2_ACCESS_KEY_ID=r2-key-id-fixture',
  'R2_SECRET_ACCESS_KEY=r2-secret-fixture',
  'R2_BUCKET=bucket-fixture',
  'R2_PUBLIC_BASE_URL=https://cdn.example.test',
  'BACKUP_REMOTE_ENABLED=1',
  'BACKUP_S3_ENDPOINT=https://s3.example.test',
  'BACKUP_S3_BUCKET=backup-bucket-fixture',
  'BACKUP_S3_ACCESS_KEY_ID=s3-key-id-fixture',
  'BACKUP_S3_SECRET_ACCESS_KEY=s3-secret-fixture',
];

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runWithEnv(lines: string[]): Run {
  const dir = mkdtempSync(join(tmpdir(), 'check-prod-config-'));
  try {
    writeFileSync(join(dir, ENV_FILE), lines.join('\n'));
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scripts/check-prod-config.mjs', () => {
  let valid: Run;
  let missingSecret: Run;

  beforeAll(() => {
    valid = runWithEnv(VALID_ENV);
    missingSecret = runWithEnv(
      VALID_ENV.map((l) => (l.startsWith('R2_SECRET_ACCESS_KEY=') ? 'R2_SECRET_ACCESS_KEY=' : l)),
    );
  });

  it('на годном наборе доходит до конца без падения и без провала', () => {
    // Падение скрипта даёт стек в stderr — его нельзя спутать с провалом проверки.
    expect(valid.stderr).toBe('');
    expect(valid.stdout).toContain('NODE_ENV: production (OK)');
    expect(valid.stdout).toContain('All critical settings are correct');
    expect(valid.status).toBe(0);
  });

  it('проверяет хранилища, но не печатает значения ключей', () => {
    expect(valid.stdout).toContain('R2_SECRET_ACCESS_KEY: set');
    expect(valid.stdout).toContain('BACKUP_S3_SECRET_ACCESS_KEY: set');
    expect(valid.stdout).not.toMatch(/-fixture/);
  });

  it('не требует SWAGGER_ENABLED, который приложение не читает', () => {
    expect(valid.stdout).not.toContain('SWAGGER_ENABLED');
  });

  it('пустой ключ хранилища — единственная причина провала', () => {
    const failures = (out: string): number =>
      out
        .split('\n')
        .filter((l) => l.includes('❌') && !l.includes('critical configuration issues')).length;
    expect(failures(valid.stdout)).toBe(0);
    expect(failures(missingSecret.stdout)).toBe(1);
    expect(missingSecret.stderr).toBe('');
    expect(missingSecret.stdout).toContain('R2_SECRET_ACCESS_KEY: missing');
    expect(missingSecret.stdout).toContain('There are critical configuration issues');
    expect(missingSecret.status).toBe(1);
    expect(missingSecret.stdout).not.toMatch(/-fixture/);
  });
});
