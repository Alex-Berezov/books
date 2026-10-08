import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  PayloadTooLargeException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import { UploadsService } from './uploads.service';
import { UploadType } from './dto/presign.dto';
import type { PrismaService } from '../../prisma/prisma.service';
import { deleteMediaObject } from '../media/media-delete';
import type { CacheService } from '../../shared/cache/cache.interface';
import type {
  StorageSaveOptions,
  StorageService,
  StorageStat,
} from '../../shared/storage/storage.interface';

jest.mock('../media/media-delete', () => ({ deleteMediaObject: jest.fn() }));

describe('UploadsService (unit)', () => {
  const cache = {
    get: jest.fn<Promise<unknown>, [string]>(),
    set: jest.fn<Promise<void>, [string, unknown, number?]>(),
    del: jest.fn<Promise<void>, [string]>(),
  };
  const storage = {
    save: jest.fn<Promise<string>, [string, Buffer | Readable, StorageSaveOptions?]>(),
    delete: jest.fn<Promise<void>, [string]>(),
    exists: jest.fn<Promise<boolean>, [string]>(),
    stat: jest.fn<Promise<StorageStat | null>, [string]>(),
    getPublicUrl: jest.fn<string, [string]>(),
  };

  const prisma = {
    mediaAsset: { findUnique: jest.fn() },
  };
  const deleteObject = deleteMediaObject as jest.Mock;

  let service: UploadsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UploadsService(
      cache as unknown as CacheService,
      storage as unknown as StorageService,
      prisma as unknown as PrismaService,
    );
    deleteObject.mockResolvedValue({ storageDeleted: true });
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
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('rejects too large image', async () => {
      const tooBig = 6 * 1024 * 1024; // default max 5MB
      await expect(
        service.presign({ type: UploadType.cover, contentType: 'image/png', size: tooBig }, 'u'),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
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

  describe('remove (LEGACY-444)', () => {
    const owner = { userId: 'u1', isModerator: false };
    const staff = { userId: 'm1', isModerator: true };
    const key = 'covers/2026/10/08/x.jpg';
    const asset = { id: 'a1', key, createdById: 'u1', isDeleted: false, deletedAt: null };

    it.each([
      'rights-private/doc.pdf',
      'prod/rights-private/doc.pdf',
      'covers/../rights-private/doc.pdf',
      'covers/./2026/10/08/x.jpg',
      'covers//x.jpg',
      'covers/',
      'covers',
      '../covers/x.jpg',
      'covers/a b.jpg',
    ])('ключ %s вне формы presign - 400 даже модератору, ничего не тронуто', async (bad) => {
      await expect(service.remove(bad, staff)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.mediaAsset.findUnique).not.toHaveBeenCalled();
      expect(deleteObject).not.toHaveBeenCalled();
    });

    it('аудио обычному пользователю - 403', async () => {
      await expect(service.remove('audio/2026/10/08/x.mp3', owner)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(deleteObject).not.toHaveBeenCalled();
    });

    it('чужая обложка: 403, удаление не начато', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({ ...asset, createdById: 'someone-else' });
      await expect(service.remove(key, owner)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.mediaAsset.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.mediaAsset.findUnique).toHaveBeenCalledWith({ where: { key } });
      expect(deleteObject).not.toHaveBeenCalled();
    });

    it('своя, но уже помеченная удалённой запись: 403', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({ ...asset, isDeleted: true });
      await expect(service.remove(key, owner)).rejects.toBeInstanceOf(ForbiddenException);
      expect(deleteObject).not.toHaveBeenCalled();
    });

    it('ключ без MediaAsset: обычному пользователю 403', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(null);
      await expect(service.remove(key, owner)).rejects.toBeInstanceOf(ForbiddenException);
      expect(deleteObject).not.toHaveBeenCalled();
    });

    it('ключ без MediaAsset: модератор удаляет по общему протоколу', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(null);
      await service.remove(key, staff);
      expect(deleteObject).toHaveBeenCalledTimes(1);
      expect(deleteObject.mock.calls[0][1]).toEqual({ key, asset: null });
    });

    it('своя обложка: удаление по общему протоколу с записью', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(asset);
      await service.remove(key, owner);
      expect(deleteObject).toHaveBeenCalledTimes(1);
      expect(deleteObject.mock.calls[0][1]).toEqual({ key, asset });
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('аудио у модератора: удаляется', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(null);
      await expect(service.remove('audio/2026/10/08/x.mp3', staff)).resolves.toEqual({
        success: true,
        storageDeleted: true,
      });
      expect(deleteObject).toHaveBeenCalledTimes(1);
    });

    it('отказ хранилища доходит до ответа: storageDeleted=false', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(asset);
      deleteObject.mockResolvedValue({ storageDeleted: false });
      await expect(service.remove(key, owner)).resolves.toEqual({
        success: true,
        storageDeleted: false,
      });
    });

    it('409 владельцу без перечня ссылок, модератору - с перечнем', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(asset);
      const withRefs = new ConflictException({ message: 'x', references: ['rights claim (1)'] });
      deleteObject.mockRejectedValue(withRefs);

      const ownerError = await service.remove(key, owner).catch((e: unknown) => e);
      expect(ownerError).toBeInstanceOf(ConflictException);
      expect(JSON.stringify((ownerError as ConflictException).getResponse())).not.toContain(
        'rights claim',
      );

      await expect(service.remove(key, staff)).rejects.toBe(withRefs);
    });

    it('чужая обложка у модератора: удаляется', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(asset);
      await service.remove(key, staff);
      expect(deleteObject).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPublicUrl', () => {
    it('delegates getPublicUrl to storage', () => {
      storage.getPublicUrl.mockReturnValue('u');
      expect(service.getPublicUrl('k')).toBe('u');
    });
  });
});
