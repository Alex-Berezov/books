import { Test } from '@nestjs/testing';
import { StorageModule } from './storage.module';
import { STORAGE_SERVICE, StorageService } from './storage.interface';
import { LocalStorageService } from './local.storage';
import { R2StorageService } from './r2.storage';

describe('StorageModule', () => {
  const prevEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it('provides LocalStorageService when STORAGE_DRIVER is unset', async () => {
    delete process.env.STORAGE_DRIVER;
    const mod = await Test.createTestingModule({ imports: [StorageModule] }).compile();
    const svc = mod.get<StorageService>(STORAGE_SERVICE);
    expect(svc).toBeInstanceOf(LocalStorageService);
  });

  it('provides LocalStorageService when STORAGE_DRIVER=local', async () => {
    process.env.STORAGE_DRIVER = 'local';
    const mod = await Test.createTestingModule({ imports: [StorageModule] }).compile();
    const svc = mod.get<StorageService>(STORAGE_SERVICE);
    expect(svc).toBeInstanceOf(LocalStorageService);
  });

  it('provides R2StorageService when STORAGE_DRIVER=r2 with all env set', async () => {
    process.env.STORAGE_DRIVER = 'r2';
    process.env.R2_ENDPOINT = 'https://account.r2.cloudflarestorage.com';
    process.env.R2_ACCESS_KEY_ID = 'ak';
    process.env.R2_SECRET_ACCESS_KEY = 'sk';
    process.env.R2_BUCKET = 'bucket';
    process.env.R2_PUBLIC_BASE_URL = 'https://media.example.com';

    const mod = await Test.createTestingModule({ imports: [StorageModule] }).compile();
    const svc = mod.get<StorageService>(STORAGE_SERVICE);
    expect(svc).toBeInstanceOf(R2StorageService);
  });

  it('throws with clear message when STORAGE_DRIVER=r2 but env missing', async () => {
    process.env.STORAGE_DRIVER = 'r2';
    delete process.env.R2_ENDPOINT;

    await expect(Test.createTestingModule({ imports: [StorageModule] }).compile()).rejects.toThrow(
      /R2_ENDPOINT is missing/,
    );
  });
});
