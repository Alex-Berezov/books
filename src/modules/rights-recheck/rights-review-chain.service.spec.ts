import { PrismaService } from '../../prisma/prisma.service';
import { RightsReviewChainService } from './rights-review-chain.service';
import type { RecheckReviewRecord } from './rights-recheck-interface';

const NOW = new Date('2026-07-30T00:00:00.000Z');

const review = (overrides: Partial<RecheckReviewRecord> = {}): RecheckReviewRecord => ({
  id: 'review-1',
  rightsProfileId: 'profile-1',
  status: 'HUMAN_APPROVED',
  approvedAt: NOW,
  nextReviewAt: null,
  previousReviewId: null,
  chainRootReviewId: 'review-1',
  revisionNumber: 1,
  overallStatus: 'PUBLIC_DOMAIN',
  publicationGate: 'ALLOW',
  confidence: 'HIGH',
  rightsReviewImportId: 'import-1',
  approvedByUserId: 'u1',
  approvedByUser: { id: 'u1', name: 'Редактор', email: 'editor@example.com' },
  createdAt: NOW,
  rightsProfile: { isCurrent: true },
  ...overrides,
});

interface Stub {
  rightsReview: Record<string, jest.Mock>;
  rightsProfile: Record<string, jest.Mock>;
  rightsIntake: Record<string, jest.Mock>;
  territoryDecision: Record<string, jest.Mock>;
  rightsRecheckTask: Record<string, jest.Mock>;
  rightsRecheckEvent: Record<string, jest.Mock>;
  rightsLegalChangeEvent: Record<string, jest.Mock>;
  rightsRecheckScanRun: Record<string, jest.Mock>;
  $transaction: jest.Mock;
}

const createStub = (): Stub => ({
  rightsReview: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue(review()),
  },
  rightsProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'profile-1' }) },
  rightsIntake: {
    findUnique: jest
      .fn()
      .mockResolvedValue({ id: 'intake-1', candidateTitle: 'Одиссея', workflowStatus: 'APPROVED' }),
  },
  territoryDecision: { findMany: jest.fn().mockResolvedValue([]) },
  rightsRecheckTask: {},
  rightsRecheckEvent: {},
  rightsLegalChangeEvent: {},
  rightsRecheckScanRun: {},
  $transaction: jest.fn(),
});

describe('RightsReviewChainService', () => {
  let stub: Stub;
  let service: RightsReviewChainService;

  beforeEach(() => {
    stub = createStub();
    service = new RightsReviewChainService(stub as unknown as PrismaService);
  });

  it('returns an empty chain for an intake without reviews', async () => {
    const result = await service.getChainForIntake('intake-1');

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('fails with RECHECK_INTAKE_NOT_FOUND for an unknown intake', async () => {
    stub.rightsIntake.findUnique.mockResolvedValue(null);

    await expect(service.getChainForIntake('missing')).rejects.toMatchObject({
      response: { code: 'RECHECK_INTAKE_NOT_FOUND', statusCode: 404 },
    });
  });

  it('returns three revisions in order with no diff on the first one', async () => {
    stub.rightsReview.findMany.mockResolvedValue([
      review({ id: 'r1', revisionNumber: 1 }),
      review({ id: 'r2', revisionNumber: 2, previousReviewId: 'r1', rightsProfileId: 'profile-2' }),
      review({ id: 'r3', revisionNumber: 3, previousReviewId: 'r2', rightsProfileId: 'profile-3' }),
    ]);

    const result = await service.getChainForIntake('intake-1');

    expect(result.items.map((item) => item.revisionNumber)).toEqual([1, 2, 3]);
    expect(result.items[0].diffFromPrevious).toBeNull();
    expect(result.items[1].diffFromPrevious).not.toBeNull();
  });

  it('flags a publication gate change between neighbouring revisions', async () => {
    stub.rightsReview.findMany.mockResolvedValue([
      review({ id: 'r1', revisionNumber: 1, publicationGate: 'ALLOW' }),
      review({
        id: 'r2',
        revisionNumber: 2,
        previousReviewId: 'r1',
        publicationGate: 'BLOCK',
        rightsProfileId: 'profile-2',
      }),
    ]);

    const result = await service.getChainForIntake('intake-1');

    expect(result.items[1].diffFromPrevious?.publicationGateChanged).toBe(true);
    expect(result.items[1].diffFromPrevious?.overallStatusChanged).toBe(false);
  });

  it('counts countries whose final status differs between the two profiles', async () => {
    stub.rightsReview.findMany.mockResolvedValue([
      review({ id: 'r1', revisionNumber: 1, rightsProfileId: 'profile-1' }),
      review({
        id: 'r2',
        revisionNumber: 2,
        previousReviewId: 'r1',
        rightsProfileId: 'profile-2',
      }),
    ]);
    stub.territoryDecision.findMany.mockResolvedValue([
      { rightsProfileId: 'profile-1', countryCode: 'DE', finalStatus: 'ALLOWED' },
      { rightsProfileId: 'profile-1', countryCode: 'FR', finalStatus: 'ALLOWED' },
      { rightsProfileId: 'profile-2', countryCode: 'DE', finalStatus: 'BLOCKED' },
      { rightsProfileId: 'profile-2', countryCode: 'FR', finalStatus: 'ALLOWED' },
      { rightsProfileId: 'profile-2', countryCode: 'US', finalStatus: 'ALLOWED' },
    ]);

    const result = await service.getChainForIntake('intake-1');

    // DE changed status and US is new — FR is unchanged.
    expect(result.items[1].diffFromPrevious?.changedCountryCount).toBe(2);
  });

  describe('linkNewReview', () => {
    it('makes the first review revision 1 rooted at itself', async () => {
      await service.linkNewReview(stub as never, { intakeId: 'intake-1', newReviewId: 'r1' });

      expect(stub.rightsReview.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { previousReviewId: null, chainRootReviewId: 'r1', revisionNumber: 1 },
      });
    });

    it('links the second review to the first and increments the revision number', async () => {
      stub.rightsReview.findFirst.mockResolvedValue({
        id: 'r1',
        chainRootReviewId: 'r1',
        revisionNumber: 1,
      });

      await service.linkNewReview(stub as never, { intakeId: 'intake-1', newReviewId: 'r2' });

      expect(stub.rightsReview.update).toHaveBeenCalledWith({
        where: { id: 'r2' },
        data: { previousReviewId: 'r1', chainRootReviewId: 'r1', revisionNumber: 2 },
      });
    });
  });
});
