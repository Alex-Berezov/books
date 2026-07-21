import { Module, Logger } from '@nestjs/common';
import { LocalStorageService } from './local.storage';
import { R2StorageService } from './r2.storage';
import { STORAGE_SERVICE } from './storage.interface';

function storageFactory(): LocalStorageService | R2StorageService {
  const driver = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
  if (driver === 'r2') {
    Logger.log('Storage driver: R2 (Cloudflare)', 'StorageModule');
    return new R2StorageService();
  }
  Logger.log('Storage driver: local', 'StorageModule');
  return new LocalStorageService();
}

@Module({
  providers: [
    {
      provide: STORAGE_SERVICE,
      useFactory: storageFactory,
    },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
