import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LAWYER_APPROVAL_ERROR_CODES,
  LAWYER_ENV,
  riskLevelRank,
} from '../rights-lawyer/rights-lawyer.constants';
import { RightsRiskLevel } from '../rights-lawyer/rights-lawyer-interface';
import {
  computeRiskAssessment,
  parseBooleanFlag,
  parseRiskLevel,
  type RiskAssessmentInput,
} from '../rights-lawyer/rights-risk.util';
import { APPROVABLE_INTAKE_STATUSES } from './rights-intake.constants';
import { RightsProfileService } from './rights-profile.service';
import { ApproveRightsReviewDto } from './dto/approve-rights-review.dto';
import { RejectRightsReviewDto } from './dto/reject-rights-review.dto';
import { RightsReviewApprovalDto } from './dto/rights-review-approval.dto';

/** Dynamic delegates return `unknown` columns; this keeps the risk input strictly typed. */
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Statuses of a rights review an editor may approve. */
const APPROVABLE_REVIEW_STATUSES = ['HUMAN_REVIEW_REQUIRED', 'LAWYER_APPROVED'];

/**
 * Statuses an editor may reject from. `LAWYER_REVIEW_REQUIRED` is included so a clearance the
 * lawyer refused can be rejected without reopening the legal review first.
 */
const REJECTABLE_REVIEW_STATUSES = [
  'HUMAN_REVIEW_REQUIRED',
  'LAWYER_REVIEW_REQUIRED',
  'LAWYER_APPROVED',
];

@Injectable()
export class RightsApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rp: RightsProfileService,
    private readonly config: ConfigService,
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

  /** Phase 19 reads a few more models; same dynamic-delegate pattern as the getters above. */
  private manyOf(model: string) {
    return (this.prisma as unknown as Record<string, unknown>)[model] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  }

  private oneOf(model: string) {
    return (this.prisma as unknown as Record<string, unknown>)[model] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  /**
   * Blocks approval of a high-risk clearance that has no valid lawyer opinion.
   *
   * Deliberately does NOT call the lawyer module: `RightsIntakeModule` must never depend on
   * `RightsLawyerModule` (ADR-003). Instead it trusts the denormalised snapshot when a lawyer
   * has already approved, and otherwise recomputes the risk from raw rows with the pure helper —
   * so a profile whose risk was never assessed cannot slip through.
   */
  private async assertLawyerApprovalNotRequired(profile: Record<string, unknown>): Promise<void> {
    const workflowEnabled = parseBooleanFlag(this.config.get(LAWYER_ENV.WORKFLOW_ENABLED), true);
    const blockOnHighRisk = parseBooleanFlag(
      this.config.get(LAWYER_ENV.BLOCK_APPROVAL_ON_HIGH_RISK),
      true,
    );
    if (!workflowEnabled || !blockOnHighRisk) return;

    const now = Date.now();
    const lawyerApprovedAt = profile['lawyerApprovedAt'] as Date | string | null | undefined;
    const validUntilRaw = profile['lawyerOpinionValidUntil'] as Date | string | null | undefined;
    const validUntil = validUntilRaw ? new Date(validUntilRaw).getTime() : null;
    const stillBlocking = profile['lawyerReviewBlocking'] === true;

    if (lawyerApprovedAt && !stillBlocking && (validUntil === null || validUntil > now)) {
      return;
    }

    const minRiskLevel = parseRiskLevel(
      this.config.get(LAWYER_ENV.MIN_RISK_LEVEL),
      RightsRiskLevel.HIGH,
    );
    const assessment = computeRiskAssessment(await this.loadRiskInput(profile));

    if (riskLevelRank(assessment.riskLevel) < riskLevelRank(minRiskLevel)) {
      return;
    }

    throw new HttpException(
      {
        statusCode: 409,
        code: LAWYER_APPROVAL_ERROR_CODES.LAWYER_APPROVAL_REQUIRED,
        message: 'A lawyer approval is required before this clearance can be approved.',
        messageRu:
          'Утверждение невозможно: для этого профиля требуется положительное заключение юриста.',
        details: {
          riskLevel: assessment.riskLevel,
          factorCodes: assessment.factors.map((factor) => factor.code),
          currentLawyerReviewId: (profile['currentLawyerReviewId'] as string | null) ?? null,
        },
      },
      409,
    );
  }

  private async loadRiskInput(profile: Record<string, unknown>): Promise<RiskAssessmentInput> {
    const profileId = profile['id'] as string;

    const [sourceEdition, components, territoryDecisions, actions, contributors, claims] =
      await Promise.all([
        this.oneOf('sourceEdition').findUnique({ where: { rightsProfileId: profileId } }),
        this.manyOf('rightsComponent').findMany({ where: { rightsProfileId: profileId } }),
        this.manyOf('territoryDecision').findMany({ where: { rightsProfileId: profileId } }),
        this.manyOf('rightsAction').findMany({ where: { rightsProfileId: profileId } }),
        this.manyOf('rightsProfileContributor').findMany({
          where: { rightsProfileId: profileId },
          include: { person: true },
        }),
        this.manyOf('rightsClaim').findMany({ where: { rightsProfileId: profileId } }),
      ]);

    return {
      profile: {
        overallStatus: asString(profile['overallStatus']),
        publicationGate: asString(profile['publicationGate']),
        confidence: asString(profile['confidence']),
        status: asString(profile['status']),
      },
      sourceTextType: (sourceEdition?.['sourceTextType'] as string | null) ?? null,
      components: components.map((component) => ({
        id: component['id'] as string,
        componentType: asString(component['componentType']),
        status: asString(component['status']),
        requiredAction: asString(component['requiredAction']),
        confidence: (component['confidence'] as string | null) ?? null,
        titleRu: asString(component['titleRu']),
      })),
      territoryDecisions: territoryDecisions.map((decision) => ({
        countryCode: asString(decision['countryCode']),
        finalStatus: asString(decision['finalStatus']),
      })),
      actions: actions.map((action) => ({
        actionType: asString(action['actionType']),
        status: asString(action['status']),
        isBlocking: action['isBlocking'] === true,
      })),
      contributors: contributors.map((contributor) => {
        const person = contributor['person'] as Record<string, unknown> | null;
        return {
          role: asString(contributor['role']),
          fullName: asString(person?.['fullName']),
          deathYear: (person?.['deathYear'] as number | null) ?? null,
        };
      }),
      claims: claims.map((claim) => ({
        id: claim['id'] as string,
        status: asString(claim['status']),
        severity: asString(claim['severity']),
        requiresLawyerReview: claim['requiresLawyerReview'] === true,
      })),
    };
  }

  async approveReview(
    userId: string,
    intakeId: string,
    reviewId: string,
    dto: ApproveRightsReviewDto,
  ) {
    const review = await this.rr.findUnique({
      where: { id: reviewId },
      include: { rightsProfile: true },
    });

    if (!review) {
      throw new NotFoundException(`RightsReview with ID '${reviewId}' not found`);
    }

    const profile = review['rightsProfile'] as Record<string, unknown>;
    const profileId = profile['id'] as string;
    const profileIntakeId = profile['rightsIntakeId'] as string;

    if (profileIntakeId !== intakeId) {
      throw new BadRequestException(`Review '${reviewId}' does not belong to intake '${intakeId}'`);
    }

    if (!profile['isCurrent']) {
      throw new BadRequestException('Cannot approve: profile is not current');
    }

    if (!APPROVABLE_REVIEW_STATUSES.includes(review['status'] as string)) {
      throw new BadRequestException(
        `Cannot approve: review status is '${String(review['status'])}', expected one of ${APPROVABLE_REVIEW_STATUSES.join(', ')}`,
      );
    }

    const intake = await this.ri.findUnique({
      where: { id: intakeId },
    });

    if (!intake) {
      throw new NotFoundException(`RightsIntake with ID '${intakeId}' not found`);
    }

    const intakeStatus = intake['workflowStatus'] as string;
    // WP-10.3 (R3-06): белый список фазы 5 — см. `APPROVABLE_INTAKE_STATUSES`.
    if (!APPROVABLE_INTAKE_STATUSES.includes(intakeStatus)) {
      throw new BadRequestException(
        `Cannot approve: intake status is '${intakeStatus}', expected one of ${APPROVABLE_INTAKE_STATUSES.join(', ')}`,
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

    // Phase 19: high-risk clearance cannot be approved without a lawyer.
    // The lawyer module is NOT imported (that would be a module cycle) — the check
    // reads the denormalised snapshot on RightsProfile and recomputes the risk with
    // the pure `computeRiskAssessment` helper so a never-assessed profile cannot slip through.
    await this.assertLawyerApprovalNotRequired(profile);

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

  async rejectReview(
    userId: string,
    intakeId: string,
    reviewId: string,
    dto: RejectRightsReviewDto,
  ) {
    const review = await this.rr.findUnique({
      where: { id: reviewId },
      include: { rightsProfile: true },
    });

    if (!review) {
      throw new NotFoundException(`RightsReview with ID '${reviewId}' not found`);
    }

    const profile = review['rightsProfile'] as Record<string, unknown>;
    const profileId = profile['id'] as string;
    const profileIntakeId = profile['rightsIntakeId'] as string;

    if (profileIntakeId !== intakeId) {
      throw new BadRequestException(`Review '${reviewId}' does not belong to intake '${intakeId}'`);
    }

    if (!profile['isCurrent']) {
      throw new BadRequestException('Cannot reject: profile is not current');
    }

    if (!REJECTABLE_REVIEW_STATUSES.includes(review['status'] as string)) {
      throw new BadRequestException(
        `Cannot reject: review status is '${String(review['status'])}', expected one of ${REJECTABLE_REVIEW_STATUSES.join(', ')}`,
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
