import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsProfileService } from './rights-profile.service';
import { ApproveRightsReviewDto } from './dto/approve-rights-review.dto';
import { RejectRightsReviewDto } from './dto/reject-rights-review.dto';
import { RightsReviewApprovalDto } from './dto/rights-review-approval.dto';

@Injectable()
export class RightsApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rp: RightsProfileService,
  ) {}

  private get rr() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsReview'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  private get ra() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsReviewApproval'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  }

  private get ri() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsIntake'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  private get raModel() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsAction'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  }

  async approveReview(userId: string, reviewId: string, dto: ApproveRightsReviewDto) {
    const review = await this.rr.findUnique({
      where: { id: reviewId },
      include: { rightsProfile: true },
    });

    if (!review) {
      throw new NotFoundException(`RightsReview with ID '${reviewId}' not found`);
    }

    const profile = review['rightsProfile'] as Record<string, unknown>;
    const profileId = profile['id'] as string;
    const intakeId = profile['rightsIntakeId'] as string;

    if (!profile['isCurrent']) {
      throw new BadRequestException('Cannot approve: profile is not current');
    }

    if (review['status'] !== 'HUMAN_REVIEW_REQUIRED') {
      throw new BadRequestException(
        `Cannot approve: review status is '${String(review['status'])}', expected 'HUMAN_REVIEW_REQUIRED'`,
      );
    }

    const intake = await this.ri.findUnique({
      where: { id: intakeId },
    });

    if (!intake) {
      throw new NotFoundException(`RightsIntake with ID '${intakeId}' not found`);
    }

    const intakeStatus = intake['workflowStatus'] as string;
    if (intakeStatus !== 'HUMAN_REVIEW_REQUIRED' && intakeStatus !== 'REVIEW_IMPORTED') {
      throw new BadRequestException(
        `Cannot approve: intake status is '${intakeStatus}', expected 'HUMAN_REVIEW_REQUIRED' or 'REVIEW_IMPORTED'`,
      );
    }

    if (profile['publicationGate'] === 'BLOCK') {
      throw new BadRequestException('Cannot approve rights review with BLOCK publication gate');
    }

    const blockingActions = await this.raModel.findMany({
      where: {
        rightsProfileId: profileId,
        isBlocking: true,
      },
    });

    const unresolvedBlocking = blockingActions.filter((a) => {
      const status = a['status'] as string;
      return status !== 'COMPLETED' && status !== 'WAIVED';
    });

    if (unresolvedBlocking.length > 0) {
      throw new BadRequestException(
        'Cannot approve rights review with unresolved blocking rights actions',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const t = tx as unknown as Record<string, unknown>;
      const raTx = t['rightsReviewApproval'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const rrTx = t['rightsReview'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const rpTx = t['rightsProfile'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const riTx = t['rightsIntake'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      await raTx.create({
        data: {
          rightsReviewId: reviewId,
          rightsProfileId: profileId,
          rightsIntakeId: intakeId,
          decision: 'APPROVED',
          decidedByUserId: userId,
          notesRu: dto.notesRu ?? null,
        },
      });

      await rrTx.update({
        where: { id: reviewId },
        data: {
          status: 'HUMAN_APPROVED',
          approvedByUserId: userId,
          approvedAt: new Date(),
          approvalNotesRu: dto.notesRu ?? null,
          rejectedByUserId: null,
          rejectedAt: null,
          rejectionReasonRu: null,
        },
      });

      await rpTx.update({
        where: { id: profileId },
        data: {
          status: 'APPROVED',
        },
      });

      await riTx.update({
        where: { id: intakeId },
        data: {
          workflowStatus: 'APPROVED',
          approvedReviewId: reviewId,
        },
      });
    });

    return this.rp.getById(profileId);
  }

  async rejectReview(userId: string, reviewId: string, dto: RejectRightsReviewDto) {
    const review = await this.rr.findUnique({
      where: { id: reviewId },
      include: { rightsProfile: true },
    });

    if (!review) {
      throw new NotFoundException(`RightsReview with ID '${reviewId}' not found`);
    }

    const profile = review['rightsProfile'] as Record<string, unknown>;
    const profileId = profile['id'] as string;
    const intakeId = profile['rightsIntakeId'] as string;

    if (!profile['isCurrent']) {
      throw new BadRequestException('Cannot reject: profile is not current');
    }

    if (review['status'] !== 'HUMAN_REVIEW_REQUIRED') {
      throw new BadRequestException(
        `Cannot reject: review status is '${String(review['status'])}', expected 'HUMAN_REVIEW_REQUIRED'`,
      );
    }

    const intake = await this.ri.findUnique({
      where: { id: intakeId },
    });

    if (!intake) {
      throw new NotFoundException(`RightsIntake with ID '${intakeId}' not found`);
    }

    const intakeStatus = intake['workflowStatus'] as string;
    if (
      intakeStatus === 'APPROVED' ||
      intakeStatus === 'BOOK_CREATED' ||
      intakeStatus === 'ARCHIVED'
    ) {
      throw new BadRequestException(
        `Cannot reject: intake status is '${intakeStatus}', cannot reject approved/book_created/archived intake`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const t = tx as unknown as Record<string, unknown>;
      const raTx = t['rightsReviewApproval'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const rrTx = t['rightsReview'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const rpTx = t['rightsProfile'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const riTx = t['rightsIntake'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      await raTx.create({
        data: {
          rightsReviewId: reviewId,
          rightsProfileId: profileId,
          rightsIntakeId: intakeId,
          decision: 'REJECTED',
          decidedByUserId: userId,
          notesRu: dto.reasonRu,
        },
      });

      await rrTx.update({
        where: { id: reviewId },
        data: {
          status: 'HUMAN_REJECTED',
          rejectedByUserId: userId,
          rejectedAt: new Date(),
          rejectionReasonRu: dto.reasonRu,
          approvedByUserId: null,
          approvedAt: null,
          approvalNotesRu: null,
        },
      });

      await rpTx.update({
        where: { id: profileId },
        data: {
          status: 'REJECTED',
        },
      });

      await riTx.update({
        where: { id: intakeId },
        data: {
          workflowStatus: 'REJECTED',
          approvedReviewId: null,
        },
      });
    });

    return this.rp.getById(profileId);
  }

  async getApprovalsByIntake(intakeId: string): Promise<RightsReviewApprovalDto[]> {
    const approvals = await this.ra.findMany({
      where: { rightsIntakeId: intakeId },
      include: {
        decidedByUser: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return approvals.map((a) => this.mapApproval(a));
  }

  async getApprovalsByReview(reviewId: string): Promise<RightsReviewApprovalDto[]> {
    const approvals = await this.ra.findMany({
      where: { rightsReviewId: reviewId },
      include: {
        decidedByUser: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return approvals.map((a) => this.mapApproval(a));
  }

  private mapApproval(record: Record<string, unknown>): RightsReviewApprovalDto {
    const decidedByUserRaw = record['decidedByUser'] as Record<string, unknown> | null;
    return {
      id: record['id'] as string,
      rightsReviewId: record['rightsReviewId'] as string,
      rightsProfileId: record['rightsProfileId'] as string,
      rightsIntakeId: record['rightsIntakeId'] as string,
      decision: record['decision'] as string,
      decidedByUser: decidedByUserRaw
        ? {
            id: decidedByUserRaw['id'] as string,
            name: decidedByUserRaw['name'] as string | undefined,
            email: decidedByUserRaw['email'] as string,
          }
        : null,
      notesRu: (record['notesRu'] as string | null) ?? null,
      createdAt: new Date(record['createdAt'] as string).toISOString(),
    };
  }
}
