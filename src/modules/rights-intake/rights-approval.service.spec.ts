import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RightsApprovalService } from './rights-approval.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsProfileService } from './rights-profile.service';

const createPrismaStub = () => {
  const stub: Record<string, unknown> = {
    rightsReview: { findUnique: jest.fn() },
    rightsReviewApproval: { findMany: jest.fn() },
    rightsIntake: { findUnique: jest.fn() },
    rightsAction: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  return stub;
};

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

  beforeEach(() => {
    prisma = createPrismaStub();
    rp = createRpStub();
    service = new RightsApprovalService(
      prisma as unknown as PrismaService,
      rp as unknown as RightsProfileService,
    );
  });

  describe('approveReview', () => {
    it('should throw NotFoundException if review not found', async () => {
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.approveReview('user-1', 'nonexistent', { notesRu: 'test' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if profile is not current', async () => {
      const review = makeReview({
        rightsProfile: { id: 'profile-1', rightsIntakeId: 'intake-1', isCurrent: false },
      });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.approveReview('user-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if review status is not HUMAN_REVIEW_REQUIRED', async () => {
      const review = makeReview({ status: 'HUMAN_APPROVED' });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.approveReview('user-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if review status is HUMAN_REJECTED', async () => {
      const review = makeReview({ status: 'HUMAN_REJECTED' });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.approveReview('user-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if intake not found', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.approveReview('user-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if intake status is not HUMAN_REVIEW_REQUIRED or REVIEW_IMPORTED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'DRAFT' }),
      );

      await expect(
        service.approveReview('user-1', 'review-1', { notesRu: 'test' }),
      ).rejects.toThrow(BadRequestException);
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
        service.approveReview('user-1', 'review-1', { notesRu: 'test' }),
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
        service.approveReview('user-1', 'review-1', { notesRu: 'test' }),
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

      const result = await service.approveReview('user-1', 'review-1', { notesRu: 'test' });

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

      const result = await service.approveReview('user-1', 'review-1', { notesRu: 'test' });

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

      await service.approveReview('user-1', 'review-1', { notesRu: 'approved notes' });

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

      await service.approveReview('user-1', 'review-1', { notesRu: 'test' });

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

      await service.approveReview('user-1', 'review-1', { notesRu: 'test' });

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

      await service.approveReview('user-1', 'review-1', { notesRu: 'test' });

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

      await service.approveReview('user-1', 'review-1', {});

      expect(txStub.rightsReviewApproval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notesRu: null }),
      });
    });
  });

  describe('rejectReview', () => {
    it('should throw NotFoundException if review not found', async () => {
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.rejectReview('user-1', 'nonexistent', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if profile is not current', async () => {
      const review = makeReview({
        rightsProfile: { id: 'profile-1', rightsIntakeId: 'intake-1', isCurrent: false },
      });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.rejectReview('user-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if review status is not HUMAN_REVIEW_REQUIRED', async () => {
      const review = makeReview({ status: 'HUMAN_APPROVED' });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.rejectReview('user-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if review status is DRAFT', async () => {
      const review = makeReview({ status: 'DRAFT' });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);

      await expect(
        service.rejectReview('user-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if intake not found', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.rejectReview('user-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if intake status is APPROVED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'APPROVED' }),
      );

      await expect(
        service.rejectReview('user-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if intake status is BOOK_CREATED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'BOOK_CREATED' }),
      );

      await expect(
        service.rejectReview('user-1', 'review-1', { reasonRu: 'test reason here' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if intake status is ARCHIVED', async () => {
      const review = makeReview();
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(review);
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'ARCHIVED' }),
      );

      await expect(
        service.rejectReview('user-1', 'review-1', { reasonRu: 'test reason here' }),
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

      await service.rejectReview('user-1', 'review-1', { reasonRu: 'reject reason' });

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

      await service.rejectReview('user-1', 'review-1', { reasonRu: 'reject reason' });

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

      await service.rejectReview('user-1', 'review-1', { reasonRu: 'reject reason' });

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

      await service.rejectReview('user-1', 'review-1', { reasonRu: 'reject reason' });

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
});
