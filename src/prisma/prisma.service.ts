import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
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
  }
}
