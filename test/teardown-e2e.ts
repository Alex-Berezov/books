import { config as dotenvConfig } from 'dotenv';
import { execSync } from 'node:child_process';

export default function globalTeardown(): void {
  dotenvConfig({ path: '.env' });
  const baseUrl = process.env.DATABASE_URL;
  const schema = process.env.PRISMA_TEST_SCHEMA;
  if (!baseUrl || !schema) return;
  try {
    // Use Prisma to execute raw SQL against baseUrl (not the schema URL) to drop test schema
    const dropSql = `DROP SCHEMA IF EXISTS ${schema} CASCADE;`;
    const cmd = `npx prisma db execute --url="${baseUrl}" --stdin`;
    execSync(cmd, { input: dropSql, stdio: ['pipe', 'inherit', 'inherit'] });
  } catch {
    // ignore
  }
}
