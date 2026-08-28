import { config as dotenvConfig } from 'dotenv';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 🔴 `globalSetup` выполняется в **отдельном процессе**, и его `process.env`
 * воркерам не наследуется. Первая версия раскладки по базам передавала имена
 * через переменные окружения — воркеры их не видели, подмены не происходило, и
 * все они работали с одной базой. Прогон при этом «проходил»: данные в тестах
 * уникальны по времени, а упали только три места, где сущность общая
 * (`admin@example.com` — 500 вместо 409 при гонке регистраций).
 *
 * Поэтому раскладка пишется в файл, а воркеры читают его.
 */
export const HANDOFF_FILE = path.join(os.tmpdir(), 'books-e2e-databases.json');

/**
 * Подготовка баз для e2e.
 *
 * 🔴 До 10.08.2026 база была **одна на весь прогон**, а `maxWorkers: 1` в
 * `jest-e2e.json` делал все наборы строго последовательными. Тесты внутри
 * набора занимают доли секунды — почти все 8.5 минуты уходили на то, что каждый
 * набор поднимает целиком `AppModule` (около семи секунд на набор). Параллелить
 * мешала общая база: наборы затирали бы данные друг друга.
 *
 * ⚠️ Точное число наборов в комментариях не пишется (`LEGACY-238`): оно живёт
 * ровно до следующего добавленного спека, а копируется в новые комментарии
 * охотно. Нужно — `ls test/*.e2e-spec.ts | wc -l`.
 *
 * Теперь база **на каждый воркер**, и создаются они не миграциями, а
 * `CREATE DATABASE ... TEMPLATE`: миграции и seed прогоняются один раз по
 * шаблону, копии делаются почти мгновенно.
 *
 * ⚠️ Postgres не даёт копировать шаблон, пока к нему есть подключения, —
 * поэтому все копии создаются здесь, до старта воркеров, и после этого к
 * шаблону никто не подключается.
 */

const MAX_WORKERS = Number(
  process.env.E2E_WORKERS || Math.min(4, Math.max(1, os.cpus().length - 1)),
);

function urlFor(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  url.searchParams.delete('schema');
  return url.toString();
}

function adminUrlFor(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = '/postgres';
  url.searchParams.delete('schema');
  return url.toString();
}

function runSql(adminUrl: string, sql: string): void {
  execSync('npx prisma db execute --stdin', {
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, DATABASE_URL: adminUrl },
  });
}

function dropDatabase(adminUrl: string, dbName: string): void {
  runSql(
    adminUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}';`,
  );
  runSql(adminUrl, `DROP DATABASE IF EXISTS "${dbName}";`);
}

export default function globalSetup(): void {
  dotenvConfig({ path: '.env.test' });
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL is not set. Please configure it in .env.test or .env');
  }

  const stamp = Date.now();
  const templateName = `e2e_${stamp}_tpl`;
  const adminUrl = adminUrlFor(baseUrl);

  const prefix = `e2e_${stamp}_w`;

  // Для teardown: имена всех созданных баз.
  process.env.PRISMA_TEST_ADMIN_URL = adminUrl;
  process.env.PRISMA_TEST_DB_TEMPLATE = templateName;
  process.env.PRISMA_TEST_WORKERS = String(MAX_WORKERS);
  process.env.PRISMA_TEST_DB_PREFIX = prefix;

  dropDatabase(adminUrl, templateName);
  runSql(adminUrl, `CREATE DATABASE "${templateName}";`);

  // Миграции и seed — один раз, по шаблону.
  const templateUrl = urlFor(baseUrl, templateName);
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: templateUrl },
  });
  execSync('npx prisma db seed', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: templateUrl },
  });

  for (let worker = 1; worker <= MAX_WORKERS; worker += 1) {
    const dbName = `${prefix}${worker}`;
    dropDatabase(adminUrl, dbName);
    runSql(adminUrl, `CREATE DATABASE "${dbName}" TEMPLATE "${templateName}";`);
  }

  // Единственный канал до воркеров — файл: переменные окружения туда не доедут.
  fs.writeFileSync(
    HANDOFF_FILE,
    JSON.stringify({ baseUrl, prefix, workers: MAX_WORKERS }),
    'utf-8',
  );

  // База по умолчанию — первого воркера: на неё смотрит всё, что читает
  // DATABASE_URL вне тестового процесса.
  process.env.DATABASE_URL = urlFor(baseUrl, `${prefix}1`);
  process.env.PRISMA_TEST_BASE_URL = baseUrl;
}
