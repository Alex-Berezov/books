import { config as dotenvConfig } from 'dotenv';
import { execSync } from 'node:child_process';

/**
 * Убирает базы, созданные `globalSetup`: шаблон и по одной на воркер.
 *
 * ⚠️ Удаляются все, даже если часть прогона упала: брошенная база живёт до
 * следующего ручного вмешательства, а имена уникальны по времени — накопятся
 * незаметно.
 */
export default function globalTeardown(): void {
  dotenvConfig({ path: '.env.test' });
  const adminUrl = process.env.PRISMA_TEST_ADMIN_URL;
  const template = process.env.PRISMA_TEST_DB_TEMPLATE;
  const prefix = process.env.PRISMA_TEST_DB_PREFIX;
  const workers = Number(process.env.PRISMA_TEST_WORKERS || '0');
  if (!adminUrl) return;

  const names: string[] = [];
  for (let worker = 1; worker <= workers; worker += 1) {
    if (prefix) names.push(`${prefix}${worker}`);
  }
  if (template) names.push(template);

  const cmd = 'npx prisma db execute --stdin';
  for (const dbName of names) {
    try {
      execSync(cmd, {
        input: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}';`,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: { ...process.env, DATABASE_URL: adminUrl },
      });
      execSync(cmd, {
        input: `DROP DATABASE IF EXISTS "${dbName}";`,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: { ...process.env, DATABASE_URL: adminUrl },
      });
    } catch {
      // ignore: база могла не создаться, если прогон упал на подготовке
    }
  }
}
