import { BadRequestException, HttpException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ClaimAccessCheckResult,
  RightsClaimEnforcementService,
} from '../rights-claims/rights-claim-enforcement.service';
import { ClaimBlockScope } from '../rights-claims/rights-claim-interface';
import { GeoBlockScope } from './dto/geo-block.dto';
import { GeoBlockRuleService } from './geo-block-rule.service';

interface RuleRecord {
  id: string;
  bookId: string | null;
  bookVersionId: string | null;
  rightsProfileId: string | null;
  territoryDecisionId: string | null;
  scope: GeoBlockScope;
  countryCode: string;
  accessPolicy: string;
  sourceFinalStatus: string | null;
  isActive: boolean;
  reasonRu: string | null;
  legalBasisRu: string | null;
  generatedFrom: string;
  generatedAt: Date;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  verificationNotesRu: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TerritoryDecisionStub {
  id: string;
  countryCode: string;
  finalStatus: string;
  accessPolicy: string;
  geoBlockRequired: boolean;
  geoBlockScope: string | null;
  reasonRu: string | null;
  legalBasisRu: string | null;
}

interface PrismaStub {
  bookVersion: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  territoryDecision: {
    findMany: jest.Mock;
  };
  geoBlockRule: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    upsert: jest.Mock;
  };
  $transaction: <T>(callback: (transaction: PrismaStub) => Promise<T>) => Promise<T>;
}

const createRule = (overrides: Partial<RuleRecord> = {}): RuleRecord => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  return {
    id: 'rule-1',
    bookId: 'book-1',
    bookVersionId: 'version-1',
    rightsProfileId: 'profile-1',
    territoryDecisionId: 'decision-1',
    scope: GeoBlockScope.LANGUAGE_EDITION,
    countryCode: 'GB',
    accessPolicy: 'BLOCK',
    sourceFinalStatus: 'BLOCKED',
    isActive: true,
    reasonRu: 'Недоступно по правам',
    legalBasisRu: null,
    generatedFrom: 'TERRITORY_DECISION',
    generatedAt: now,
    verifiedAt: null,
    verifiedByUserId: null,
    verificationNotesRu: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

const createDecision = (overrides: Partial<TerritoryDecisionStub> = {}): TerritoryDecisionStub => ({
  id: 'decision-1',
  countryCode: 'GB',
  finalStatus: 'BLOCKED',
  accessPolicy: 'BLOCK',
  geoBlockRequired: true,
  geoBlockScope: null,
  reasonRu: 'Недоступно по правам',
  legalBasisRu: null,
  ...overrides,
});

const createPrismaStub = (): PrismaStub => {
  const stub = {
    bookVersion: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'version-1',
        bookId: 'book-1',
        rightsProfileId: 'profile-1',
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: false,
        rightsGeoBlockVerifiedAt: null,
        rightsGeoBlockLastGeneratedAt: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    territoryDecision: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    geoBlockRule: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockImplementation(({ create }: { create: Record<string, unknown> }) => ({
        ...create,
        id: 'rule-generated',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    },
    $transaction: async <T>(callback: (transaction: PrismaStub) => Promise<T>): Promise<T> =>
      callback(stub),
  };
  return stub;
};

const createClaimEnforcementStub = (): { checkClaimAccess: jest.Mock } => ({
  checkClaimAccess: jest.fn().mockResolvedValue({
    blocked: false,
    countryCode: null,
    scope: ClaimBlockScope.TEXT_READER,
    matchedBlockId: null,
    reasonCode: null,
    messageRu: null,
  } satisfies ClaimAccessCheckResult),
});

describe('GeoBlockRuleService', () => {
  let prisma: PrismaStub;
  let claimEnforcement: { checkClaimAccess: jest.Mock };
  let service: GeoBlockRuleService;

  beforeEach(() => {
    prisma = createPrismaStub();
    claimEnforcement = createClaimEnforcementStub();
    service = new GeoBlockRuleService(
      prisma as unknown as PrismaService,
      claimEnforcement as unknown as RightsClaimEnforcementService,
    );
  });

  it.each([
    ['BLOCKED status', createDecision({ accessPolicy: 'ALLOW', geoBlockRequired: false })],
    [
      'geoBlockRequired marker',
      createDecision({ finalStatus: 'ALLOWED', accessPolicy: 'ALLOW', geoBlockRequired: true }),
    ],
    ['ENTIRE_BOOK scope', createDecision({ geoBlockScope: GeoBlockScope.ENTIRE_BOOK })],
    ['TEXT_READER scope', createDecision({ geoBlockScope: GeoBlockScope.TEXT_READER })],
    ['AUDIO scope', createDecision({ geoBlockScope: GeoBlockScope.AUDIO })],
  ])('generates a rule for %s', async (_caseName, decision) => {
    prisma.territoryDecision.findMany.mockResolvedValue([decision]);

    await service.generateRulesForVersion('version-1');

    expect(prisma.geoBlockRule.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.geoBlockRule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          countryCode: 'GB',
          scope: decision.geoBlockScope ?? GeoBlockScope.LANGUAGE_EDITION,
        }),
      }),
    );
  });

  it('does not generate a rule for an allowed country', async () => {
    prisma.territoryDecision.findMany.mockResolvedValue([
      createDecision({
        finalStatus: 'ALLOWED',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
      }),
    ]);

    await service.generateRulesForVersion('version-1');

    expect(prisma.geoBlockRule.upsert).not.toHaveBeenCalled();
  });

  it('deactivates stale rules before upserting the current projection', async () => {
    prisma.territoryDecision.findMany.mockResolvedValue([createDecision()]);

    await service.generateRulesForVersion('version-1');

    expect(prisma.geoBlockRule.updateMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'version-1', isActive: true },
      data: { isActive: false },
    });
  });

  it('denies access when a country and scope rule match', async () => {
    prisma.geoBlockRule.findMany.mockResolvedValue([
      createRule({ scope: GeoBlockScope.TEXT_READER }),
    ]);

    const result = await service.checkAccess({
      bookVersionId: 'version-1',
      countryCode: 'gb',
      scope: GeoBlockScope.TEXT_READER,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('GEO_BLOCKED_BY_RIGHTS');
    await expect(
      service.assertAccess({
        bookVersionId: 'version-1',
        countryCode: 'GB',
        scope: GeoBlockScope.TEXT_READER,
      }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('allows access for a non-matching country', async () => {
    const result = await service.checkAccess({
      bookVersionId: 'version-1',
      countryCode: 'US',
      scope: GeoBlockScope.TEXT_READER,
    });

    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBeNull();
  });

  it('allows access when the country is unknown', async () => {
    const result = await service.checkAccess({
      bookVersionId: 'version-1',
      countryCode: null,
      scope: GeoBlockScope.AUDIO,
    });

    expect(result.allowed).toBe(true);
    expect(result.countryCode).toBe('UNKNOWN');
  });

  it('answers 451 with BLOCKED_BY_RIGHTS_CLAIM when a claim block matched', async () => {
    claimEnforcement.checkClaimAccess.mockResolvedValue({
      blocked: true,
      countryCode: 'GB',
      scope: ClaimBlockScope.TEXT_READER,
      matchedBlockId: 'block-1',
      reasonCode: 'BLOCKED_BY_RIGHTS_CLAIM',
      messageRu: 'Контент временно недоступен из-за претензии правообладателя.',
    } satisfies ClaimAccessCheckResult);

    const result = await service.checkAccess({
      bookVersionId: 'version-1',
      countryCode: 'GB',
      scope: GeoBlockScope.TEXT_READER,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('BLOCKED_BY_RIGHTS_CLAIM');
    expect(result.matchedRuleId).toBe('block-1');
    // The geo-block rules table is never consulted once a claim block matched.
    expect(prisma.geoBlockRule.findMany).not.toHaveBeenCalled();

    await expect(
      service.assertAccess({
        bookVersionId: 'version-1',
        countryCode: 'GB',
        scope: GeoBlockScope.TEXT_READER,
      }),
    ).rejects.toMatchObject({
      status: 451,
      response: expect.objectContaining({ code: 'BLOCKED_BY_RIGHTS_CLAIM' }),
    });
  });

  it('keeps the GEO_BLOCKED_BY_RIGHTS contract when no claim block matched', async () => {
    prisma.geoBlockRule.findMany.mockResolvedValue([
      createRule({ scope: GeoBlockScope.TEXT_READER }),
    ]);

    await expect(
      service.assertAccess({
        bookVersionId: 'version-1',
        countryCode: 'GB',
        scope: GeoBlockScope.TEXT_READER,
      }),
    ).rejects.toMatchObject({
      status: 451,
      response: expect.objectContaining({ code: 'GEO_BLOCKED_BY_RIGHTS' }),
    });
  });

  it('refuses verification when geo-block is required but no active rules exist', async () => {
    await expect(
      service.verifyRulesForVersion('version-1', { verified: true }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('verifies active rules and updates version audit fields', async () => {
    prisma.geoBlockRule.findMany
      .mockResolvedValueOnce([createRule()])
      .mockResolvedValueOnce([createRule({ verifiedAt: new Date() })]);

    await service.verifyRulesForVersion(
      'version-1',
      { verified: true, notesRu: 'Проверено' },
      'user-1',
    );

    expect(prisma.geoBlockRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          verifiedByUserId: 'user-1',
          verificationNotesRu: 'Проверено',
        }),
      }),
    );
    expect(prisma.bookVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rightsGeoBlockConfigured: true,
          rightsGeoBlockVerifiedByUserId: 'user-1',
        }),
      }),
    );
  });
});
