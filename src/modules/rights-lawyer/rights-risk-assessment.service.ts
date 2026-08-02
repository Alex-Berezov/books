import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LAWYER_ENV,
  LAWYER_ERROR_CODES,
  RISK_LEVEL_ORDER,
  riskLevelRank,
} from './rights-lawyer.constants';
import { lawyerError } from './rights-lawyer.errors';
import {
  RightsRiskLevel,
  toStringArray,
  type LawyerDatabaseClient,
} from './rights-lawyer-interface';
import {
  computeRiskAssessment,
  meetsRiskThreshold,
  parseBooleanFlag,
  parseRiskLevel,
  type RiskAssessmentInput,
  type RiskAssessmentResult,
} from './rights-risk.util';
import type { RiskFactorDto } from './dto/lawyer-review-response.dto';
import type { RiskAssessmentSnapshotDto } from './dto/risk-assessment-response.dto';

/** Resolved Phase 19 risk policy. */
export interface LawyerRiskPolicy {
  workflowEnabled: boolean;
  blockApprovalOnHighRisk: boolean;
  minRiskLevel: RightsRiskLevel;
}

/**
 * Loads everything `computeRiskAssessment` needs and, on demand, writes the denormalised
 * snapshot back onto `RightsProfile`. The snapshot exists so `RightsApprovalService` can
 * enforce the lawyer requirement without importing this module (ADR-003).
 */
@Injectable()
export class RightsRiskAssessmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private getDatabase(): LawyerDatabaseClient {
    return this.prisma as unknown as LawyerDatabaseClient;
  }

  /** Resolved per call so tests can change env between assertions. */
  getRiskPolicy(): LawyerRiskPolicy {
    return {
      workflowEnabled: parseBooleanFlag(this.config.get(LAWYER_ENV.WORKFLOW_ENABLED), true),
      blockApprovalOnHighRisk: parseBooleanFlag(
        this.config.get(LAWYER_ENV.BLOCK_APPROVAL_ON_HIGH_RISK),
        true,
      ),
      minRiskLevel: parseRiskLevel(
        this.config.get(LAWYER_ENV.MIN_RISK_LEVEL),
        RightsRiskLevel.HIGH,
      ),
    };
  }

  /** Collects the risk input of one profile with a single fan-out of queries. */
  async loadInput(profileId: string): Promise<RiskAssessmentInput> {
    const database = this.getDatabase();

    const profile = await database.rightsProfile.findUnique({ where: { id: profileId } });
    if (!profile) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_PROFILE_NOT_FOUND, {
        rightsProfileId: profileId,
      });
    }

    const [sourceEdition, components, territoryDecisions, actions, contributors, claims, intake] =
      await Promise.all([
        database.sourceEdition.findUnique({ where: { rightsProfileId: profileId } }),
        database.rightsComponent.findMany({
          where: { rightsProfileId: profileId },
          // WP-E.1: нужен только факт наличия страновых оценок у компонента.
          include: { territoryAssessments: { select: { countryCode: true } } },
        }),
        database.territoryDecision.findMany({ where: { rightsProfileId: profileId } }),
        database.rightsAction.findMany({ where: { rightsProfileId: profileId } }),
        database.rightsProfileContributor.findMany({
          where: { rightsProfileId: profileId },
          include: { person: true },
        }),
        database.rightsClaim.findMany({ where: { rightsProfileId: profileId } }),
        database.rightsIntake.findUnique({ where: { id: profile.rightsIntakeId } }),
      ]);

    return {
      profile: {
        overallStatus: profile.overallStatus,
        publicationGate: profile.publicationGate,
        confidence: profile.confidence,
        status: profile.status,
      },
      sourceTextType: sourceEdition?.sourceTextType ?? null,
      components: components.map((component) => ({
        id: component.id,
        componentType: component.componentType,
        status: component.status,
        requiredAction: component.requiredAction,
        confidence: component.confidence ?? null,
        titleRu: component.titleRu,
        territoryAssessmentCount: component.territoryAssessments?.length ?? 0,
      })),
      territoryDecisions: territoryDecisions.map((decision) => ({
        countryCode: decision.countryCode,
        finalStatus: decision.finalStatus,
      })),
      targetCountryCodes: toStringArray(intake?.targetCountryCodes),
      actions: actions.map((action) => ({
        actionType: action.actionType,
        status: action.status,
        isBlocking: action.isBlocking,
      })),
      contributors: contributors.map((contributor) => ({
        role: contributor.role,
        fullName: contributor.person?.fullName ?? '',
        deathYear: contributor.person?.deathYear ?? null,
      })),
      claims: claims.map((claim) => ({
        id: claim.id,
        status: claim.status,
        severity: claim.severity,
        requiresLawyerReview: claim.requiresLawyerReview,
      })),
    };
  }

  /** Computes the risk without writing anything. Used by the gate and by every read path. */
  async assess(profileId: string): Promise<RiskAssessmentResult> {
    return computeRiskAssessment(await this.loadInput(profileId));
  }

  /** Whether a risk level requires a lawyer under the current policy. */
  isLawyerRequired(
    level: RightsRiskLevel,
    policy: LawyerRiskPolicy = this.getRiskPolicy(),
  ): boolean {
    return policy.workflowEnabled && meetsRiskThreshold(level, policy.minRiskLevel);
  }

  /** Whether a review opened for this risk level should block approval. */
  blocksApprovalByPolicy(
    level: RightsRiskLevel,
    policy: LawyerRiskPolicy = this.getRiskPolicy(),
  ): boolean {
    return policy.blockApprovalOnHighRisk && this.isLawyerRequired(level, policy);
  }

  /**
   * Computes the risk and stores the snapshot on `RightsProfile`.
   * Idempotent: when neither the level nor the set of factor codes changed, only
   * `riskAssessedAt` moves. Workflow statuses are never touched here.
   */
  async assessAndSync(profileId: string): Promise<RiskAssessmentSnapshotDto> {
    const database = this.getDatabase();
    const profile = await database.rightsProfile.findUnique({ where: { id: profileId } });
    if (!profile) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_PROFILE_NOT_FOUND, {
        rightsProfileId: profileId,
      });
    }

    const result = computeRiskAssessment(await this.loadInput(profileId));
    const policy = this.getRiskPolicy();
    const lawyerReviewRequired = this.isLawyerRequired(result.riskLevel, policy);
    const assessedAt = new Date();

    const unchanged =
      profile.riskLevel === result.riskLevel &&
      profile.lawyerReviewRequired === lawyerReviewRequired &&
      sameFactorCodes(profile.riskFactors, result);

    const updated = await database.rightsProfile.update({
      where: { id: profileId },
      data: unchanged
        ? { riskAssessedAt: assessedAt }
        : {
            riskLevel: result.riskLevel,
            riskFactors: result.factors as unknown as Record<string, unknown>[],
            riskAssessedAt: assessedAt,
            lawyerReviewRequired,
          },
    });

    return {
      rightsProfileId: profileId,
      riskLevel: updated.riskLevel,
      factors: toRiskFactorDtos(result),
      lawyerReviewRequired: updated.lawyerReviewRequired,
      blockApprovalEnabled: policy.blockApprovalOnHighRisk,
      minRiskLevel: policy.minRiskLevel,
      assessedAt: assessedAt.toISOString(),
      // Полный LawyerReviewDto дособерёт RightsLawyerReviewService: собирать его здесь значило
      // бы продублировать маппинг и завести взаимную зависимость двух сервисов.
      currentLawyerReview: null,
      explicitLawyerRequest: result.explicitLawyerRequest,
      suggestedTrigger: result.suggestedTrigger,
      lawyerApproved: isOpinionInForce(
        updated.lawyerApprovedAt,
        updated.lawyerOpinionValidUntil,
        updated.lawyerReviewBlocking,
        assessedAt,
      ),
      lawyerApprovedAt: updated.lawyerApprovedAt?.toISOString() ?? null,
      lawyerApprovedLawyerName: updated.lawyerApprovedLawyerName ?? null,
      lawyerOpinionValidUntil: updated.lawyerOpinionValidUntil?.toISOString() ?? null,
    };
  }

  /** All risk levels in ascending order — handy for admin UI selectors. */
  getRiskLevels(): readonly RightsRiskLevel[] {
    return RISK_LEVEL_ORDER;
  }
}

/** A positive opinion is in force only while it has not expired and nothing blocks again. */
export const isOpinionInForce = (
  lawyerApprovedAt: Date | null,
  validUntil: Date | null,
  blocking: boolean,
  now: Date,
): boolean => {
  if (!lawyerApprovedAt || blocking) return false;
  return !validUntil || validUntil.getTime() > now.getTime();
};

export const toRiskFactorDtos = (result: RiskAssessmentResult): RiskFactorDto[] =>
  result.factors.map((factor) => ({
    code: factor.code,
    level: factor.level,
    messageRu: factor.messageRu,
    details: factor.details ?? null,
  }));

/** Two snapshots are equivalent when they hold the same set of factor codes. */
const sameFactorCodes = (stored: unknown, result: RiskAssessmentResult): boolean => {
  if (!Array.isArray(stored)) return result.factors.length === 0;
  const storedCodes = stored
    .map((item) =>
      item && typeof item === 'object' ? (item as Record<string, unknown>)['code'] : undefined,
    )
    .filter((code): code is string => typeof code === 'string')
    .sort();
  const currentCodes = result.factors.map((factor) => String(factor.code)).sort();
  return (
    storedCodes.length === currentCodes.length &&
    storedCodes.every((code, index) => code === currentCodes[index])
  );
};

/** Ranking helper re-exported so callers do not need to reach into the constants file. */
export const riskRank = riskLevelRank;
