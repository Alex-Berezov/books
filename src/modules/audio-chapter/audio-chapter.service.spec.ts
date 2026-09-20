import { AudioChapterService } from './audio-chapter.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import {
  ClearanceLockFake,
  createClearanceLockFake,
} from '../../common/testing/clearance-lock-fake';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';

const createPrismaStub = () => {
  const stub = {
    bookVersion: { findUnique: jest.fn().mockResolvedValue({ id: 'v1' }) },
    mediaAsset: { findUnique: jest.fn() },
    audioChapter: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'a1' }),
      update: jest.fn().mockResolvedValue({ id: 'a1' }),
      delete: jest.fn().mockResolvedValue({ id: 'a1' }),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(stub),
  };
  return stub;
};

/**
 * `LEGACY-368`: запись аудиоглавы и пометка stale идут внутри транзакции под замком группы
 * клиренса. Запись мимо обёртки снова даёт 40P01 со встречной правкой соседней версии.
 */
describe('AudioChapterService clearance lock', () => {
  let prisma: ReturnType<typeof createPrismaStub>;
  let hash: { checkVersionStaleness: jest.Mock };
  let clearanceLock: ClearanceLockFake;
  let adminAudit: { record: jest.Mock };
  let seen: string[];
  let service: AudioChapterService;

  beforeEach(() => {
    prisma = createPrismaStub();
    clearanceLock = createClearanceLockFake(prisma);
    adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
    seen = [];
    const track = (name: string, result: unknown) => (): Promise<unknown> => {
      seen.push(`${name}:${clearanceLock.isLocked() ? 'locked' : 'open'}`);
      return Promise.resolve(result);
    };
    prisma.audioChapter.create.mockImplementation(track('write', { id: 'a1' }));
    prisma.audioChapter.update.mockImplementation(track('write', { id: 'a1' }));
    prisma.audioChapter.delete.mockImplementation(track('write', { id: 'a1' }));
    hash = { checkVersionStaleness: jest.fn(track('stale', undefined)) };
    service = new AudioChapterService(
      prisma as unknown as PrismaService,
      hash as unknown as RightsContentHashService,
      { assertAccess: jest.fn() } as unknown as GeoBlockRuleService,
      clearanceLock.service,
      adminAudit as unknown as AdminAuditService,
    );
  });

  const allUnderOneLock = () => {
    expect(clearanceLock.lockedVersions).toEqual(['v1']);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((entry) => entry.endsWith(':locked'))).toBe(true);
    expect(seen[seen.length - 1]).toBe('stale:locked');
  };

  it('create', async () => {
    await service.create('v1', { number: 1, title: 'T', audioUrl: 'https://a/1.mp3', duration: 1 });

    allUnderOneLock();
  });

  it('update', async () => {
    prisma.audioChapter.findUnique.mockResolvedValue({ id: 'a1', bookVersionId: 'v1', number: 1 });

    await service.update('a1', { title: 'T2' });

    allUnderOneLock();
  });

  it('remove', async () => {
    prisma.audioChapter.findUnique.mockResolvedValue({ id: 'a1', bookVersionId: 'v1' });

    await service.remove('a1', 'admin-1');

    allUnderOneLock();
  });

  /**
   * `LEGACY-015`, пачка `T19`. Проверяется состав события и то, что удаление
   * по-прежнему идёт под замком группы.
   *
   * ⚠️ Момент вызова `adminAudit.record` в `seen` не отслеживается — туда попадают
   * только операции `prisma` (`write`) и пересчёт свежести (`stale`). Значит переезд
   * записи журнала за `checkVersionStaleness` этот тест не поймает; комментарий
   * уточнён по находке круга 2 ревью 20.09.2026, чтобы не обещать проверки,
   * которой здесь нет.
   */
  it('remove пишет AUDIO_CHAPTER_DELETED под замком группы', async () => {
    prisma.audioChapter.findUnique.mockResolvedValue({ id: 'a1', bookVersionId: 'v1' });

    await service.remove('a1', 'admin-1');

    allUnderOneLock();
    expect(adminAudit.record).toHaveBeenCalledTimes(1);
    expect(adminAudit.record.mock.calls[0][1]).toEqual({
      action: 'AUDIO_CHAPTER_DELETED',
      targetType: 'AUDIO_CHAPTER',
      targetId: 'a1',
      actorUserId: 'admin-1',
      payload: { bookVersionId: 'v1' },
    });
  });

  it('reorder', async () => {
    prisma.audioChapter.findMany
      .mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }])
      .mockResolvedValueOnce([{ id: 'a2' }, { id: 'a1' }]);

    await service.reorder('v1', ['a2', 'a1']);

    allUnderOneLock();
  });
});
