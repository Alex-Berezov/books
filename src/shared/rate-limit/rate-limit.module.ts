import { Module } from '@nestjs/common';
import { RATE_LIMITER } from './rate-limit.interface';
import { InMemoryRateLimiter } from './inmemory.rate-limiter';

@Module({
  providers: [{ provide: RATE_LIMITER, useClass: InMemoryRateLimiter }],
  exports: [RATE_LIMITER],
})
export class RateLimitModule {}
