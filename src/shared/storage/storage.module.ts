import { Module } from '@nestjs/common';
import { LocalStorageService } from './local.storage';
import { STORAGE_SERVICE } from './storage.interface';

@Module({
  providers: [{ provide: STORAGE_SERVICE, useClass: LocalStorageService }],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
