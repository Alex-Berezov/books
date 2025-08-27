import { config as dotenvConfig } from 'dotenv';
import { execSync } from 'node:child_process';

function withSchema(url: string, schema: string): string {
  return url.includes('?') ? `${url}&schema=${schema}` : `${url}?schema=${schema}`;
}

export default function globalSetup(): void {
  // Load base env (.env)
  dotenvConfig({ path: '.env' });
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL is not set. Please configure it in .env');
  }
  const schema = `e2e_${Date.now()}`;
  process.env.PRISMA_TEST_SCHEMA = schema;
  process.env.DATABASE_URL = withSchema(baseUrl, schema);

  // Apply migrations and seed to the isolated schema
  // Note: child processes inherit env with the overridden DATABASE_URL
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  execSync('npx prisma db seed', { stdio: 'inherit' });
}
