import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Умолчание `pg` — оно же было действующим потолком до `LEGACY-237`, пока
 * `max` не задавался вовсе. Оставлено ровно таким, чтобы появление настройки
 * не меняло поведение прода само по себе.
 */
const DEFAULT_POOL_MAX = 10;

/**
 * Размер пула. Читается из окружения, потому что прод и e2e расходятся здесь
 * на порядок: на проде один процесс и пул может быть широким, в e2e каждый
 * набор поднимает свой `AppModule` со своим пулом, и при нескольких воркерах
 * их суммарно выходит больше `max_connections` Postgres.
 *
 * 🔴 До `LEGACY-237` потолок объявлялся параметром `connection_limit` в строке
 * подключения. Это параметр **движка Prisma**, а клиент здесь собран на
 * драйверном адаптере: пул создаёт `pg`, и строку подключения он читает только
 * ради адреса и учётных данных. То есть объявленного потолка не существовало,
 * а комментарии в конвейере называли его настроенным.
 */
const poolMaxFromEnv = (): number => {
  const raw = Number(process.env.DATABASE_POOL_MAX);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_POOL_MAX;
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString, max: poolMaxFromEnv() });
    const adapter = new PrismaPg(pool);
    super({ adapter, log: ['info', 'warn', 'error'] });
    this.pool = pool;
  }

  async onModuleInit() {
    // Skip DB connection for OpenAPI docs generation in dev mode
    if (process.env.SKIP_DB_CONNECT === '1') {
      console.log('[PrismaService] Skipping database connection (SKIP_DB_CONNECT=1)');
      return;
    }
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }
}
