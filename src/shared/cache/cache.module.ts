import { Module } from '@nestjs/common';
import { CACHE_SERVICE } from './cache.interface';
import { InMemoryCacheService } from './inmemory.cache';

@Module({
  providers: [{ provide: CACHE_SERVICE, useClass: InMemoryCacheService }],
  exports: [CACHE_SERVICE],
})
export class CacheModule {}
