import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RightsApprovalService } from './rights-approval.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsProfileService } from './rights-profile.service';

const createPrismaStub = () => {
  const stub: Record<string, unknown> = {
    rightsReview: { findUnique: jest.fn() },
    rightsReviewApproval: { findMany: jest.fn() },
    rightsIntake: { findUnique: jest.fn() },
    rightsAction: { findMany: jest.fn() },
    // Phase 19: models the risk recomputation reads before approving.
    sourceEdition: { findUnique: jest.fn().mockResolvedValue(null) },
    rightsComponent: { findMany: jest.fn().mockResolvedValue([]) },
    territoryDecision: { findMany: jest.fn().mockResolvedValue([]) },
    rightsProfileContributor: { findMany: jest.fn().mockResolvedValue([]) },
    rightsClaim: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  return stub;
};

/** Phase 19 env: everything defaults to "enabled, threshold HIGH". */
const createConfigStub = (values: Record<string, string> = {}) => ({
  get: jest.fn((key: string) => values[key]),
});

const createRpStub = () => ({
  getById: jest.fn(),
});

const makeReview = (overrides: Record<string, unknown> = {}) => ({
  id: 'review-1',
  rightsProfileId: 'profile-1',
  rightsReviewImportId: 'import-1',
  status: 'HUMAN_REVIEW_REQUIRED',
  schemaVersion: '1.0.0',
  reviewerType: 'EXTERNAL_CHATGPT_AGENT',
  overallStatus: 'PUBLISHABLE',
  publicationGate: 'ALLOW',
  confidence: 'HIGH',
  summaryRu: 'summary',
  conclusionRu: 'conclusion',
  reasoningRu: null,
  nextReviewAt: null,
  approvedByUserId: null,
  approvedAt: null,
  approvalNotesRu: null,
  rejectedByUserId: null,
  rejectedAt: null,
  rejectionReasonRu: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  rightsProfile: {
    id: 'profile-1',
    rightsIntakeId: 'intake-1',
    status: 'IMPORTED',
    isCurrent: true,
    publicationGate: 'ALLOW',
  },
  ...overrides,
});

const makeIntake = (overrides: Record<string, unknown> = {}) => ({
  id: 'intake-1',
  workflowStatus: 'HUMAN_REVIEW_REQUIRED',
  approvedReviewId: null,
  ...overrides,
});

const makeApproval = (overrides: Record<string, unknown> = {}) => ({
  id: 'approval-1',
  rightsReviewId: 'review-1',
  rightsProfileId: 'profile-1',
  rightsIntakeId: 'intake-1',
  decision: 'APPROVED',
  decidedByUser: { id: 'user-1', name: 'Admin', email: 'admin@test.com' },
  notesRu: 'looks good',
  createdAt: new Date('2026-07-24T12:00:00.000Z'),
  ...overrides,
});

const createTxStub = () => ({
  rightsReviewApproval: { create: jest.fn().mockResolvedValue({}) },
  rightsReview: { update: jest.fn().mockResolvedValue({}) },
  rightsProfile: { update: jest.fn().mockResolvedValue({}) },
  rightsIntake: { update: jest.fn().mockResolvedValue({}) },
});

describe('RightsApprovalService', () => {
  let service: RightsApprovalService;
  let prisma: Record<string, unknown>;
  let rp: ReturnType<typeof createRpStub>;
  let config: ReturnType<typeof createConfigStub>;

  beforeEach(() => {
    prisma = createPrismaStub();
    rp = createRpStub();
    config = createConfigStub();
    service = new RightsApprovalService(
      prisma as unknown as PrismaService,
      rp as unknown as RightsProfileService,
      config as unknown as ConfigService,
    );
  });

  describe('approveReview', () => {
    it('should throw NotFoundException if review not found', async () => {
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.approveReview('user-1', 'intake-1', 'nonexistent', { notesRu: 'test' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if review does not belong to intake', async () => {
      const review = makeReview({
        rightsProfile: { id: 'profile-1', rightsIntakeId: 'intake-B', isCurrent: true },
      });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.approveReview('user-1', 'intake-A', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if profile is not current', async () => {
      const review = makeReview({
        rightsProfile: { id: 'profile-1', rightsIntakeId: 'intake-1', isCurrent: false },
      });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if review status is not HUMAN_REVIEW_REQUIRED', async () => {
      const review = makeReview({ status: 'HUMAN_APPROVED' });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if review status is HUMAN_REJECTED', async () => {
      const review = makeReview({ status: 'HUMAN_REJECTED' });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if intake not found', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if intake status is not HUMAN_REVIEW_REQUIRED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'DRAFT' }),
      );

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
    });

    /**
     * WP-10.3 (R3-06): `REVIEW_IMPORTED` на момент утверждения достижим ровно в одном
     * сценарии — поверх материализованного профиля загружен более свежий отчёт, который ещё
     * не материализован. Утверждать в этот момент старую проверку нельзя: `approvedReviewId`
     * укажет на заведомо устаревший вердикт, и из него будет создана книга.
     */
    it('refuses to approve while a newer, not yet materialized report is pending (REVIEW_IMPORTED)', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'REVIEW_IMPORTED' }),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'APPROVED' });

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma['$transaction']).not.toHaveBeenCalled();
      expect(txStub.rightsReviewApproval.create).not.toHaveBeenCalled();
      expect(txStub.rightsIntake.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if publicationGate is BLOCK', async () => {
      const review = makeReview({
        rightsProfile: {
          id: 'profile-1',
          rightsIntakeId: 'intake-1',
          isCurrent: true,
          publicationGate: 'BLOCK',
        },
      });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if there are unresolved blocking actions', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { id: 'action-1', isBlocking: true, status: 'PENDING' },
      ]);

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow approval if blocking action is COMPLETED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { id: 'action-1', isBlocking: true, status: 'COMPLETED' },
      ]);

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'APPROVED' });

      const result = await service.approveReview('user-1', 'intake-1', 'review-1', {
        notesRu: 'test',
      });

      expect(result).toBeDefined();
      expect(txStub.rightsReviewApproval.create).toHaveBeenCalled();
    });

    it('should allow approval if blocking action is WAIVED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { id: 'action-1', isBlocking: true, status: 'WAIVED' },
      ]);

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'APPROVED' });

      const result = await service.approveReview('user-1', 'intake-1', 'review-1', {
        notesRu: 'test',
      });

      expect(result).toBeDefined();
      expect(txStub.rightsReviewApproval.create).toHaveBeenCalled();
    });

    it('should create RightsReviewApproval with APPROVED decision', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'APPROVED' });

      await service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'approved notes' });

      expect(txStub.rightsReviewApproval.create).toHaveBeenCalledWith({
        data: {
          rightsReviewId: 'review-1',
          rightsProfileId: 'profile-1',
          rightsIntakeId: 'intake-1',
          decision: 'APPROVED',
          decidedByUserId: 'user-1',
          notesRu: 'approved notes',
        },
      });
    });

    it('should update RightsReview status to HUMAN_APPROVED and clear rejection fields', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'APPROVED' });

      await service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' });

      expect(txStub.rightsReview.update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: expect.objectContaining({
          status: 'HUMAN_APPROVED',
          approvedByUserId: 'user-1',
          approvalNotesRu: 'test',
          rejectedByUserId: null,
          rejectedAt: null,
          rejectionReasonRu: null,
        }),
      });
    });

    it('should update RightsProfile status to APPROVED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'APPROVED' });

      await service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' });

      expect(txStub.rightsProfile.update).toHaveBeenCalledWith({
        where: { id: 'profile-1' },
        data: { status: 'APPROVED' },
      });
    });

    it('should update RightsIntake workflowStatus to APPROVED and set approvedReviewId', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'APPROVED' });

      await service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' });

      expect(txStub.rightsIntake.update).toHaveBeenCalledWith({
        where: { id: 'intake-1' },
        data: {
          workflowStatus: 'APPROVED',
          approvedReviewId: 'review-1',
        },
      });
    });

    it('should handle null notesRu', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'APPROVED' });

      await service.approveReview('user-1', 'intake-1', 'review-1', {});

      expect(txStub.rightsReviewApproval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notesRu: null }),
      });
    });
  });

  describe('rejectReview', () => {
    it('should throw NotFoundException if review not found', async () => {
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.rejectReview('user-1', 'intake-1', 'nonexistent', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if review does not belong to intake', async () => {
      const review = makeReview({
        rightsProfile: { id: 'profile-1', rightsIntakeId: 'intake-B', isCurrent: true },
      });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.rejectReview('user-1', 'intake-A', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if profile is not current', async () => {
      const review = makeReview({
        rightsProfile: { id: 'profile-1', rightsIntakeId: 'intake-1', isCurrent: false },
      });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if review status is not HUMAN_REVIEW_REQUIRED', async () => {
      const review = makeReview({ status: 'HUMAN_APPROVED' });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if review status is DRAFT', async () => {
      const review = makeReview({ status: 'DRAFT' });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if intake not found', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if intake status is APPROVED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'APPROVED' }),
      );

      await expect(
        service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if intake status is BOOK_CREATED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'BOOK_CREATED' }),
      );

      await expect(
        service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if intake status is ARCHIVED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'ARCHIVED' }),
      );

      await expect(
        service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create RightsReviewApproval with REJECTED decision', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'REJECTED' });

      await service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'reject reason' });

      expect(txStub.rightsReviewApproval.create).toHaveBeenCalledWith({
        data: {
          rightsReviewId: 'review-1',
          rightsProfileId: 'profile-1',
          rightsIntakeId: 'intake-1',
          decision: 'REJECTED',
          decidedByUserId: 'user-1',
          notesRu: 'reject reason',
        },
      });
    });

    it('should update RightsReview status to HUMAN_REJECTED and clear approval fields', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'REJECTED' });

      await service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'reject reason' });

      expect(txStub.rightsReview.update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: expect.objectContaining({
          status: 'HUMAN_REJECTED',
          rejectedByUserId: 'user-1',
          rejectionReasonRu: 'reject reason',
          approvedByUserId: null,
          approvedAt: null,
          approvalNotesRu: null,
        }),
      });
    });

    it('should update RightsProfile status to REJECTED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'REJECTED' });

      await service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'reject reason' });

      expect(txStub.rightsProfile.update).toHaveBeenCalledWith({
        where: { id: 'profile-1' },
        data: { status: 'REJECTED' },
      });
    });

    it('should update RightsIntake workflowStatus to REJECTED and clear approvedReviewId', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );

      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'REJECTED' });

      await service.rejectReview('user-1', 'intake-1', 'review-1', { reasonRu: 'reject reason' });

      expect(txStub.rightsIntake.update).toHaveBeenCalledWith({
        where: { id: 'intake-1' },
        data: {
          workflowStatus: 'REJECTED',
          approvedReviewId: null,
        },
      });
    });
  });

  describe('getApprovalsByIntake', () => {
    it('should return approvals for intake', async () => {
      const approvals = [
        makeApproval({ id: 'approval-1', decision: 'APPROVED' }),
        makeApproval({ id: 'approval-2', decision: 'REJECTED', notesRu: 'rejected' }),
      ];
      (prisma['rightsReviewApproval'] as Record<string, jest.Mock>).findMany.mockResolvedValue(
        approvals,
      );

      const result = await service.getApprovalsByIntake('intake-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('approval-1');
      expect(result[0].decision).toBe('APPROVED');
      expect(result[1].id).toBe('approval-2');
      expect(result[1].decision).toBe('REJECTED');
    });

    it('should return empty array if no approvals', async () => {
      (prisma['rightsReviewApproval'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const result = await service.getApprovalsByIntake('intake-1');

      expect(result).toEqual([]);
    });

    it('should handle null decidedByUser', async () => {
      const approvals = [makeApproval({ decidedByUser: null })];
      (prisma['rightsReviewApproval'] as Record<string, jest.Mock>).findMany.mockResolvedValue(
        approvals,
      );

      const result = await service.getApprovalsByIntake('intake-1');

      expect(result[0].decidedByUser).toBeNull();
    });
  });

  describe('getApprovalsByReview', () => {
    it('should return approvals for review', async () => {
      const approvals = [makeApproval()];
      (prisma['rightsReviewApproval'] as Record<string, jest.Mock>).findMany.mockResolvedValue(
        approvals,
      );

      const result = await service.getApprovalsByReview('review-1');

      expect(result).toHaveLength(1);
      expect(result[0].rightsReviewId).toBe('review-1');
    });

    it('should return empty array if no approvals', async () => {
      (prisma['rightsReviewApproval'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const result = await service.getApprovalsByReview('review-1');

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 19: high-risk clearance may not be approved without a lawyer
  // -------------------------------------------------------------------------
  describe('lawyer approval gate (Phase 19)', () => {
    /**
     * A genuinely high-risk profile: LOW confidence over a target country that still needs a
     * licence. Since WP-E.2 a cautious `confidence` alone is only MEDIUM.
     */
    const highRiskProfile = (overrides: Record<string, unknown> = {}) => ({
      id: 'profile-1',
      rightsIntakeId: 'intake-1',
      isCurrent: true,
      publicationGate: 'ALLOW',
      overallStatus: 'PUBLISHABLE',
      confidence: 'LOW',
      status: 'HUMAN_REVIEW_REQUIRED',
      lawyerReviewBlocking: false,
      lawyerApprovedAt: null,
      lawyerOpinionValidUntil: null,
      currentLawyerReviewId: null,
      ...overrides,
    });

    const arrange = (profile: Record<string, unknown>, reviewStatus = 'HUMAN_REVIEW_REQUIRED') => {
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview({ status: reviewStatus, rightsProfile: profile }),
      );
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'US', finalStatus: 'LICENSE_REQUIRED' },
      ]);
      const txStub = createTxStub();
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'APPROVED' });
      return txStub;
    };

    // -----------------------------------------------------------------------
    // WP-E: риск не наказывает за материалы, которых ещё нет (кейс По)
    // -----------------------------------------------------------------------
    const pdComponent = (overrides: Record<string, unknown> = {}) => ({
      id: 'component-1',
      componentType: 'ORIGINAL_TEXT',
      status: 'PUBLIC_DOMAIN',
      requiredAction: 'NONE',
      confidence: 'HIGH',
      titleRu: 'Оригинальный текст',
      territoryAssessments: [{ countryCode: 'US' }],
      ...overrides,
    });

    /** Чистая PD-книга: все целевые страны разрешены, отчёт осторожен (confidence LOW). */
    const arrangePublicDomain = (components: Array<Record<string, unknown>>) => {
      const txStub = arrange(highRiskProfile());
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ targetCountryCodes: ['US', 'GB', 'FR'] }),
      );
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'US', finalStatus: 'ALLOWED' },
        { countryCode: 'GB', finalStatus: 'ALLOWED' },
        { countryCode: 'FR', finalStatus: 'ALLOWED' },
        { countryCode: 'DE', finalStatus: 'PENDING_REVIEW' },
      ]);
      (prisma['rightsComponent'] as Record<string, jest.Mock>).findMany.mockResolvedValue(
        components,
      );
      return txStub;
    };

    it('WP-E: approves a public-domain clearance whose only UNCERTAIN component was never assessed', async () => {
      const txStub = arrangePublicDomain([
        pdComponent(),
        pdComponent({
          id: 'component-2',
          componentType: 'COVER',
          status: 'UNCERTAIN',
          requiredAction: 'VERIFY',
          titleRu: 'Обложка',
          territoryAssessments: [],
        }),
      ]);

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).resolves.toBeDefined();
      expect(txStub.rightsReviewApproval.create).toHaveBeenCalled();
    });

    it('WP-E: still requires a lawyer when the agent assessed the UNCERTAIN component by country', async () => {
      arrangePublicDomain([
        pdComponent(),
        pdComponent({
          id: 'component-2',
          componentType: 'COVER',
          status: 'UNCERTAIN',
          requiredAction: 'VERIFY',
          titleRu: 'Обложка',
          territoryAssessments: [{ countryCode: 'US' }],
        }),
      ]);

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toMatchObject({
        response: {
          code: 'LAWYER_APPROVAL_REQUIRED',
          details: expect.objectContaining({
            factorCodes: expect.arrayContaining(['UNCERTAIN_COMPONENT']),
          }),
        },
      });
    });

    it('WP-E: still requires a lawyer when a COPYRIGHTED component is kept', async () => {
      arrangePublicDomain([
        pdComponent(),
        pdComponent({
          id: 'component-2',
          componentType: 'ILLUSTRATIONS',
          status: 'COPYRIGHTED',
          requiredAction: 'KEEP',
          titleRu: 'Иллюстрации',
          territoryAssessments: [],
        }),
      ]);

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toMatchObject({
        response: {
          code: 'LAWYER_APPROVAL_REQUIRED',
          details: expect.objectContaining({
            factorCodes: expect.arrayContaining(['COPYRIGHTED_COMPONENT_KEPT']),
          }),
        },
      });
    });

    it('WP-E: still requires a lawyer when a target country is blocked', async () => {
      arrangePublicDomain([pdComponent()]);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'US', finalStatus: 'ALLOWED' },
        { countryCode: 'GB', finalStatus: 'BLOCKED' },
      ]);

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toMatchObject({
        response: {
          code: 'LAWYER_APPROVAL_REQUIRED',
          details: expect.objectContaining({
            riskLevel: 'HIGH',
            factorCodes: expect.arrayContaining(['CONFIDENCE_LOW']),
          }),
        },
      });
    });

    it('blocks approval of a HIGH-risk profile without a lawyer opinion', async () => {
      arrange(highRiskProfile());

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toMatchObject({
        response: {
          code: 'LAWYER_APPROVAL_REQUIRED',
          statusCode: 409,
          details: expect.objectContaining({
            riskLevel: 'HIGH',
            factorCodes: expect.arrayContaining(['CONFIDENCE_LOW']),
          }),
        },
      });
    });

    it('allows approval once a lawyer opinion is in force', async () => {
      const txStub = arrange(
        highRiskProfile({
          lawyerApprovedAt: new Date('2026-07-20T00:00:00.000Z'),
          lawyerOpinionValidUntil: new Date('2030-01-01T00:00:00.000Z'),
        }),
      );

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).resolves.toBeDefined();
      expect(txStub.rightsReviewApproval.create).toHaveBeenCalled();
    });

    it('accepts an open-ended opinion (validUntil = null)', async () => {
      arrange(
        highRiskProfile({
          lawyerApprovedAt: new Date('2026-07-20T00:00:00.000Z'),
          lawyerOpinionValidUntil: null,
        }),
      );

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).resolves.toBeDefined();
    });

    it('blocks again once the opinion has expired', async () => {
      arrange(
        highRiskProfile({
          lawyerApprovedAt: new Date('2024-01-01T00:00:00.000Z'),
          lawyerOpinionValidUntil: new Date('2025-01-01T00:00:00.000Z'),
        }),
      );

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_APPROVAL_REQUIRED' } });
    });

    it('blocks while another lawyer review still blocks the profile', async () => {
      arrange(
        highRiskProfile({
          lawyerApprovedAt: new Date('2026-07-20T00:00:00.000Z'),
          lawyerOpinionValidUntil: null,
          lawyerReviewBlocking: true,
        }),
      );

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_APPROVAL_REQUIRED' } });
    });

    it('lets approval through when RIGHTS_LAWYER_BLOCK_APPROVAL_ON_HIGH_RISK=0', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'RIGHTS_LAWYER_BLOCK_APPROVAL_ON_HIGH_RISK' ? '0' : '',
      );
      arrange(highRiskProfile());

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).resolves.toBeDefined();
    });

    it('lets approval through when the whole workflow is disabled', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'RIGHTS_LAWYER_WORKFLOW_ENABLED' ? '0' : '',
      );
      arrange(highRiskProfile());

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).resolves.toBeDefined();
    });

    it('lets a MEDIUM-risk profile through at the default HIGH threshold', async () => {
      arrange(highRiskProfile({ confidence: 'MEDIUM' }));
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'US', finalStatus: 'ALLOWED' },
      ]);

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).resolves.toBeDefined();
    });

    it('approves a review whose status is LAWYER_APPROVED', async () => {
      const txStub = arrange(
        highRiskProfile({
          lawyerApprovedAt: new Date('2026-07-20T00:00:00.000Z'),
          lawyerOpinionValidUntil: null,
        }),
        'LAWYER_APPROVED',
      );

      await expect(
        service.approveReview('user-1', 'intake-1', 'review-1', { notesRu: 'test' }),
      ).resolves.toBeDefined();
      expect(txStub.rightsReview.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'HUMAN_APPROVED' }) }),
      );
    });

    it('rejects a review that is still in LAWYER_REVIEW_REQUIRED', async () => {
      const txStub = createTxStub();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview({ status: 'LAWYER_REVIEW_REQUIRED' }),
      );
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'LAWYER_REVIEW_REQUIRED' }),
      );
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      rp.getById.mockResolvedValue({ id: 'profile-1', status: 'REJECTED' });

      await expect(
        service.rejectReview('user-1', 'intake-1', 'review-1', {
          reasonRu: 'юрист отказал в согласовании',
        }),
      ).resolves.toBeDefined();
      expect(txStub.rightsReview.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'HUMAN_REJECTED' }) }),
      );
    });
  });
});
