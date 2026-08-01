import { Logger, Module } from '@nestjs/common';
import { LocalStorageService } from '../storage/local.storage';
import { R2StorageService } from '../storage/r2.storage';
import { RIGHTS_FILE_STORAGE_DRIVER } from './rights-file-storage.module-tokens';
import { RightsFileStorageService } from './rights-file-storage.service';

/**
 * WP-9: второй экземпляр хранилища — только для юридических файлов системы прав.
 *
 * local: собственный каталог **вне** `LOCAL_UPLOADS_DIR`. `ServeStaticModule` раздаёт весь
 * `LOCAL_UPLOADS_DIR` от корня (`app.module.ts`), поэтому единственный способ не отдать
 * юридический документ по прямому адресу — держать его в другом каталоге.
 *
 * r2: тот же бакет, но собственный префикс ключей. Приложение публичный URL для него не
 * вычисляет; чтобы объект не отдавался и снаружи, префикс исключается из публичной раздачи
 * на стороне CDN — это требование деплоя, записанное в ADR-015.
 */
function rightsFileStorageFactory(): LocalStorageService | R2StorageService {
  const driver = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
  if (driver === 'r2') {
    const prefix = resolveR2Prefix();
    Logger.log(`Rights file storage: R2, key prefix '${prefix}'`, 'RightsFileStorageModule');
    return new R2StorageService(prefix);
  }
  const dir = process.env.RIGHTS_FILES_LOCAL_DIR || './var/rights-files';
  Logger.log(`Rights file storage: local, directory '${dir}'`, 'RightsFileStorageModule');
  return new LocalStorageService(dir);
}

/**
 * Префикс прав **вкладывается** в `R2_KEY_PREFIX`, а не заменяет его.
 *
 * `R2_KEY_PREFIX` разделяет окружения внутри одного бакета (`prod/`, `staging/`). Если бы
 * юридические файлы игнорировали его и писались в корень, прод и стейджинг делили бы один
 * `rights-private/` — и стейджинговый прогон затирал бы ключи прода. Итоговый префикс:
 * `prod/rights-private`.
 */
function resolveR2Prefix(): string {
  const environmentPrefix = (process.env.R2_KEY_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const rightsPrefix = (process.env.RIGHTS_FILES_KEY_PREFIX || 'rights-private').replace(
    /^\/+|\/+$/g,
    '',
  );
  return [environmentPrefix, rightsPrefix].filter(Boolean).join('/');
}

/** Экспорт для теста: собранный префикс — единственное, что отличает окружения в одном бакете. */
export const resolveR2PrefixForTests = resolveR2Prefix;

@Module({
  providers: [
    { provide: RIGHTS_FILE_STORAGE_DRIVER, useFactory: rightsFileStorageFactory },
    RightsFileStorageService,
  ],
  exports: [RightsFileStorageService],
})
export class RightsFileStorageModule {}
