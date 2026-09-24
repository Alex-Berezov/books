import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  MEDIA_CLEANUP_LOCK_KEY,
  MediaCleanupService,
} from '../src/modules/media-jobs/media-cleanup.service';
import { STORAGE_SERVICE, StorageService } from '../src/shared/storage/storage.interface';

/**
 * 🔴 `LEGACY-413`. Таймер уборки медиа и `POST /admin/media/cleanup-orphans` звали один
 * `cleanup()` без взаимного исключения. Юнит видит только мок `$queryRaw`; что
 * `pg_try_advisory_xact_lock` с ключом `bigint` действительно разбирается Postgres
 * и действительно отказывает, пока замок держит другое соединение, проверяется здесь.
 *
 * Удаляет спека только свои ассеты с меткой `e2e-lock-*`: они помечены 400 дней назад, а прогон
 * без `dryRun` идёт с `hardDays: 399` — чужие строки набора так далеко в прошлом не лежат.
 * Остальные прогоны — `dryRun`.
 */
describe('LEGACY-413 — уборка медиа разведена замком (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let cleanup: MediaCleanupService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    cleanup = moduleRef.get(MediaCleanupService);

    await moduleRef.init();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  /** Держит замок уборки в отдельной транзакции, пока не позовут `release`. */
  const holdLock = async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const isAcquired = new Promise<void>((resolve) => (acquired = resolve));

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(${MEDIA_CLEANUP_LOCK_KEY})`;
        acquired();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await isAcquired;
    return { release, holder };
  };

  /**
   * Транзакция замка закрылась посреди stage 2 (в проде — по `timeout`): замок отпущен, и
   * прогон обязан оборваться до следующего файла, а не удалять рядом с соседним прогоном.
   * Закрытие воспроизводится завершением backend-процесса, держащего замок, из хранилища —
   * без ожидания часового `timeout`.
   */
  it('stops stage 2 before the next asset once the lock transaction is closed', async () => {
    const stamp = Date.now();
    const keys = [1, 2, 3].map((n) => `e2e-lock-${stamp}/${n}.webp`);
    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    await prisma.mediaAsset.createMany({
      data: keys.map((key) => ({
        key,
        url: `https://cdn.example/${key}`,
        isDeleted: true,
        deletedAt: longAgo,
        createdAt: longAgo,
      })),
    });

    const storage = moduleRef.get<StorageService>(STORAGE_SERVICE);
    let deletes = 0;
    const spy = jest.spyOn(storage, 'delete').mockImplementation(async () => {
      deletes += 1;
      if (deletes === 1) {
        await prisma.$queryRaw`
          SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks
          WHERE locktype = 'advisory' AND granted
            AND classid = ((${MEDIA_CLEANUP_LOCK_KEY}::bigint >> 32)::oid)
            AND objid = ((${MEDIA_CLEANUP_LOCK_KEY}::bigint & 4294967295)::oid)
            AND objsubid = 1`;
      }
    });

    try {
      await expect(cleanup.cleanupIfIdle({ hardDays: 399, softDays: 36_500 })).rejects.toThrow();
      expect(deletes).toBe(1);
      const left = await prisma.mediaAsset.count({ where: { key: { in: keys } } });
      expect(left).toBe(2);
    } finally {
      spy.mockRestore();
      await prisma.mediaAsset.deleteMany({ where: { key: { in: keys } } });
    }
  });

  it('skips and answers 409 while another connection holds the lock, runs after release', async () => {
    const { release, holder } = await holdLock();
    try {
      await expect(cleanup.cleanupIfIdle({ dryRun: true })).resolves.toBeNull();
      await expect(cleanup.cleanup({ dryRun: true })).rejects.toBeInstanceOf(ConflictException);
    } finally {
      release();
      await holder;
    }

    const result = await cleanup.cleanupIfIdle({ dryRun: true });
    expect(result).not.toBeNull();
    expect(result?.markedSoftDeleted).toBeGreaterThanOrEqual(0);
  });
});
