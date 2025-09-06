import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { UploadType } from './dto/presign.dto';

describe('UploadsService (unit)', () => {
  const cache = {
    get: jest.fn<Promise<any>, any>(),
    set: jest.fn<Promise<void>, any>(),
    del: jest.fn<Promise<void>, any>(),
  };
  const storage = {
    save: jest.fn<Promise<string>, any>(),
    delete: jest.fn<Promise<void>, any>(),
    exists: jest.fn<Promise<boolean>, any>(),
    stat: jest.fn<Promise<{ size: number } | null>, any>(),
    getPublicUrl: jest.fn<string, any>(),
  };

  let service: UploadsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UploadsService(
      cache as unknown as import('../../shared/cache/cache.interface').CacheService,
      storage as unknown as import('../../shared/storage/storage.interface').StorageService,
    );
  });

  describe('presign', () => {
    it('returns token, key, headers and stores token in cache (cover image)', async () => {
      const res = await service.presign(
        { type: UploadType.cover, contentType: 'image/jpeg', size: 1024 },
        'user-1',
      );
      expect(res.key).toMatch(/^covers\/\d{4}\/\d{2}\/\d{2}\/[\w-]+\.jpg$/);
      expect(res.url).toBe('/uploads/direct');
      expect(res.method).toBe('POST');
      expect(res.headers).toBeDefined();
      expect(res.headers!['content-type']).toBe('image/jpeg');
      expect(res.headers!['x-upload-token']).toBeDefined();
      expect(res.token).toBeDefined();
      expect(res.ttlSec).toBeGreaterThan(0);
      // cache.set called with token key and correct payload
      expect(cache.set).toHaveBeenCalledTimes(1);
      const args = cache.set.mock.calls[0] as [string, unknown, number];
      const cacheKey = args[0];
      const value = args[1] as Record<string, unknown>;
      const ttlMs = args[2];
      expect(cacheKey).toBe(`uploads:token:${res.token}`);
      expect(value).toEqual({
        key: res.key,
        userId: 'user-1',
        contentType: 'image/jpeg',
        size: 1024,
      });
      expect(ttlMs).toBe(res.ttlSec * 1000);
    });

    it('rejects unsupported content type', async () => {
      await expect(
        service.presign({ type: UploadType.cover, contentType: 'image/bmp', size: 100 }, 'u'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects too large image', async () => {
      const tooBig = 6 * 1024 * 1024; // default max 5MB
      await expect(
        service.presign({ type: UploadType.cover, contentType: 'image/png', size: tooBig }, 'u'),
      ).rejects.toThrow('Image too large');
    });

    it('accepts audio and generates proper extension', async () => {
      const res = await service.presign(
        { type: UploadType.audio, contentType: 'audio/mpeg', size: 1024 },
        'user-2',
      );
      expect(res.key).toMatch(/^audio\/\d{4}\/\d{2}\/\d{2}\/[\w-]+\.mp3$/);
    });
  });

  describe('directUpload', () => {
    it('saves body, clears cache and returns publicUrl', async () => {
      const token = 'tok-1';
      const key = 'covers/2025/09/06/id.jpg';
      cache.get.mockResolvedValue({
        key,
        userId: 'user-1',
        contentType: 'image/jpeg',
        size: 1000,
      });
      storage.save.mockResolvedValue('/abs/path');
      storage.getPublicUrl.mockReturnValue('http://localhost:5000/static/' + key);

      const res = await service.directUpload(token, Buffer.alloc(900), 'image/jpeg', 'user-1');

      expect(storage.save).toHaveBeenCalledWith(key, expect.any(Buffer), {
        contentType: 'image/jpeg',
      });
      expect(cache.del).toHaveBeenCalledWith(`uploads:token:${token}`);
      expect(res).toEqual({ key, publicUrl: 'http://localhost:5000/static/' + key });
    });

    it('fails for missing/expired token', async () => {
      cache.get.mockResolvedValue(undefined);
      await expect(
        service.directUpload('nope', Buffer.alloc(1), 'image/jpeg', 'u'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('fails for different user', async () => {
      cache.get.mockResolvedValue({
        key: 'k',
        userId: 'other',
        contentType: 'image/jpeg',
        size: 10,
      });
      await expect(
        service.directUpload('t', Buffer.alloc(1), 'image/jpeg', 'u'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('fails for content-type mismatch', async () => {
      cache.get.mockResolvedValue({ key: 'k', userId: 'u', contentType: 'image/png', size: 10 });
      await expect(
        service.directUpload('t', Buffer.alloc(1), 'image/jpeg', 'u'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('fails when body is larger than announced size (+10%)', async () => {
      cache.get.mockResolvedValue({ key: 'k', userId: 'u', contentType: 'image/png', size: 100 });
      await expect(
        service.directUpload('t', Buffer.alloc(112), 'image/png', 'u'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('delete/getPublicUrl', () => {
    it('delegates delete to storage', async () => {
      await service.delete('k1');
      expect(storage.delete).toHaveBeenCalledWith('k1');
    });

    it('delegates getPublicUrl to storage', () => {
      storage.getPublicUrl.mockReturnValue('u');
      expect(service.getPublicUrl('k')).toBe('u');
    });
  });
});
