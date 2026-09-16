import { AudioChapterService } from './audio-chapter.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import {
  ClearanceLockFake,
  createClearanceLockFake,
} from '../../common/testing/clearance-lock-fake';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';

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
  let seen: string[];
  let service: AudioChapterService;

  beforeEach(() => {
    prisma = createPrismaStub();
    clearanceLock = createClearanceLockFake(prisma);
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

    await service.remove('a1');

    allUnderOneLock();
  });

  it('reorder', async () => {
    prisma.audioChapter.findMany
      .mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }])
      .mockResolvedValueOnce([{ id: 'a2' }, { id: 'a1' }]);

    await service.reorder('v1', ['a2', 'a1']);

    allUnderOneLock();
  });
});
