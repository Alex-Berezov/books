import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type HealthStatus = 'up' | 'down';

export interface ReadinessCheckResult {
  status: HealthStatus;
  details: {
    prisma: HealthStatus;
    redis?: HealthStatus | 'skipped';
  };
}

export interface LivenessResult {
  status: HealthStatus;
  uptime: number;
  timestamp: string;
}

export interface RedisProbe {
  isConfigured(): boolean;
  ping(): Promise<boolean>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisProbe,
  ) {}

  liveness(): LivenessResult {
    return {
      status: 'up',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessCheckResult> {
    const details: ReadinessCheckResult['details'] = {
      prisma: 'down',
      redis: 'skipped',
    };

    // Prisma check
    try {
      // Simple no-op query to validate DB connectivity
      await this.prisma.$queryRaw`SELECT 1`;
      details.prisma = 'up';
    } catch (e) {
      details.prisma = 'down';
      this.logger.warn(`Prisma readiness check failed: ${e instanceof Error ? e.message : e}`);
    }

    // Redis check (optional)
    try {
      if (this.redis.isConfigured()) {
        const ok = await this.redis.ping();
        details.redis = ok ? 'up' : 'down';
      } else {
        details.redis = 'skipped';
      }
    } catch (e) {
      details.redis = 'down';
      this.logger.warn(`Redis readiness check failed: ${e instanceof Error ? e.message : e}`);
    }

    const status: HealthStatus =
      details.prisma === 'up' && (details.redis === 'up' || details.redis === 'skipped')
        ? 'up'
        : 'down';

    return { status, details };
  }
}
