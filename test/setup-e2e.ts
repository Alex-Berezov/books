import { config as dotenvConfig } from 'dotenv';
import { execSync } from 'node:child_process';

function buildTempDbUrl(baseUrl: string, dbName: string): { adminUrl: string; dbUrl: string } {
  const url = new URL(baseUrl);
  // Current db name (without leading slash)
  url.pathname.replace(/^\//, '');
  // Admin URL points to default 'postgres' DB to allow CREATE DATABASE
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  // DB URL for the test database
  const dbUrl = new URL(baseUrl);
  dbUrl.pathname = `/${dbName}`;

  // Preserve any existing search params (except schema overrides which we don't use anymore)
  // Ensure we remove any explicit schema param to avoid conflicts with migrations using public schema
  adminUrl.searchParams.delete('schema');
  dbUrl.searchParams.delete('schema');

  return { adminUrl: adminUrl.toString(), dbUrl: dbUrl.toString() };
}

export default function globalSetup(): void {
  // Load test env (.env.test), fallback to .env if not exists
  dotenvConfig({ path: '.env.test' });
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL is not set. Please configure it in .env.test or .env');
  }

  // Create isolated temporary database for this e2e run
  const dbName = `e2e_${Date.now()}`;
  const { adminUrl, dbUrl } = buildTempDbUrl(baseUrl, dbName);

  // Remember for teardown
  process.env.PRISMA_TEST_DB_NAME = dbName;
  process.env.PRISMA_TEST_ADMIN_URL = adminUrl;

  // Create database (ignore if exists just in case reruns)
  const createSql = `CREATE DATABASE "${dbName}";`;
  const createCmd = `npx prisma db execute --stdin`;
  try {
    execSync(createCmd, {
      input: createSql,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, DATABASE_URL: adminUrl },
    });
  } catch {
    // If creation fails because it exists, drop and recreate to ensure a clean slate
    const terminateSql = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}';`;
    const dropSql = `DROP DATABASE IF EXISTS "${dbName}";`;
    execSync(createCmd, {
      input: terminateSql,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, DATABASE_URL: adminUrl },
    });
    execSync(createCmd, {
      input: dropSql,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, DATABASE_URL: adminUrl },
    });
    execSync(createCmd, {
      input: createSql,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, DATABASE_URL: adminUrl },
    });
  }

  // Point Prisma to the temporary database and apply migrations + seed
  process.env.DATABASE_URL = dbUrl;
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  execSync('npx prisma db seed', { stdio: 'inherit' });
}
