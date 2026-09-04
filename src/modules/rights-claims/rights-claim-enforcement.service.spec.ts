import { RightsClaimAccessBlock } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsClaimEnforcementService } from './rights-claim-enforcement.service';
import { ClaimBlockScope, RightsClaimBlockStatus } from './rights-claim-interface';

const now = new Date('2026-07-28T12:00:00.000Z');

const createBlock = (overrides: Partial<RightsClaimAccessBlock> = {}): RightsClaimAccessBlock => ({
  id: 'block-1',
  rightsClaimId: 'claim-1',
  bookId: 'book-1',
  bookVersionId: 'version-1',
  scope: ClaimBlockScope.LANGUAGE_EDITION,
  countryCode: null,
  status: RightsClaimBlockStatus.ACTIVE,
  reasonRu: 'Претензия правообладателя',
  appliedAt: new Date('2026-07-27T12:00:00.000Z'),
  appliedByUserId: 'user-1',
  expiresAt: null,
  liftedAt: null,
  liftedByUserId: null,
  liftReasonRu: null,
  createdAt: new Date('2026-07-27T12:00:00.000Z'),
  updatedAt: new Date('2026-07-27T12:00:00.000Z'),
  ...overrides,
});

interface PrismaStub {
  rightsClaimAccessBlock: { findMany: jest.Mock };
  bookVersion: { findUnique: jest.Mock };
}

describe('RightsClaimEnforcementService', () => {
  let prisma: PrismaStub;
  let service: RightsClaimEnforcementService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      rightsClaimAccessBlock: { findMany: jest.fn().mockResolvedValue([]) },
      bookVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'version-1',
          bookId: 'book-1',
          status: 'published',
        }),
      },
    };
    service = new RightsClaimEnforcementService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows access when there are no blocks', async () => {
    const result = await service.checkClaimAccess({
      bookVersionId: 'version-1',
      countryCode: 'DE',
      scope: ClaimBlockScope.TEXT_READER,
    });

    expect(result.blocked).toBe(false);
    expect(result.reasonCode).toBeNull();
  });

  // LEGACY-121: the query is the only place where a typo in a column name silently changes which
  // blocks are found. `tsc` is the barrier for the names; this pins the set of conditions itself,
  // so a narrowed or widened lookup cannot pass as a retyping.
  it('asks for active blocks of the version and of the whole book, in one query', async () => {
    await service.checkClaimAccess({
      bookVersionId: 'version-1',
      countryCode: 'DE',
      scope: ClaimBlockScope.TEXT_READER,
    });

    expect(prisma.rightsClaimAccessBlock.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.rightsClaimAccessBlock.findMany).toHaveBeenCalledWith({
      where: {
        status: RightsClaimBlockStatus.ACTIVE,
        OR: [
          { bookVersionId: 'version-1' },
          { bookId: 'book-1', scope: ClaimBlockScope.ENTIRE_BOOK },
        ],
      },
    });
  });

  it('blocks any country when a worldwide ENTIRE_BOOK block is active', async () => {
    prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
      createBlock({ scope: ClaimBlockScope.ENTIRE_BOOK, bookVersionId: null, countryCode: null }),
    ]);

    const result = await service.checkClaimAccess({
      bookVersionId: 'version-1',
      countryCode: 'BR',
      scope: ClaimBlockScope.AUDIO,
    });

    expect(result.blocked).toBe(true);
    expect(result.reasonCode).toBe('BLOCKED_BY_RIGHTS_CLAIM');
    expect(result.matchedBlockId).toBe('block-1');
  });

  it('blocks an unknown country when the block is worldwide', async () => {
    prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([createBlock({ countryCode: null })]);

    const result = await service.checkClaimAccess({
      bookVersionId: 'version-1',
      countryCode: null,
      scope: ClaimBlockScope.TEXT_READER,
    });

    expect(result.blocked).toBe(true);
    expect(result.countryCode).toBeNull();
  });

  it('does not fire a country-scoped block for an unknown country', async () => {
    prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([createBlock({ countryCode: 'DE' })]);

    const result = await service.checkClaimAccess({
      bookVersionId: 'version-1',
      countryCode: null,
      scope: ClaimBlockScope.TEXT_READER,
    });

    expect(result.blocked).toBe(false);
  });

  it('matches a country-scoped block case-insensitively', async () => {
    prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([createBlock({ countryCode: 'DE' })]);

    const result = await service.checkClaimAccess({
      bookVersionId: 'version-1',
      countryCode: 'de',
      scope: ClaimBlockScope.TEXT_READER,
    });

    expect(result.blocked).toBe(true);
    expect(result.countryCode).toBe('DE');
  });

  it('does not apply an AUDIO block to a TEXT_READER request', async () => {
    prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
      createBlock({ scope: ClaimBlockScope.AUDIO }),
    ]);

    const result = await service.checkClaimAccess({
      bookVersionId: 'version-1',
      countryCode: 'DE',
      scope: ClaimBlockScope.TEXT_READER,
    });

    expect(result.blocked).toBe(false);
  });

  it('ignores a block whose expiry has passed', async () => {
    prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
      createBlock({ expiresAt: new Date('2026-07-28T11:00:00.000Z') }),
    ]);

    const result = await service.checkClaimAccess({
      bookVersionId: 'version-1',
      countryCode: 'DE',
      scope: ClaimBlockScope.TEXT_READER,
    });

    expect(result.blocked).toBe(false);
  });

  it('ignores a lifted block', async () => {
    prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
      createBlock({
        status: RightsClaimBlockStatus.LIFTED,
        liftedAt: new Date('2026-07-28T09:00:00.000Z'),
      }),
    ]);
    // The query filters ACTIVE rows; feeding a LIFTED row through proves the in-memory guard too.
    const result = await service.checkClaimAccess({
      bookVersionId: 'version-1',
      countryCode: 'DE',
      scope: ClaimBlockScope.TEXT_READER,
    });

    expect(prisma.rightsClaimAccessBlock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: RightsClaimBlockStatus.ACTIVE }),
      }),
    );
    expect(result.blocked).toBe(false);
  });
});
