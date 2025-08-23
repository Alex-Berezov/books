import { Module } from '@nestjs/common';
import { ViewStatsController } from './view-stats.controller';
import { ViewStatsService } from './view-stats.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheModule } from '../../shared/cache/cache.module';
import { RateLimitModule } from '../../shared/rate-limit/rate-limit.module';

@Module({
  imports: [CacheModule, RateLimitModule],
  controllers: [ViewStatsController],
  providers: [ViewStatsService, PrismaService],
  exports: [ViewStatsService],
})
export class ViewStatsModule {}
