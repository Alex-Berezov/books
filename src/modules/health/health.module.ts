import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService, RedisProbe } from './health.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

class EnvRedisProbe implements RedisProbe {
  private readonly url?: string;
  constructor(private readonly config: ConfigService) {
    this.url = this.config.get<string>('REDIS_URL') ?? this.config.get<string>('REDIS_HOST');
  }
  isConfigured(): boolean {
    return !!this.url;
  }
  async ping(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const host = this.config.get<string>('REDIS_HOST') ?? '127.0.0.1';
    const port = Number(this.config.get<string>('REDIS_PORT') ?? '6379');
    const url = this.config.get<string>('REDIS_URL');
    const client = url ? new IORedis(url) : new IORedis({ host, port });
    try {
      const res = await client.ping();
      return res === 'PONG';
    } catch {
      return false;
    } finally {
      client.disconnect();
    }
  }
}

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [
    PrismaService,
    {
      provide: 'REDIS_PROBE',
      useFactory: (config: ConfigService) => new EnvRedisProbe(config),
      inject: [ConfigService],
    },
    {
      provide: EnvRedisProbe,
      useExisting: 'REDIS_PROBE',
    },
    {
      provide: 'RedisProbe',
      useExisting: 'REDIS_PROBE',
    },
    {
      provide: HealthService,
      useFactory: (prisma: PrismaService, probe: EnvRedisProbe) => new HealthService(prisma, probe),
      inject: [PrismaService, EnvRedisProbe],
    },
  ],
  exports: [HealthService],
})
export class HealthModule {}
