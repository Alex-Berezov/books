import { Test } from '@nestjs/testing';
import { RightsFileStorageModule } from './rights-file-storage.module';
import { RightsFileStorageService } from './rights-file-storage.service';
import { RIGHTS_FILE_STORAGE_DRIVER } from './rights-file-storage.module-tokens';
import { LocalStorageService } from '../storage/local.storage';
import type { StorageService } from '../storage/storage.interface';

/**
 * DI smoke test (WP-9). Модуль — лист графа: он не должен зависеть ни от одного прикладного
 * модуля, иначе появится цикл через `RightsIntakeModule`. Плюс проверяется главное свойство
 * пакета: юридические файлы лежат **не** в каталоге, который раздаёт `ServeStaticModule`.
 */
describe('RightsFileStorageModule', () => {
  const originalDriver = process.env.STORAGE_DRIVER;
  const originalDir = process.env.RIGHTS_FILES_LOCAL_DIR;
  const originalUploads = process.env.LOCAL_UPLOADS_DIR;

  afterEach(() => {
    process.env.STORAGE_DRIVER = originalDriver;
    process.env.RIGHTS_FILES_LOCAL_DIR = originalDir;
    process.env.LOCAL_UPLOADS_DIR = originalUploads;
  });

  it('compiles the dependency container without any application module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RightsFileStorageModule],
    }).compile();

    expect(moduleRef.get(RightsFileStorageService)).toBeDefined();

    await moduleRef.close();
  });

  it('nests the rights prefix inside the environment prefix in R2 mode', async () => {
    // Иначе прод и стейджинг, живущие в одном бакете, делили бы `rights-private/`
    // и затирали бы ключи друг друга.
    process.env.R2_KEY_PREFIX = 'prod';
    process.env.RIGHTS_FILES_KEY_PREFIX = 'rights-private';

    const { resolveR2PrefixForTests } = await import('./rights-file-storage.module');

    expect(resolveR2PrefixForTests()).toBe('prod/rights-private');

    delete process.env.R2_KEY_PREFIX;
    expect(resolveR2PrefixForTests()).toBe('rights-private');

    // Фактическая конфигурация прода на 02.08.2026: переменная объявлена, но пустая.
    // Пустая строка обязана вести себя как отсутствие, а не давать ключ `/rights-private`.
    process.env.R2_KEY_PREFIX = '';
    expect(resolveR2PrefixForTests()).toBe('rights-private');

    delete process.env.R2_KEY_PREFIX;
    delete process.env.RIGHTS_FILES_KEY_PREFIX;
  });

  it('keeps rights files outside the statically served uploads root', async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.LOCAL_UPLOADS_DIR = './var/uploads';
    process.env.RIGHTS_FILES_LOCAL_DIR = './var/rights-files';

    const moduleRef = await Test.createTestingModule({
      imports: [RightsFileStorageModule],
    }).compile();

    const driver = moduleRef.get<StorageService>(RIGHTS_FILE_STORAGE_DRIVER);
    expect(driver).toBeInstanceOf(LocalStorageService);

    const path = (driver as LocalStorageService).getLocalPath('report-pdf/2026/a.pdf');
    expect(path).toContain('rights-files');
    expect(path).not.toContain('uploads');

    await moduleRef.close();
  });
});
