import { config as dotenvConfig } from 'dotenv';
import { execSync } from 'node:child_process';

export default function globalTeardown(): void {
  dotenvConfig({ path: '.env.test' });
  const adminUrl = process.env.PRISMA_TEST_ADMIN_URL;
  const dbName = process.env.PRISMA_TEST_DB_NAME;
  if (!adminUrl || !dbName) return;
  try {
    // Terminate connections and drop the temporary database
    const terminateSql = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}';`;
    const dropSql = `DROP DATABASE IF EXISTS "${dbName}";`;
    const cmd = `npx prisma db execute --url="${adminUrl}" --stdin`;
    execSync(cmd, { input: terminateSql, stdio: ['pipe', 'inherit', 'inherit'] });
    execSync(cmd, { input: dropSql, stdio: ['pipe', 'inherit', 'inherit'] });
  } catch {
    // ignore
  }
}
