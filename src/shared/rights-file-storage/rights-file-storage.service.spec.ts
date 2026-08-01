import { PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RightsFileStorageService } from './rights-file-storage.service';
import type { StorageService } from '../storage/storage.interface';

/**
 * WP-9: приватное хранилище юридических файлов.
 *
 * Проверяется то, что нельзя проверить типами: что сумму считает сервер, что чужой MIME и
 * слишком большой файл отбиваются до записи, и что архивирование служебных артефактов не
 * может уронить импорт отчёта.
 */
const createStorageStub = () => ({
  save: jest
    .fn<Promise<string>, [string, Buffer, Record<string, unknown>?]>()
    .mockResolvedValue(''),
  delete: jest.fn<Promise<void>, [string]>(),
  exists: jest.fn<Promise<boolean>, [string]>(),
  stat: jest.fn<Promise<null>, [string]>(),
  getPublicUrl: jest.fn<string, [string]>(),
  read: jest.fn<Promise<Buffer | null>, [string]>(),
});

const build = (storage: ReturnType<typeof createStorageStub>) =>
  new RightsFileStorageService(storage as unknown as StorageService);

describe('RightsFileStorageService', () => {
  let storage: ReturnType<typeof createStorageStub>;
  let service: RightsFileStorageService;

  beforeEach(() => {
    storage = createStorageStub();
    service = build(storage);
  });

  describe('saveUpload', () => {
    it('считает sha256 на сервере, а не берёт у клиента', async () => {
      const buffer = Buffer.from('%PDF-1.4 rights report');

      const stored = await service.saveUpload('report-pdf', {
        buffer,
        contentType: 'application/pdf',
        fileName: 'report.pdf',
      });

      expect(stored.sha256).toBe(createHash('sha256').update(buffer).digest('hex'));
      expect(stored.sizeBytes).toBe(buffer.length);
      expect(storage.save).toHaveBeenCalledWith(stored.storageKey, buffer, {
        contentType: 'application/pdf',
      });
    });

    it('кладёт файл под префикс своего вида и с расширением по MIME', async () => {
      const stored = await service.saveUpload('report-pdf', {
        buffer: Buffer.from('x'),
        contentType: 'application/pdf',
        fileName: 'report.pdf',
      });

      expect(stored.storageKey).toMatch(/^report-pdf\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
    });

    it('терпит параметры в заголовке content-type', async () => {
      const stored = await service.saveUpload('report-pdf', {
        buffer: Buffer.from('x'),
        contentType: 'application/pdf; charset=binary',
      });

      expect(stored.contentType).toBe('application/pdf');
    });

    it('отбивает не-PDF для отчёта до записи в хранилище', async () => {
      await expect(
        service.saveUpload('report-pdf', {
          buffer: Buffer.from('x'),
          contentType: 'image/png',
          fileName: 'scan.png',
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

      expect(storage.save).not.toHaveBeenCalled();
    });

    it('разрешает изображение для архивной копии доказательства', async () => {
      const stored = await service.saveUpload('evidence', {
        buffer: Buffer.from('x'),
        contentType: 'image/png',
        fileName: 'screenshot.png',
      });

      expect(stored.storageKey).toContain('evidence/');
    });

    it('не даёт загрузить служебный артефакт руками: списка разрешённых типов у него нет', async () => {
      await expect(
        service.saveUpload('report-json', {
          buffer: Buffer.from('{}'),
          contentType: 'application/json',
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('отбивает файл сверх лимита', async () => {
      process.env.RIGHTS_FILES_MAX_MB = '1';
      const limited = build(storage);

      await expect(
        limited.saveUpload('report-pdf', {
          buffer: Buffer.alloc(2 * 1024 * 1024),
          contentType: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);

      expect(storage.save).not.toHaveBeenCalled();
      delete process.env.RIGHTS_FILES_MAX_MB;
    });
  });

  describe('saveText / trySaveText', () => {
    it('пишет служебный артефакт без проверки MIME — его источник сервер', async () => {
      const stored = await service.saveText(
        'report-json',
        '{"a":1}',
        'application/json',
        'report.json',
      );

      expect(stored.sha256).toBe(
        createHash('sha256').update(Buffer.from('{"a":1}', 'utf-8')).digest('hex'),
      );
      expect(stored.storageKey).toMatch(/^report-json\//);
    });

    it('trySaveText возвращает null вместо исключения: отказ хранилища не отменяет импорт', async () => {
      storage.save.mockRejectedValueOnce(new Error('storage is down'));

      await expect(
        service.trySaveText('report-json', '{}', 'application/json'),
      ).resolves.toBeNull();
    });
  });

  describe('read', () => {
    it('возвращает содержимое объекта', async () => {
      storage.read.mockResolvedValueOnce(Buffer.from('pdf bytes'));

      await expect(service.read('report-pdf/a.pdf')).resolves.toEqual(Buffer.from('pdf bytes'));
    });

    it('падает понятной ошибкой, если драйвер не умеет читать', async () => {
      const withoutRead = { ...storage, read: undefined };
      const svc = new RightsFileStorageService(withoutRead as unknown as StorageService);

      await expect(svc.read('k')).rejects.toThrow('does not support reading');
    });
  });
});
