import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService, RedisProbe } from './health.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigModule, ConfigService } from '@nestjs/config';

class EnvRedisProbe implements RedisProbe {
  private readonly url?: string;
  constructor(private readonly config: ConfigService) {
    this.url = this.config.get<string>('REDIS_URL') ?? this.config.get<string>('REDIS_HOST');
  }
  isConfigured(): boolean {
    return !!this.url;
  }
  async ping(): Promise<boolean> {
    // Placeholder ping: since we don't have redis client yet, treat configured as up.
    // Will be replaced with real client in BullMQ/Redis task.
    return Promise.resolve(this.isConfigured());
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
