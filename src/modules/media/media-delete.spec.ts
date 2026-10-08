import { ConflictException, Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StorageService } from '../../shared/storage/storage.interface';
import { deleteMediaObject } from './media-delete';
import { findMediaReferenceDescriptors } from './media-references';

jest.mock('./media-references', () => ({ findMediaReferenceDescriptors: jest.fn() }));

/**
 * Протокол удаления, общий для `DELETE /media/:id` и `DELETE /uploads` (`LEGACY-444`, `LEGACY-421`):
 * занятый объект не удаляется, запись помечается до удаления файла, отказ хранилища не роняет ответ.
 */
describe('deleteMediaObject', () => {
  const findRefs = findMediaReferenceDescriptors as jest.Mock;
  const db = { mediaAsset: { update: jest.fn() } };
  const storage = { delete: jest.fn() };
  const logger = { error: jest.fn() };
  const deps = {
    prisma: db as unknown as PrismaService,
    storage: storage as unknown as StorageService,
    logger: logger as unknown as Logger,
  };
  const key = 'covers/2026/10/08/x.jpg';
  const asset = { id: 'a1', isDeleted: false, deletedAt: null };

  beforeEach(() => {
    jest.clearAllMocks();
    findRefs.mockResolvedValue([]);
    db.mediaAsset.update.mockResolvedValue({});
    storage.delete.mockResolvedValue(undefined);
  });

  it('на объект ссылаются: 409 со ссылками, ни запись, ни файл не тронуты', async () => {
    findRefs.mockResolvedValue(['book version cover "T" (1)']);
    await expect(deleteMediaObject(deps, { key, asset })).rejects.toBeInstanceOf(ConflictException);
    expect(findRefs).toHaveBeenCalledTimes(1);
    expect(findRefs).toHaveBeenCalledWith(db, { id: 'a1', key });
    expect(db.mediaAsset.update).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('запись помечается удалённой до удаления файла, строка не сносится', async () => {
    await expect(deleteMediaObject(deps, { key, asset })).resolves.toEqual({
      storageDeleted: true,
    });
    expect(db.mediaAsset.update).toHaveBeenCalledTimes(1);
    expect(db.mediaAsset.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'a1' },
      data: { isDeleted: true },
    });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(key);
    expect(db.mediaAsset.update.mock.invocationCallOrder[0]).toBeLessThan(
      storage.delete.mock.invocationCallOrder[0],
    );
  });

  it('повторное удаление помеченной записи срок уборки не отодвигает', async () => {
    const first = new Date('2026-10-01T00:00:00Z');
    await deleteMediaObject(deps, { key, asset: { id: 'a1', isDeleted: true, deletedAt: first } });
    expect(db.mediaAsset.update.mock.calls[0][0]).toMatchObject({ data: { deletedAt: first } });
  });

  it('отказ хранилища: запись помечена, ответ без падения, в логе ошибка', async () => {
    storage.delete.mockRejectedValue(new Error('r2 down'));
    await expect(deleteMediaObject(deps, { key, asset })).resolves.toEqual({
      storageDeleted: false,
    });
    expect(db.mediaAsset.update).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('объект без записи: ссылки ищутся по ключу, удаляется только файл', async () => {
    await deleteMediaObject(deps, { key, asset: null });
    expect(findRefs).toHaveBeenCalledWith(db, { id: '', key });
    expect(db.mediaAsset.update).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });
});
