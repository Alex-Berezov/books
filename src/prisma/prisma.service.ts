import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString });
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
