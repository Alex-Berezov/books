import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { DirectUploadBodyMiddleware } from './direct-upload-body.middleware';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { CACHE_SERVICE } from '../../shared/cache/cache.interface';
import { InMemoryCacheService } from '../../shared/cache/inmemory.cache';
import { StorageModule } from '../../shared/storage/storage.module';
import { RateLimitModule } from '../../shared/rate-limit/rate-limit.module';

@Module({
  imports: [StorageModule, RateLimitModule],
  controllers: [UploadsController],
  providers: [
    UploadsService,
    // Свой экземпляр кэша под upload-токены (`LEGACY-460`): общий экземпляр `CacheModule` при упоре
    // в потолок вытесняет старейшие записи, и поток анонимных ключей уносил бы живые токены.
    { provide: CACHE_SERVICE, useClass: InMemoryCacheService },
  ],
  exports: [UploadsService],
})
export class UploadsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(DirectUploadBodyMiddleware)
      .forRoutes({ path: 'uploads/direct', method: RequestMethod.POST });
  }
}
