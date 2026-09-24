import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../shared/storage/storage.interface';
import {
  MEDIA_CLEANUP_ALREADY_RUNNING,
  MEDIA_CLEANUP_LOCK_KEY,
  MediaCleanupService,
} from './media-cleanup.service';
import { MEDIA_FOREIGN_KEY_RELATIONS } from '../media/media-references';

interface Setup {
  locked?: boolean;
  fkCandidates?: Array<{ id: string; key: string }>;
  hardCandidates?: Array<{ id: string; key: string }>;
  urlRows?: Record<string, Array<Record<string, unknown>>>;
}

const makeService = ({
  locked = true,
  fkCandidates = [],
  hardCandidates = [],
  urlRows = {},
}: Setup = {}) => {
  const queryRaw = jest.fn().mockResolvedValue([{ locked }]);
  const tx = { $queryRaw: queryRaw };
  const mediaAsset = {
    findMany: jest.fn((args: { where: { isDeleted: boolean } }) =>
      Promise.resolve(args.where.isDeleted ? hardCandidates : fkCandidates),
    ),
    updateMany: jest.fn((args: { where: { id: { in: string[] } } }) =>
      Promise.resolve({ count: args.where.id.in.length }),
    ),
    delete: jest.fn().mockResolvedValue({}),
  };
  // Любой делегат адресной колонки: отдаёт строки `urlRows`, чьи поля содержат ключ из `OR`.
  // Список моделей не выписывается — новая колонка в перечне не требует правки мока.
  const urlDelegates: Record<string, { findMany: jest.Mock }> = {};
  const urlProxy = new Proxy(urlDelegates, {
    get: (target, model: string) =>
      (target[model] ??= {
        findMany: jest.fn((args: { where: { OR: Array<Record<string, { contains: string }>> } }) =>
          Promise.resolve(
            (urlRows[model] ?? []).filter((row) =>
              args.where.OR.some((cond) =>
                Object.entries(cond).every(
                  ([field, { contains }]) =>
                    typeof row[field] === 'string' && row[field].includes(contains),
                ),
              ),
            ),
          ),
        ),
      }),
  });
  const $transaction = jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  const prisma = new Proxy({ $transaction, mediaAsset } as Record<string, unknown>, {
    get: (target, name: string) => target[name] ?? (urlProxy as Record<string, unknown>)[name],
  }) as unknown as PrismaService;
  const storage = { delete: jest.fn().mockResolvedValue(undefined) };
  const service = new MediaCleanupService(prisma, storage as unknown as StorageService);
  return {
    service,
    queryRaw,
    $transaction,
    mediaAsset,
    storage,
    urlDelegates,
  };
};

describe('MediaCleanupService lock (LEGACY-413)', () => {
  it('takes the cleanup advisory lock with try-semantics before any work', async () => {
    const { service, queryRaw } = makeService();
    await service.cleanupIfIdle({ dryRun: true });

    const [strings, key] = queryRaw.mock.calls[0] as [TemplateStringsArray, bigint];
    expect(strings.join('?')).toContain('pg_try_advisory_xact_lock(');
    expect(key).toBe(MEDIA_CLEANUP_LOCK_KEY);
  });

  it('returns null and does nothing while another run holds the lock', async () => {
    const { service, mediaAsset, storage } = makeService({
      locked: false,
      fkCandidates: [{ id: 'a1', key: 'k1' }],
      hardCandidates: [{ id: 'a2', key: 'k2' }],
    });

    await expect(service.cleanupIfIdle()).resolves.toBeNull();
    expect(mediaAsset.findMany).not.toHaveBeenCalled();
    expect(mediaAsset.updateMany).not.toHaveBeenCalled();
    expect(mediaAsset.delete).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('answers the manual path with 409 MEDIA_CLEANUP_ALREADY_RUNNING while locked', async () => {
    const { service } = makeService({ locked: false });

    const error = await service.cleanup().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: MEDIA_CLEANUP_ALREADY_RUNNING,
    });
  });

  it('runs when the lock is free', async () => {
    const { service, mediaAsset } = makeService({ fkCandidates: [{ id: 'a1', key: 'k1' }] });

    const result = await service.cleanup();
    expect(result.markedSoftDeleted).toBe(1);
    expect(mediaAsset.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('MediaCleanupService lost lock (LEGACY-413)', () => {
  it('stops stage 2 before the next file once the lock transaction is closed', async () => {
    const { service, queryRaw, storage, mediaAsset } = makeService({
      hardCandidates: [
        { id: 'a1', key: 'k1' },
        { id: 'a2', key: 'k2' },
        { id: 'a3', key: 'k3' },
      ],
    });
    // Замок, первый `SELECT 1` проходит, второй видит закрытую по timeout транзакцию.
    queryRaw
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockRejectedValueOnce(new Error('Transaction already closed'));

    await expect(service.cleanup()).rejects.toThrow('Transaction already closed');
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(mediaAsset.delete).toHaveBeenCalledTimes(1);
  });

  it('does not mark soft-deletes once the lock transaction is closed', async () => {
    const { service, queryRaw, mediaAsset } = makeService({
      fkCandidates: [{ id: 'a1', key: 'k1' }],
    });
    queryRaw
      .mockResolvedValueOnce([{ locked: true }])
      .mockRejectedValueOnce(new Error('Transaction already closed'));

    await expect(service.cleanup()).rejects.toThrow('Transaction already closed');
    expect(mediaAsset.updateMany).not.toHaveBeenCalled();
  });
});

describe('MediaCleanupService orphan criterion (LEGACY-413)', () => {
  it('stage 1 excludes assets referenced by any of the five foreign keys', async () => {
    const { service, mediaAsset } = makeService();
    await service.cleanup({ dryRun: true });

    const where = (mediaAsset.findMany.mock.calls[0][0] as { where: Record<string, unknown> })
      .where;
    for (const relation of MEDIA_FOREIGN_KEY_RELATIONS)
      expect(where[relation]).toEqual({ none: {} });
  });

  it('skips reading URL columns when no asset is an FK candidate', async () => {
    const { service, urlDelegates } = makeService();
    await service.cleanup();

    expect(Object.keys(urlDelegates)).toEqual([]);
  });

  it('does not soft-delete an asset referenced only by a category og:image', async () => {
    const { service, mediaAsset } = makeService({
      fkCandidates: [
        { id: 'og', key: 'uploads/og.webp' },
        { id: 'orphan', key: 'uploads/orphan.webp' },
      ],
      urlRows: { categoryTranslation: [{ ogImageUrl: 'https://cdn.example/uploads/og.webp' }] },
    });

    const result = await service.cleanup();
    expect(result.skippedByUrlReference).toBe(1);
    const updateArgs = mediaAsset.updateMany.mock.calls[0][0] as {
      where: { id: { in: string[] } };
    };
    expect(updateArgs.where.id.in).toEqual(['orphan']);
  });
});

describe('MediaCleanupService rights references without FK (LEGACY-413)', () => {
  it('keeps assets referenced only by a license document URL or an attachment storage key', async () => {
    const { service, mediaAsset } = makeService({
      fkCandidates: [
        { id: 'license-doc', key: 'uploads/license.pdf' },
        { id: 'attachment', key: 'uploads/notice.pdf' },
        { id: 'orphan', key: 'uploads/orphan.webp' },
      ],
      urlRows: {
        rightsLicense: [{ id: 'lic1', documentUrl: 'https://cdn.example/uploads/license.pdf' }],
        rightsClaimAttachment: [{ id: 'att1', title: 'Notice', storageKey: 'uploads/notice.pdf' }],
      },
    });

    const result = await service.cleanup();
    expect(result.skippedByUrlReference).toBe(2);
    const updateArgs = mediaAsset.updateMany.mock.calls[0][0] as {
      where: { id: { in: string[] } };
    };
    expect(updateArgs.where.id.in).toEqual(['orphan']);
  });

  it('re-checks foreign keys and the deleted flag in the soft-delete write itself', async () => {
    const { service, mediaAsset } = makeService({ fkCandidates: [{ id: 'a1', key: 'k1' }] });
    await service.cleanup();

    const where = (mediaAsset.updateMany.mock.calls[0][0] as { where: Record<string, unknown> })
      .where;
    expect(where.isDeleted).toBe(false);
    for (const relation of MEDIA_FOREIGN_KEY_RELATIONS) {
      expect(where[relation]).toEqual({ none: {} });
    }
  });
});

describe('MediaCleanupService stage 2 failures', () => {
  it('survives a missing storage object and a row already deleted by someone else', async () => {
    const { service, mediaAsset, storage } = makeService({
      hardCandidates: [
        { id: 'gone-file', key: 'k1' },
        { id: 'gone-row', key: 'k2' },
        { id: 'ok', key: 'k3' },
      ],
    });
    storage.delete.mockImplementation((key: string) =>
      key === 'k1' ? Promise.reject(new Error('NoSuchKey')) : Promise.resolve(),
    );
    mediaAsset.delete.mockImplementation((args: { where: { id: string } }) =>
      args.where.id === 'gone-row'
        ? Promise.reject(Object.assign(new Error('Record not found'), { code: 'P2025' }))
        : Promise.resolve({}),
    );

    const result = await service.cleanup();
    expect(result.storageErrors).toBe(1);
    expect(result.storageFilesRemoved).toBe(2);
    expect(result.hardDeleted).toBe(2);
  });
});
