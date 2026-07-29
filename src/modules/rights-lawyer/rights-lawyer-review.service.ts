import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsService } from '../rights-agent/rights-notifications.service';
import {
  RightsNotificationSeverity,
  RightsNotificationType,
  type AgentDatabaseClient,
} from '../rights-agent/rights-agent-interface';
import { RightsLawyerService } from './rights-lawyer.service';
import {
  LAWYER_EMBEDDED_ITEMS_LIMIT,
  LAWYER_ENV,
  LAWYER_ERROR_CODES,
  LAWYER_ESCALATABLE_INTAKE_STATUSES,
  LAWYER_ESCALATABLE_PROFILE_STATUSES,
  LAWYER_GATE_CODES,
  LAWYER_LIST_DEFAULT_LIMIT,
  LAWYER_LIST_MAX_LIMIT,
  LAWYER_MIN_REASON_LENGTH,
  LAWYER_OPINION_EXPIRY_WARN_DAYS_DEFAULT,
  LAWYER_OPINION_VALIDITY_DAYS_DEFAULT,
  LAWYER_REVIEW_ALLOWED_TRANSITIONS,
  LAWYER_REVIEW_DUE_DAYS_DEFAULT,
  LAWYER_REVIEW_NUMBER_MAX_RETRIES,
  LAWYER_REVIEW_NUMBER_PREFIX,
  LAWYER_REVIEW_OPEN_STATUSES,
  LAWYER_REVIEW_POSITIVE_STATUSES,
  LAWYER_REVIEW_REOPENABLE_STATUSES,
  LAWYER_DECISION_TO_STATUS,
  RISK_LEVEL_LABELS_RU,
} from './rights-lawyer.constants';
import { lawyerError } from './rights-lawyer.errors';
import { RightsRiskAssessmentService } from './rights-risk-assessment.service';
import {
  RightsLawyerConditionStatus,
  RightsLawyerDecision,
  RightsLawyerReviewEventType,
  RightsLawyerReviewStatus,
  RightsLawyerReviewTrigger,
  RightsRiskFactorCode,
  RightsRiskLevel,
  toStringArray,
  type LawyerDatabaseClient,
  type LawyerProfileRecord,
  type RightsLawyerReviewConditionRecord,
  type RightsLawyerReviewEventRecord,
  type RightsLawyerReviewRecord,
  type RightsLegalOpinionRecord,
} from './rights-lawyer-interface';
import { addDays, daysUntil, parseBooleanFlag, parsePositiveIntOption } from './rights-risk.util';
import type { AssignLawyerReviewDto } from './dto/assign-lawyer-review.dto';
import type { CreateConditionDto, DecideLawyerReviewDto } from './dto/decide-lawyer-review.dto';
import type {
  LawyerConditionDto,
  LawyerReviewDetailDto,
  LawyerReviewDto,
  LawyerReviewEventDto,
  LawyerReviewListResponseDto,
  LegalOpinionDto,
  RiskFactorDto,
} from './dto/lawyer-review-response.dto';
import type { ListLawyerReviewsDto } from './dto/list-lawyer-reviews.dto';
import type {
  AddLawyerReviewNoteDto,
  SatisfyConditionDto,
  WaiveConditionDto,
  WithdrawLawyerReviewDto,
} from './dto/reason.dto';
import type {
  RequestLawyerReviewDto,
  RequireLawyerReviewDto,
} from './dto/request-lawyer-review.dto';
import type { RiskAssessmentSnapshotDto } from './dto/risk-assessment-response.dto';
import type {
  LawyerExpiryScanResultDto,
  LawyerGateEvaluationDto,
  LawyerGateReasonDto,
  VersionLawyerReviewDto,
} from './dto/version-lawyer-review-response.dto';

/** Resolved Phase 19 timing configuration. */
export interface LawyerTimingConfig {
  workflowEnabled: boolean;
  reviewDueDays: number;
  opinionValidityDays: number;
  expiryWarnDays: number;
}

interface RecordEventInput {
  eventType: RightsLawyerReviewEventType;
  messageRu: string;
  fromStatus?: RightsLawyerReviewStatus | null;
  toStatus?: RightsLawyerReviewStatus | null;
  payload?: Record<string, unknown> | null;
  userId?: string | null;
}

/** Prisma signals a unique-constraint violation with error code `P2002`. */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error as Error & { code?: unknown }).code === 'P2002';

const REVIEW_INCLUDE = {
  assignedLawyer: true,
  rightsIntake: { select: { id: true, candidateTitle: true, workflowStatus: true } },
  book: { select: { id: true, slug: true } },
  bookVersion: { select: { id: true, language: true } },
} as const;

const DETAIL_INCLUDE = {
  ...REVIEW_INCLUDE,
  conditions: { orderBy: { createdAt: 'asc' } },
  opinions: { orderBy: { createdAt: 'asc' } },
  events: { orderBy: { createdAt: 'asc' } },
} as const;

/**
 * The lawyer review is the unit of work of Phase 19. Nothing here ever approves an intake,
 * writes `approvedReviewId`, publishes a version or creates a book — a lawyer can only unblock
 * the editor. Reviews, conditions, opinions and events are never physically deleted.
 */
@Injectable()
export class RightsLawyerReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: RightsNotificationsService,
    private readonly lawyers: RightsLawyerService,
    private readonly risk: RightsRiskAssessmentService,
    private readonly config: ConfigService,
  ) {}

  private getDatabase(): LawyerDatabaseClient {
    return this.prisma as unknown as LawyerDatabaseClient;
  }

  /** Resolved per call so tests can change env between assertions. */
  getTimingConfig(): LawyerTimingConfig {
    return {
      workflowEnabled: parseBooleanFlag(this.config.get(LAWYER_ENV.WORKFLOW_ENABLED), true),
      reviewDueDays: parsePositiveIntOption(
        this.config.get(LAWYER_ENV.REVIEW_DUE_DAYS),
        LAWYER_REVIEW_DUE_DAYS_DEFAULT,
      ),
      opinionValidityDays: parsePositiveIntOption(
        this.config.get(LAWYER_ENV.OPINION_VALIDITY_DAYS),
        LAWYER_OPINION_VALIDITY_DAYS_DEFAULT,
      ),
      expiryWarnDays: parsePositiveIntOption(
        this.config.get(LAWYER_ENV.OPINION_EXPIRY_WARN_DAYS),
        LAWYER_OPINION_EXPIRY_WARN_DAYS_DEFAULT,
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async list(
    query: ListLawyerReviewsDto,
    actorUserId: string,
  ): Promise<LawyerReviewListResponseDto> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit =
      query.limit && query.limit > 0
        ? Math.min(query.limit, LAWYER_LIST_MAX_LIMIT)
        : LAWYER_LIST_DEFAULT_LIMIT;

    const where: Record<string, unknown> = {};
    if (query.status) where['status'] = query.status;
    if (query.trigger) where['trigger'] = query.trigger;
    if (query.riskLevel) where['riskLevel'] = query.riskLevel;
    if (query.decision) where['decision'] = query.decision;
    if (query.assignedLawyerId) where['assignedLawyerId'] = query.assignedLawyerId;
    if (query.rightsIntakeId) where['rightsIntakeId'] = query.rightsIntakeId;
    if (query.rightsProfileId) where['rightsProfileId'] = query.rightsProfileId;
    if (query.bookId) where['bookId'] = query.bookId;
    if (query.bookVersionId) where['bookVersionId'] = query.bookVersionId;
    if (query.rightsClaimId) where['rightsClaimId'] = query.rightsClaimId;
    if (query.blocksApproval !== undefined) where['blocksApproval'] = query.blocksApproval;
    if (query.unassignedOnly) where['assignedLawyerId'] = null;

    const now = new Date();
    if (query.overdueOnly) {
      where['status'] = { in: [...LAWYER_REVIEW_OPEN_STATUSES] };
      where['dueAt'] = { lt: now };
    }
    if (query.expiringWithinDays !== undefined) {
      where['validUntil'] = { gt: now, lte: addDays(now, query.expiringWithinDays) };
    }

    if (query.mine) {
      const lawyer = await this.lawyers.findByUserId(actorUserId);
      // Не-юрист по фильтру «только мои» получает пустой список, а не чужие проверки.
      if (!lawyer) {
        return { items: [], total: 0, page, limit };
      }
      where['assignedLawyerId'] = lawyer.id;
    }

    const database = this.getDatabase();
    const [total, rows] = await Promise.all([
      database.rightsLawyerReview.count({ where }),
      database.rightsLawyerReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: REVIEW_INCLUDE,
      }),
    ]);

    const counters = await this.loadCounters(rows.map((row) => row.id));

    return {
      items: rows.map((row) => this.toDto(row, counters, now)),
      total,
      page,
      limit,
    };
  }

  async getById(id: string): Promise<LawyerReviewDetailDto> {
    const review = await this.requireReview(id, DETAIL_INCLUDE);
    return this.toDetailDto(review, new Date());
  }

  async listByIntake(
    intakeId: string,
    query: ListLawyerReviewsDto,
  ): Promise<LawyerReviewListResponseDto> {
    const database = this.getDatabase();
    const intake = await database.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_INTAKE_NOT_FOUND, {
        rightsIntakeId: intakeId,
      });
    }

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit =
      query.limit && query.limit > 0
        ? Math.min(query.limit, LAWYER_LIST_MAX_LIMIT)
        : LAWYER_LIST_DEFAULT_LIMIT;

    const where: Record<string, unknown> = { rightsIntakeId: intakeId };
    if (query.status) where['status'] = query.status;

    const [total, rows] = await Promise.all([
      database.rightsLawyerReview.count({ where }),
      database.rightsLawyerReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: REVIEW_INCLUDE,
      }),
    ]);

    const now = new Date();
    const counters = await this.loadCounters(rows.map((row) => row.id));
    return { items: rows.map((row) => this.toDto(row, counters, now)), total, page, limit };
  }

  /** Risk snapshot of a profile enriched with the currently open lawyer review. */
  async getRiskAssessmentForProfile(profileId: string): Promise<RiskAssessmentSnapshotDto> {
    const snapshot = await this.risk.assessAndSync(profileId);
    const database = this.getDatabase();

    const openReview = await database.rightsLawyerReview.findFirst({
      where: { rightsProfileId: profileId, status: { in: [...LAWYER_REVIEW_OPEN_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      include: REVIEW_INCLUDE,
    });

    if (!openReview) {
      return snapshot;
    }

    const counters = await this.loadCounters([openReview.id]);
    return { ...snapshot, currentLawyerReview: this.toDto(openReview, counters, new Date()) };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Opens a lawyer review and escalates the intake / profile / agent review.
   * Idempotent: a profile that already has an open review gets a note, not a second review.
   */
  async request(dto: RequestLawyerReviewDto, userId: string): Promise<LawyerReviewDetailDto> {
    const database = this.getDatabase();
    const timing = this.getTimingConfig();

    if (!dto.rightsProfileId && !dto.rightsIntakeId) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_TARGET_REQUIRED);
    }

    let rightsIntakeId = dto.rightsIntakeId ?? null;
    let profile: LawyerProfileRecord | null = null;
    if (dto.rightsProfileId) {
      profile = await database.rightsProfile.findUnique({ where: { id: dto.rightsProfileId } });
      if (!profile) {
        throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_PROFILE_NOT_FOUND, {
          rightsProfileId: dto.rightsProfileId,
        });
      }
      rightsIntakeId = rightsIntakeId ?? profile.rightsIntakeId;
    }

    const intake = rightsIntakeId
      ? await database.rightsIntake.findUnique({ where: { id: rightsIntakeId } })
      : null;
    if (rightsIntakeId && !intake) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_INTAKE_NOT_FOUND, {
        rightsIntakeId,
      });
    }

    // Идемпотентность: открытая проверка у того же профиля повторно не создаётся.
    if (dto.rightsProfileId) {
      const open = await database.rightsLawyerReview.findFirst({
        where: {
          rightsProfileId: dto.rightsProfileId,
          status: { in: [...LAWYER_REVIEW_OPEN_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (open) {
        await this.recordEvent(database, open.id, {
          eventType: RightsLawyerReviewEventType.NOTE_ADDED,
          messageRu: `Повторный запрос юридической проверки: «${dto.titleRu}».`,
          payload: { repeatedRequest: true },
          userId,
        });
        return this.getById(open.id);
      }
    }

    const assessment = dto.rightsProfileId ? await this.risk.assess(dto.rightsProfileId) : null;
    const riskLevel = dto.riskLevel ?? assessment?.riskLevel ?? RightsRiskLevel.HIGH;
    const trigger =
      dto.trigger ?? assessment?.suggestedTrigger ?? RightsLawyerReviewTrigger.MANUAL_REQUEST;

    const now = new Date();
    const dueAt = this.resolveDueAt(dto.dueAt, now, timing.reviewDueDays);
    const blocksApproval = dto.blocksApproval ?? this.risk.blocksApprovalByPolicy(riskLevel);

    if (dto.assignedLawyerId) {
      await this.lawyers.requireActiveLawyer(dto.assignedLawyerId);
    }

    const created = await database.$transaction(async (tx) => {
      const review = await this.createWithReviewNumber(tx, now.getUTCFullYear(), {
        status: RightsLawyerReviewStatus.PENDING,
        trigger,
        riskLevel,
        riskFactors: assessment ? assessment.factors : undefined,
        rightsProfileId: dto.rightsProfileId ?? null,
        rightsIntakeId,
        rightsReviewId: dto.rightsReviewId ?? null,
        bookId: dto.bookId ?? null,
        bookVersionId: dto.bookVersionId ?? null,
        rightsClaimId: dto.rightsClaimId ?? null,
        titleRu: dto.titleRu,
        questionRu: dto.questionRu,
        contextRu: dto.contextRu ?? null,
        affectedCountryCodes: normaliseCountryCodes(dto.affectedCountryCodes),
        affectedLanguages: dto.affectedLanguages ?? [],
        affectedComponentIds: dto.affectedComponentIds ?? [],
        blocksApproval,
        requestedByUserId: userId,
        requestedAt: now,
        dueAt,
        assignedLawyerId: dto.assignedLawyerId ?? null,
        assignedAt: dto.assignedLawyerId ? now : null,
        assignedByUserId: dto.assignedLawyerId ? userId : null,
      });

      await this.recordEvent(tx, review.id, {
        eventType: RightsLawyerReviewEventType.REQUESTED,
        messageRu: `Открыта юридическая проверка ${review.reviewNumber}. Уровень риска: ${RISK_LEVEL_LABELS_RU[riskLevel]}.`,
        toStatus: RightsLawyerReviewStatus.PENDING,
        payload: { trigger, riskLevel, blocksApproval },
        userId,
      });

      await this.syncWorkflowStatuses(tx, review);

      await this.notifications.create(
        {
          type: RightsNotificationType.LAWYER_REVIEW_REQUIRED,
          severity: RightsNotificationSeverity.WARNING,
          titleRu: 'Требуется юридическая проверка',
          messageRu: `Для «${intake?.candidateTitle ?? dto.titleRu}» открыта юридическая проверка ${review.reviewNumber}. Уровень риска: ${RISK_LEVEL_LABELS_RU[riskLevel]}. Причина: ${describeFactors(assessment?.factors)}.`,
          targetUserId: null,
          rightsIntakeId,
          rightsProfileId: dto.rightsProfileId ?? null,
          payload: {
            lawyerReviewId: review.id,
            reviewNumber: review.reviewNumber,
            riskLevel,
            factorCodes: (assessment?.factors ?? []).map((factor) => factor.code),
          },
        },
        tx as unknown as AgentDatabaseClient,
      );

      return review;
    });

    return this.getById(created.id);
  }

  /** Shortcut used by the admin UI: build the context from the profile and open a review. */
  async requireForProfile(
    profileId: string,
    dto: RequireLawyerReviewDto,
    userId: string,
  ): Promise<LawyerReviewDetailDto> {
    const database = this.getDatabase();
    const profile = await database.rightsProfile.findUnique({ where: { id: profileId } });
    if (!profile) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_PROFILE_NOT_FOUND, {
        rightsProfileId: profileId,
      });
    }

    const intake = await database.rightsIntake.findUnique({
      where: { id: profile.rightsIntakeId },
    });
    const assessment = await this.risk.assess(profileId);
    const territories = await database.territoryDecision.findMany({
      where: { rightsProfileId: profileId },
    });

    const subjectReview = await database.rightsReview.findFirst({
      where: { rightsProfileId: profileId, status: 'HUMAN_REVIEW_REQUIRED' },
      orderBy: { id: 'desc' },
    });

    return this.request(
      {
        rightsProfileId: profileId,
        rightsIntakeId: profile.rightsIntakeId,
        rightsReviewId: subjectReview?.id,
        trigger: assessment.suggestedTrigger,
        titleRu: `Юридическая проверка: ${intake?.candidateTitle ?? 'профиль прав'}`,
        questionRu: dto.questionRu ?? buildDefaultQuestion(assessment.factors),
        contextRu: buildContext(assessment.riskLevel, assessment.factors),
        affectedCountryCodes: territories.map((decision) => decision.countryCode),
        affectedLanguages: toStringArray(intake?.targetLanguages),
        riskLevel: assessment.riskLevel,
        blocksApproval: dto.blocksApproval,
        dueAt: dto.dueAt,
        assignedLawyerId: dto.assignedLawyerId,
      },
      userId,
    );
  }

  /**
   * Assigns a lawyer. Staff may assign anyone; a user acting as a lawyer may only take a review
   * for themselves — otherwise `LAWYER_SELF_ASSIGN_ONLY`.
   */
  async assign(
    id: string,
    dto: AssignLawyerReviewDto,
    userId: string,
  ): Promise<LawyerReviewDetailDto> {
    const review = await this.requireReview(id);
    this.assertOpen(review);

    const lawyer = await this.lawyers.requireActiveLawyer(dto.lawyerId);

    // Роли не приходят в запросе (RolesGuard их не прокидывает), поэтому staff-статус актора
    // определяется здесь: юрист без роли admin/content_manager может взять только себя.
    if (!(await this.isStaffUser(userId))) {
      const self = await this.lawyers.findByUserId(userId);
      if (!self || self.id !== dto.lawyerId) {
        throw lawyerError(HttpStatus.FORBIDDEN, LAWYER_ERROR_CODES.LAWYER_SELF_ASSIGN_ONLY);
      }
    }

    const database = this.getDatabase();
    const now = new Date();

    await database.$transaction(async (tx) => {
      await tx.rightsLawyerReview.update({
        where: { id },
        data: { assignedLawyerId: dto.lawyerId, assignedAt: now, assignedByUserId: userId },
      });

      await this.recordEvent(tx, id, {
        eventType: RightsLawyerReviewEventType.ASSIGNED,
        messageRu: `Проверка назначена на юриста ${lawyer.fullName}.`,
        payload: { lawyerId: lawyer.id, lawyerName: lawyer.fullName },
        userId,
      });

      const intake = review.rightsIntakeId
        ? await tx.rightsIntake.findUnique({ where: { id: review.rightsIntakeId } })
        : null;

      await this.notifications.create(
        {
          type: RightsNotificationType.LAWYER_REVIEW_ASSIGNED,
          severity: RightsNotificationSeverity.INFO,
          titleRu: 'Вам назначена юридическая проверка',
          messageRu: `Проверка ${review.reviewNumber} по «${intake?.candidateTitle ?? review.titleRu}» назначена на вас. Срок: ${formatDate(review.dueAt, 'не указан')}.`,
          targetUserId: lawyer.userId,
          rightsIntakeId: review.rightsIntakeId,
          rightsProfileId: review.rightsProfileId,
          payload: { lawyerReviewId: id, reviewNumber: review.reviewNumber },
        },
        tx as unknown as AgentDatabaseClient,
      );
    });

    return this.getById(id);
  }

  /** Takes a PENDING review into work. */
  async start(id: string, userId: string): Promise<LawyerReviewDetailDto> {
    const review = await this.requireReview(id);
    this.assertTransition(review.status, RightsLawyerReviewStatus.IN_PROGRESS);

    const database = this.getDatabase();
    await database.$transaction(async (tx) => {
      await tx.rightsLawyerReview.update({
        where: { id },
        data: { status: RightsLawyerReviewStatus.IN_PROGRESS, startedAt: new Date() },
      });
      await this.recordEvent(tx, id, {
        eventType: RightsLawyerReviewEventType.STARTED,
        messageRu: 'Юрист взял проверку в работу.',
        fromStatus: review.status,
        toStatus: RightsLawyerReviewStatus.IN_PROGRESS,
        userId,
      });
    });

    return this.getById(id);
  }

  /**
   * The lawyer's verdict. `lawyerId` is mandatory: without it there would be no "lawyer name",
   * which is the whole point of the roadmap item.
   */
  async decide(
    id: string,
    dto: DecideLawyerReviewDto,
    userId: string,
  ): Promise<LawyerReviewDetailDto> {
    const review = await this.requireReview(id);
    const targetStatus = LAWYER_DECISION_TO_STATUS[dto.decision];
    this.assertTransition(review.status, targetStatus);

    const lawyer = await this.lawyers.requireActiveLawyer(dto.lawyerId);

    if (dto.opinionSummaryRu.trim().length < LAWYER_MIN_REASON_LENGTH) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_REASON_TOO_SHORT, {
        minLength: LAWYER_MIN_REASON_LENGTH,
      });
    }

    const conditions = dto.conditions ?? [];
    if (dto.decision === RightsLawyerDecision.APPROVED_WITH_CONDITIONS && conditions.length === 0) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_CONDITIONS_REQUIRED);
    }

    const now = new Date();
    const timing = this.getTimingConfig();
    const isPositive = dto.decision !== RightsLawyerDecision.REJECTED;
    const validUntil = isPositive
      ? this.resolveValidUntil(dto.validUntil, now, timing.opinionValidityDays)
      : null;

    const database = this.getDatabase();
    await database.$transaction(async (tx) => {
      // `decide` прямо из PENDING разрешён — чтобы юристу не приходилось делать два клика.
      if (review.status === RightsLawyerReviewStatus.PENDING) {
        await this.recordEvent(tx, id, {
          eventType: RightsLawyerReviewEventType.STARTED,
          messageRu: 'Юрист приступил к проверке и сразу вынес решение.',
          fromStatus: RightsLawyerReviewStatus.PENDING,
          toStatus: RightsLawyerReviewStatus.IN_PROGRESS,
          userId,
        });
      }

      const updated = await tx.rightsLawyerReview.update({
        where: { id },
        data: {
          status: targetStatus,
          decision: dto.decision,
          decidedAt: now,
          decidedByUserId: userId,
          decidedLawyerId: lawyer.id,
          lawyerNameSnapshot: lawyer.fullName,
          opinionSummaryRu: dto.opinionSummaryRu,
          restrictionsRu: dto.restrictionsRu ?? null,
          approvedCountryCodes: normaliseCountryCodes(dto.approvedCountryCodes),
          blockedCountryCodes: normaliseCountryCodes(dto.blockedCountryCodes),
          validUntil,
          startedAt: review.startedAt ?? now,
        },
      });

      for (const condition of conditions) {
        await this.createCondition(tx, id, condition, userId);
      }

      await this.recordEvent(tx, id, {
        eventType: RightsLawyerReviewEventType.DECIDED,
        messageRu: `Решение юриста ${lawyer.fullName}: ${dto.decision}.`,
        fromStatus: review.status,
        toStatus: targetStatus,
        payload: {
          decision: dto.decision,
          lawyerId: lawyer.id,
          lawyerName: lawyer.fullName,
          validUntil: validUntil?.toISOString() ?? null,
          conditionsCount: conditions.length,
        },
        userId,
      });

      await this.syncWorkflowStatuses(tx, updated);

      const intake = updated.rightsIntakeId
        ? await tx.rightsIntake.findUnique({ where: { id: updated.rightsIntakeId } })
        : null;

      await this.notifications.create(
        isPositive
          ? {
              type: RightsNotificationType.LAWYER_REVIEW_APPROVED,
              severity: RightsNotificationSeverity.SUCCESS,
              titleRu: 'Юрист согласовал права',
              messageRu: `${lawyer.fullName} вынес положительное заключение по ${updated.reviewNumber}${conditions.length > 0 ? ` с ${conditions.length} условиями` : ''}. Заключение действует до ${formatDate(validUntil)}.`,
              targetUserId: null,
              rightsIntakeId: updated.rightsIntakeId,
              rightsProfileId: updated.rightsProfileId,
              payload: {
                reviewNumber: updated.reviewNumber,
                decision: dto.decision,
                lawyerName: lawyer.fullName,
                validUntil: validUntil?.toISOString() ?? null,
                conditionsCount: conditions.length,
                intakeTitle: intake?.candidateTitle ?? null,
              },
            }
          : {
              type: RightsNotificationType.LAWYER_REVIEW_REJECTED,
              severity: RightsNotificationSeverity.ERROR,
              titleRu: 'Юрист отказал',
              messageRu: `${lawyer.fullName} отказал по проверке ${updated.reviewNumber}: ${dto.opinionSummaryRu}.`,
              targetUserId: null,
              rightsIntakeId: updated.rightsIntakeId,
              rightsProfileId: updated.rightsProfileId,
              payload: {
                reviewNumber: updated.reviewNumber,
                decision: dto.decision,
                lawyerName: lawyer.fullName,
                validUntil: null,
                conditionsCount: 0,
                intakeTitle: intake?.candidateTitle ?? null,
              },
            },
        tx as unknown as AgentDatabaseClient,
      );
    });

    return this.getById(id);
  }

  async withdraw(
    id: string,
    dto: WithdrawLawyerReviewDto,
    userId: string,
  ): Promise<LawyerReviewDetailDto> {
    const review = await this.requireReview(id);
    this.assertTransition(review.status, RightsLawyerReviewStatus.WITHDRAWN);
    this.assertReason(dto.reasonRu);

    const database = this.getDatabase();
    const now = new Date();

    await database.$transaction(async (tx) => {
      const updated = await tx.rightsLawyerReview.update({
        where: { id },
        data: {
          status: RightsLawyerReviewStatus.WITHDRAWN,
          withdrawnAt: now,
          withdrawnByUserId: userId,
          withdrawReasonRu: dto.reasonRu,
        },
      });

      await this.recordEvent(tx, id, {
        eventType: RightsLawyerReviewEventType.WITHDRAWN,
        messageRu: `Юридическая проверка отозвана: ${dto.reasonRu}`,
        fromStatus: review.status,
        toStatus: RightsLawyerReviewStatus.WITHDRAWN,
        userId,
      });

      await this.syncWorkflowStatuses(tx, updated);

      await this.notifications.create(
        {
          type: RightsNotificationType.LAWYER_REVIEW_WITHDRAWN,
          severity: RightsNotificationSeverity.INFO,
          titleRu: 'Юридическая проверка отозвана',
          messageRu: `Проверка ${updated.reviewNumber} отозвана: ${dto.reasonRu}.`,
          targetUserId: null,
          rightsIntakeId: updated.rightsIntakeId,
          rightsProfileId: updated.rightsProfileId,
          payload: { reviewNumber: updated.reviewNumber, withdrawReasonRu: dto.reasonRu },
        },
        tx as unknown as AgentDatabaseClient,
      );
    });

    return this.getById(id);
  }

  /** Admin-only. Opinions and conditions are kept: only the verdict fields are cleared. */
  async reopen(id: string, userId: string): Promise<LawyerReviewDetailDto> {
    const review = await this.requireReview(id);
    if (!LAWYER_REVIEW_REOPENABLE_STATUSES.includes(review.status)) {
      throw lawyerError(HttpStatus.CONFLICT, LAWYER_ERROR_CODES.LAWYER_REVIEW_INVALID_TRANSITION, {
        from: review.status,
        to: RightsLawyerReviewStatus.PENDING,
      });
    }

    const database = this.getDatabase();
    const now = new Date();

    await database.$transaction(async (tx) => {
      const updated = await tx.rightsLawyerReview.update({
        where: { id },
        data: {
          status: RightsLawyerReviewStatus.PENDING,
          decision: null,
          decidedAt: null,
          decidedByUserId: null,
          decidedLawyerId: null,
          lawyerNameSnapshot: null,
          validUntil: null,
          expiredAt: null,
          expiryNotifiedAt: null,
          withdrawnAt: null,
          withdrawnByUserId: null,
          reopenedAt: now,
          reopenedByUserId: userId,
        },
      });

      await this.recordEvent(tx, id, {
        eventType: RightsLawyerReviewEventType.REOPENED,
        messageRu: 'Юридическая проверка переоткрыта администратором.',
        fromStatus: review.status,
        toStatus: RightsLawyerReviewStatus.PENDING,
        userId,
      });

      await this.syncWorkflowStatuses(tx, updated);
    });

    return this.getById(id);
  }

  async addNote(
    id: string,
    dto: AddLawyerReviewNoteDto,
    userId: string,
  ): Promise<LawyerReviewDetailDto> {
    await this.requireReview(id);
    await this.recordEvent(this.getDatabase(), id, {
      eventType: RightsLawyerReviewEventType.NOTE_ADDED,
      messageRu: dto.messageRu,
      userId,
    });
    return this.getById(id);
  }

  // ---------------------------------------------------------------------------
  // Conditions
  // ---------------------------------------------------------------------------

  async addCondition(
    id: string,
    dto: CreateConditionDto,
    userId: string,
  ): Promise<LawyerReviewDetailDto> {
    const review = await this.requireReview(id);
    if (review.status === RightsLawyerReviewStatus.WITHDRAWN) {
      throw lawyerError(HttpStatus.CONFLICT, LAWYER_ERROR_CODES.LAWYER_REVIEW_ALREADY_CLOSED);
    }

    await this.createCondition(this.getDatabase(), id, dto, userId);
    return this.getById(id);
  }

  async satisfyCondition(
    id: string,
    conditionId: string,
    dto: SatisfyConditionDto,
    userId: string,
  ): Promise<LawyerReviewDetailDto> {
    const condition = await this.requireCondition(id, conditionId);
    if (condition.status !== RightsLawyerConditionStatus.PENDING) {
      throw lawyerError(HttpStatus.CONFLICT, LAWYER_ERROR_CODES.LAWYER_CONDITION_ALREADY_CLOSED, {
        conditionId,
        status: condition.status,
      });
    }

    const database = this.getDatabase();
    await database.$transaction(async (tx) => {
      await tx.rightsLawyerReviewCondition.update({
        where: { id: conditionId },
        data: {
          status: RightsLawyerConditionStatus.SATISFIED,
          satisfiedAt: new Date(),
          satisfiedByUserId: userId,
          satisfiedNotesRu: dto.notesRu ?? null,
        },
      });
      await this.recordEvent(tx, id, {
        eventType: RightsLawyerReviewEventType.CONDITION_SATISFIED,
        messageRu: `Условие «${condition.code}» отмечено выполненным.`,
        payload: { conditionId, code: condition.code },
        userId,
      });
    });

    return this.getById(id);
  }

  async waiveCondition(
    id: string,
    conditionId: string,
    dto: WaiveConditionDto,
    userId: string,
  ): Promise<LawyerReviewDetailDto> {
    const condition = await this.requireCondition(id, conditionId);
    if (condition.status !== RightsLawyerConditionStatus.PENDING) {
      throw lawyerError(HttpStatus.CONFLICT, LAWYER_ERROR_CODES.LAWYER_CONDITION_ALREADY_CLOSED, {
        conditionId,
        status: condition.status,
      });
    }
    this.assertReason(dto.reasonRu);

    const database = this.getDatabase();
    await database.$transaction(async (tx) => {
      await tx.rightsLawyerReviewCondition.update({
        where: { id: conditionId },
        data: {
          status: RightsLawyerConditionStatus.WAIVED,
          waivedAt: new Date(),
          waivedByUserId: userId,
          waiveReasonRu: dto.reasonRu,
        },
      });
      await this.recordEvent(tx, id, {
        eventType: RightsLawyerReviewEventType.CONDITION_WAIVED,
        messageRu: `Условие «${condition.code}» отменено: ${dto.reasonRu}`,
        payload: { conditionId, code: condition.code },
        userId,
      });
    });

    return this.getById(id);
  }

  // ---------------------------------------------------------------------------
  // Publication gate
  // ---------------------------------------------------------------------------

  /** Read-only evaluation used by the publication gate (block 6.20). Writes nothing. */
  async evaluateVersionLawyerReview(versionId: string): Promise<LawyerGateEvaluationDto> {
    const empty: LawyerGateEvaluationDto = {
      versionId,
      blockers: [],
      warnings: [],
      lawyerReviewRequired: false,
      lawyerApproved: false,
      openReviewsCount: 0,
      pendingConditionsCount: 0,
      riskLevel: null,
      lawyerOpinionValidUntil: null,
      reviewIds: [],
    };

    const timing = this.getTimingConfig();
    if (!timing.workflowEnabled) {
      return empty;
    }

    const database = this.getDatabase();
    const version = await database.bookVersion.findUnique({ where: { id: versionId } });
    if (!version?.rightsProfileId) {
      return empty;
    }

    const profile = await database.rightsProfile.findUnique({
      where: { id: version.rightsProfileId },
    });
    if (!profile) {
      return empty;
    }

    const reviews = await database.rightsLawyerReview.findMany({
      where: { rightsProfileId: profile.id },
      orderBy: { createdAt: 'desc' },
      include: { conditions: true },
    });

    const now = new Date();
    const blockers: LawyerGateReasonDto[] = [];
    const warnings: LawyerGateReasonDto[] = [];

    const openReviews = reviews.filter((review) =>
      LAWYER_REVIEW_OPEN_STATUSES.includes(review.status),
    );
    const positiveReviews = reviews.filter((review) =>
      LAWYER_REVIEW_POSITIVE_STATUSES.includes(review.status),
    );
    const inForce = positiveReviews.filter(
      (review) => !review.validUntil || review.validUntil.getTime() > now.getTime(),
    );
    const expired = positiveReviews.filter(
      (review) => review.validUntil && review.validUntil.getTime() <= now.getTime(),
    );

    const pendingBlockingConditions = inForce.flatMap((review) =>
      (review.conditions ?? []).filter(
        (condition) =>
          condition.status === RightsLawyerConditionStatus.PENDING && condition.isBlocking,
      ),
    );
    const pendingConditionsCount = inForce.flatMap((review) =>
      (review.conditions ?? []).filter(
        (condition) => condition.status === RightsLawyerConditionStatus.PENDING,
      ),
    ).length;

    const lawyerApproved = inForce.length > 0;
    const lawyerReviewRequired = profile.lawyerReviewRequired;
    const blockingOpen = openReviews.filter((review) => review.blocksApproval);
    const policy = this.risk.getRiskPolicy();

    // --- blockers ---------------------------------------------------------
    if (lawyerReviewRequired && !lawyerApproved && policy.blockApprovalOnHighRisk) {
      blockers.push(
        reason(
          LAWYER_GATE_CODES.LAWYER_REVIEW_REQUIRED_NOT_APPROVED,
          'Для профиля прав требуется положительное заключение юриста — его нет или оно недействительно.',
          profile.currentLawyerReviewId,
          { riskLevel: profile.riskLevel },
        ),
      );
    }

    for (const review of blockingOpen) {
      blockers.push(
        reason(
          LAWYER_GATE_CODES.LAWYER_REVIEW_PENDING,
          `Юридическая проверка ${review.reviewNumber} ещё не завершена.`,
          review.id,
          { status: review.status },
        ),
      );
    }

    const lastDecided = reviews.find((review) => review.decision !== null);
    if (lastDecided && lastDecided.status === RightsLawyerReviewStatus.REJECTED) {
      blockers.push(
        reason(
          LAWYER_GATE_CODES.LAWYER_REVIEW_REJECTED,
          `Юрист отказал по проверке ${lastDecided.reviewNumber}.`,
          lastDecided.id,
          { decidedAt: lastDecided.decidedAt?.toISOString() ?? null },
        ),
      );
    }

    for (const review of expired) {
      blockers.push(
        reason(
          LAWYER_GATE_CODES.LAWYER_OPINION_EXPIRED,
          `Срок действия заключения по проверке ${review.reviewNumber} истёк ${formatDate(review.validUntil)}.`,
          review.id,
          { validUntil: review.validUntil?.toISOString() ?? null },
        ),
      );
    }

    for (const condition of pendingBlockingConditions) {
      blockers.push(
        reason(
          LAWYER_GATE_CODES.LAWYER_CONDITIONS_UNMET,
          `Не выполнено обязательное условие юриста «${condition.code}»: ${condition.textRu}`,
          condition.rightsLawyerReviewId,
          { conditionId: condition.id, code: condition.code },
        ),
      );
    }

    // --- warnings ---------------------------------------------------------
    for (const review of openReviews.filter((item) => !item.blocksApproval)) {
      warnings.push(
        reason(
          LAWYER_GATE_CODES.LAWYER_REVIEW_OPEN_NON_BLOCKING,
          `Открыта информационная юридическая проверка ${review.reviewNumber}.`,
          review.id,
          null,
        ),
      );
    }

    for (const review of inForce) {
      if (!review.validUntil) continue;
      const days = daysUntil(review.validUntil, now);
      if (days > 0 && days <= timing.expiryWarnDays) {
        warnings.push(
          reason(
            LAWYER_GATE_CODES.LAWYER_OPINION_EXPIRING_SOON,
            `Заключение по проверке ${review.reviewNumber} действует ещё ${days} дн.`,
            review.id,
            { validUntil: review.validUntil.toISOString(), daysUntilExpiry: days },
          ),
        );
      }
    }

    for (const review of inForce) {
      if (
        review.status === RightsLawyerReviewStatus.APPROVED_WITH_CONDITIONS &&
        (review.conditions ?? []).every(
          (condition) =>
            !condition.isBlocking || condition.status !== RightsLawyerConditionStatus.PENDING,
        )
      ) {
        warnings.push(
          reason(
            LAWYER_GATE_CODES.LAWYER_APPROVED_WITH_CONDITIONS,
            `Заключение по проверке ${review.reviewNumber} выдано с условиями — все блокирующие условия закрыты.`,
            review.id,
            null,
          ),
        );
      }
    }

    if (lawyerReviewRequired && !lawyerApproved && !policy.blockApprovalOnHighRisk) {
      warnings.push(
        reason(
          LAWYER_GATE_CODES.HIGH_RISK_WITHOUT_LAWYER_REVIEW,
          `Уровень риска ${profile.riskLevel} требует юриста, но блокировка отключена настройкой.`,
          profile.currentLawyerReviewId,
          { riskLevel: profile.riskLevel },
        ),
      );
    }

    for (const review of openReviews) {
      if (review.dueAt && review.dueAt.getTime() < now.getTime()) {
        warnings.push(
          reason(
            LAWYER_GATE_CODES.LAWYER_REVIEW_OVERDUE,
            `Юридическая проверка ${review.reviewNumber} просрочена (срок ${formatDate(review.dueAt)}).`,
            review.id,
            { dueAt: review.dueAt.toISOString() },
          ),
        );
      }
    }

    return {
      versionId,
      blockers,
      warnings,
      lawyerReviewRequired,
      lawyerApproved,
      openReviewsCount: openReviews.length,
      pendingConditionsCount,
      riskLevel: profile.riskLevel,
      lawyerOpinionValidUntil: profile.lawyerOpinionValidUntil?.toISOString() ?? null,
      reviewIds: reviews.map((review) => review.id),
    };
  }

  /** Everything the book rights tab shows about the legal review of a version. */
  async getVersionLawyerReview(versionId: string): Promise<VersionLawyerReviewDto> {
    const database = this.getDatabase();
    const version = await database.bookVersion.findUnique({ where: { id: versionId } });
    if (!version) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_VERSION_NOT_FOUND, {
        versionId,
      });
    }

    const evaluation = await this.evaluateVersionLawyerReview(versionId);
    const now = new Date();
    const timing = this.getTimingConfig();

    const profile = version.rightsProfileId
      ? await database.rightsProfile.findUnique({ where: { id: version.rightsProfileId } })
      : null;

    const rows = version.rightsProfileId
      ? await database.rightsLawyerReview.findMany({
          where: { rightsProfileId: version.rightsProfileId },
          orderBy: { createdAt: 'desc' },
          take: LAWYER_EMBEDDED_ITEMS_LIMIT,
          include: REVIEW_INCLUDE,
        })
      : [];

    const counters = await this.loadCounters(rows.map((row) => row.id));
    const pendingConditions = rows.length
      ? await database.rightsLawyerReviewCondition.findMany({
          where: {
            rightsLawyerReviewId: { in: rows.map((row) => row.id) },
            status: RightsLawyerConditionStatus.PENDING,
          },
          orderBy: { createdAt: 'asc' },
          take: LAWYER_EMBEDDED_ITEMS_LIMIT,
        })
      : [];

    const validUntil = profile?.lawyerOpinionValidUntil ?? null;
    const daysLeft = validUntil ? daysUntil(validUntil, now) : null;

    return {
      ...evaluation,
      bookId: version.bookId,
      rightsProfileId: version.rightsProfileId,
      lawyerApprovedAt: profile?.lawyerApprovedAt?.toISOString() ?? null,
      lawyerApprovedLawyerName: profile?.lawyerApprovedLawyerName ?? null,
      isExpiringSoon: daysLeft !== null && daysLeft > 0 && daysLeft <= timing.expiryWarnDays,
      reviews: rows.map((row) => this.toDto(row, counters, now)),
      pendingConditions: pendingConditions.map((condition) => toConditionDto(condition)),
    };
  }

  // ---------------------------------------------------------------------------
  // Expiry scan (manual, admin-only — Phase 19 adds no scheduler, see ADR-001)
  // ---------------------------------------------------------------------------

  /**
   * Materialises expired opinions and sends the expiry notifications.
   * Idempotent: a review whose `expiryNotifiedAt` is already set is skipped.
   */
  async runExpiryScan(userId: string): Promise<LawyerExpiryScanResultDto> {
    const now = new Date();
    const timing = this.getTimingConfig();
    const database = this.getDatabase();

    const candidates = await database.rightsLawyerReview.findMany({
      where: {
        status: { in: [...LAWYER_REVIEW_POSITIVE_STATUSES] },
        validUntil: { not: null },
      },
      orderBy: { validUntil: 'asc' },
    });

    const touched: string[] = [];
    let expiredCount = 0;
    let expiringSoonCount = 0;
    let notificationsSent = 0;

    for (const review of candidates) {
      if (!review.validUntil) continue;
      const days = daysUntil(review.validUntil, now);
      const isExpired = review.validUntil.getTime() <= now.getTime();
      const isExpiringSoon = !isExpired && days > 0 && days <= timing.expiryWarnDays;

      if (!isExpired && !isExpiringSoon) continue;
      if (review.expiryNotifiedAt && !isExpired) continue;
      if (isExpired && review.expiredAt) continue;

      if (isExpired) expiredCount += 1;
      else expiringSoonCount += 1;

      await database.$transaction(async (tx) => {
        const updated = await tx.rightsLawyerReview.update({
          where: { id: review.id },
          data: isExpired
            ? {
                status: RightsLawyerReviewStatus.EXPIRED,
                expiredAt: now,
                expiryNotifiedAt: now,
              }
            : { expiryNotifiedAt: now },
        });

        await this.recordEvent(tx, review.id, {
          eventType: isExpired
            ? RightsLawyerReviewEventType.EXPIRED
            : RightsLawyerReviewEventType.NOTE_ADDED,
          messageRu: isExpired
            ? `Срок действия заключения истёк ${formatDate(review.validUntil)}.`
            : `Срок действия заключения истекает ${formatDate(review.validUntil)} — осталось ${days} дн.`,
          fromStatus: isExpired ? review.status : null,
          toStatus: isExpired ? RightsLawyerReviewStatus.EXPIRED : null,
          userId,
        });

        if (isExpired) {
          await this.syncWorkflowStatuses(tx, updated);
        }

        await this.notifications.create(
          {
            type: isExpired
              ? RightsNotificationType.LAWYER_OPINION_EXPIRED
              : RightsNotificationType.LAWYER_OPINION_EXPIRING,
            severity: isExpired
              ? RightsNotificationSeverity.ERROR
              : RightsNotificationSeverity.WARNING,
            titleRu: isExpired ? 'Заключение юриста истекло' : 'Заключение юриста истекает',
            messageRu: isExpired
              ? `Заключение по ${review.reviewNumber} истекло ${formatDate(review.validUntil)}. Публикация новых версий заблокирована.`
              : `Заключение по ${review.reviewNumber} действует до ${formatDate(review.validUntil)} — осталось ${days} дн.`,
            targetUserId: null,
            rightsIntakeId: review.rightsIntakeId,
            rightsProfileId: review.rightsProfileId,
            payload: {
              reviewNumber: review.reviewNumber,
              validUntil: review.validUntil?.toISOString() ?? null,
              days,
            },
          },
          tx as unknown as AgentDatabaseClient,
        );
      });

      notificationsSent += 1;
      touched.push(review.id);
    }

    return {
      checkedCount: candidates.length,
      expiredCount,
      expiringSoonCount,
      notificationsSent,
      reviewIds: touched,
      runAt: now.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Workflow status synchronisation — the only place Phase 19 touches Phases 1/3/5
  // ---------------------------------------------------------------------------

  /**
   * Keeps intake / profile / agent-review statuses in step with the lawyer review.
   *
   * Never sets `RightsIntake.workflowStatus = 'APPROVED'` and never writes `approvedReviewId`:
   * a lawyer can only unblock the editor, the final approval stays with admin / content manager.
   * An intake that is already APPROVED / BOOK_CREATED / REJECTED / ARCHIVED is never rolled back —
   * un-publishing a live book is the job of claims (Phase 16) or recheck (Phase 18).
   */
  private async syncWorkflowStatuses(
    tx: LawyerDatabaseClient,
    review: RightsLawyerReviewRecord,
  ): Promise<void> {
    if (!review.rightsProfileId) return;

    const profile = await tx.rightsProfile.findUnique({ where: { id: review.rightsProfileId } });
    if (!profile) return;

    const openBlocking = await tx.rightsLawyerReview.count({
      where: {
        rightsProfileId: review.rightsProfileId,
        status: { in: [...LAWYER_REVIEW_OPEN_STATUSES] },
        blocksApproval: true,
      },
    });

    const isOpenBlocking =
      LAWYER_REVIEW_OPEN_STATUSES.includes(review.status) && review.blocksApproval;
    const isPositive = LAWYER_REVIEW_POSITIVE_STATUSES.includes(review.status);

    if (isOpenBlocking) {
      await this.escalate(tx, review, profile.id);
      return;
    }

    if (isPositive) {
      await this.applyPositiveDecision(tx, review, profile.id, openBlocking);
      return;
    }

    if (review.status === RightsLawyerReviewStatus.REJECTED) {
      // Отказ статусы не меняет: интейк остаётся в LAWYER_REVIEW_REQUIRED, а редактор решает,
      // отклонить проверку обычным reject или запросить новый отчёт агента.
      return;
    }

    // WITHDRAWN / EXPIRED / повторно открытая PENDING без блокировки.
    await this.releaseBlocking(tx, review, profile.id, openBlocking);
  }

  private async escalate(
    tx: LawyerDatabaseClient,
    review: RightsLawyerReviewRecord,
    profileId: string,
  ): Promise<void> {
    await tx.rightsProfile.updateMany({
      where: { id: profileId, status: { in: [...LAWYER_ESCALATABLE_PROFILE_STATUSES] } },
      data: { status: 'LAWYER_REVIEW_REQUIRED' },
    });

    await tx.rightsProfile.update({
      where: { id: profileId },
      data: {
        lawyerReviewRequired: true,
        lawyerReviewBlocking: true,
        currentLawyerReviewId: review.id,
      },
    });

    // Интейк в APPROVED / BOOK_CREATED / REJECTED / ARCHIVED не откатывается: юридическая
    // проверка уже опубликованной книги не должна менять её workflow-статус.
    if (review.rightsIntakeId) {
      await tx.rightsIntake.updateMany({
        where: {
          id: review.rightsIntakeId,
          workflowStatus: { in: [...LAWYER_ESCALATABLE_INTAKE_STATUSES] },
        },
        data: { workflowStatus: 'LAWYER_REVIEW_REQUIRED' },
      });
    }

    if (review.rightsReviewId) {
      await tx.rightsReview.updateMany({
        where: { id: review.rightsReviewId, status: 'HUMAN_REVIEW_REQUIRED' },
        data: {
          status: 'LAWYER_REVIEW_REQUIRED',
          lawyerReviewRequired: true,
          lawyerReviewId: review.id,
        },
      });
    }
  }

  private async applyPositiveDecision(
    tx: LawyerDatabaseClient,
    review: RightsLawyerReviewRecord,
    profileId: string,
    openBlockingCount: number,
  ): Promise<void> {
    await tx.rightsProfile.updateMany({
      where: { id: profileId, status: 'LAWYER_REVIEW_REQUIRED' },
      data: { status: 'LAWYER_APPROVED' },
    });

    await tx.rightsProfile.update({
      where: { id: profileId },
      data: {
        lawyerReviewBlocking: openBlockingCount > 0,
        lawyerApprovedAt: review.decidedAt ?? new Date(),
        lawyerApprovedLawyerId: review.decidedLawyerId,
        lawyerApprovedLawyerName: review.lawyerNameSnapshot,
        lawyerOpinionValidUntil: review.validUntil,
        currentLawyerReviewId: review.id,
      },
    });

    if (review.rightsReviewId) {
      await tx.rightsReview.updateMany({
        where: { id: review.rightsReviewId, status: 'LAWYER_REVIEW_REQUIRED' },
        data: { status: 'LAWYER_APPROVED' },
      });
      await tx.rightsReview.update({
        where: { id: review.rightsReviewId },
        data: {
          lawyerApprovedAt: review.decidedAt ?? new Date(),
          lawyerNameSnapshot: review.lawyerNameSnapshot,
        },
      });
    }

    // Интейк возвращается редактору — но только из LAWYER_REVIEW_REQUIRED.
    if (review.rightsIntakeId && openBlockingCount === 0) {
      await tx.rightsIntake.updateMany({
        where: { id: review.rightsIntakeId, workflowStatus: 'LAWYER_REVIEW_REQUIRED' },
        data: { workflowStatus: 'HUMAN_REVIEW_REQUIRED' },
      });
    }
  }

  private async releaseBlocking(
    tx: LawyerDatabaseClient,
    review: RightsLawyerReviewRecord,
    profileId: string,
    openBlockingCount: number,
  ): Promise<void> {
    const expired = review.status === RightsLawyerReviewStatus.EXPIRED;

    await tx.rightsProfile.update({
      where: { id: profileId },
      data: {
        lawyerReviewBlocking: openBlockingCount > 0,
        ...(expired
          ? {
              lawyerApprovedAt: null,
              lawyerApprovedLawyerId: null,
              lawyerApprovedLawyerName: null,
              lawyerOpinionValidUntil: null,
            }
          : {}),
      },
    });

    if (openBlockingCount === 0) {
      await tx.rightsProfile.updateMany({
        where: { id: profileId, status: 'LAWYER_REVIEW_REQUIRED' },
        data: { status: 'HUMAN_REVIEW_REQUIRED' },
      });
    }

    if (expired && review.rightsReviewId) {
      await tx.rightsReview.updateMany({
        where: { id: review.rightsReviewId, status: 'LAWYER_APPROVED' },
        data: { status: 'LAWYER_REVIEW_REQUIRED', lawyerApprovedAt: null },
      });
    } else if (openBlockingCount === 0 && review.rightsReviewId) {
      await tx.rightsReview.updateMany({
        where: { id: review.rightsReviewId, status: 'LAWYER_REVIEW_REQUIRED' },
        data: { status: 'HUMAN_REVIEW_REQUIRED' },
      });
    }

    if (review.rightsIntakeId && openBlockingCount === 0) {
      await tx.rightsIntake.updateMany({
        where: { id: review.rightsIntakeId, workflowStatus: 'LAWYER_REVIEW_REQUIRED' },
        data: { workflowStatus: 'HUMAN_REVIEW_REQUIRED' },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async requireReview(
    id: string,
    include: Record<string, unknown> = REVIEW_INCLUDE,
  ): Promise<RightsLawyerReviewRecord> {
    const review = await this.getDatabase().rightsLawyerReview.findUnique({
      where: { id },
      include,
    });
    if (!review) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_REVIEW_NOT_FOUND, {
        lawyerReviewId: id,
      });
    }
    return review;
  }

  private async requireCondition(
    reviewId: string,
    conditionId: string,
  ): Promise<RightsLawyerReviewConditionRecord> {
    const condition = await this.getDatabase().rightsLawyerReviewCondition.findUnique({
      where: { id: conditionId },
    });
    if (!condition || condition.rightsLawyerReviewId !== reviewId) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_CONDITION_NOT_FOUND, {
        conditionId,
      });
    }
    return condition;
  }

  /** `admin` / `content_manager` may act on behalf of anyone; a plain lawyer may not. */
  private async isStaffUser(userId: string): Promise<boolean> {
    const user = await this.getDatabase().user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    return (user?.roles ?? []).some(
      (entry) => entry.role.name === 'admin' || entry.role.name === 'content_manager',
    );
  }

  private assertOpen(review: RightsLawyerReviewRecord): void {
    if (!LAWYER_REVIEW_OPEN_STATUSES.includes(review.status)) {
      throw lawyerError(HttpStatus.CONFLICT, LAWYER_ERROR_CODES.LAWYER_REVIEW_ALREADY_CLOSED, {
        status: review.status,
      });
    }
  }

  private assertTransition(from: RightsLawyerReviewStatus, to: RightsLawyerReviewStatus): void {
    if (!LAWYER_REVIEW_ALLOWED_TRANSITIONS[from].includes(to)) {
      throw lawyerError(HttpStatus.CONFLICT, LAWYER_ERROR_CODES.LAWYER_REVIEW_INVALID_TRANSITION, {
        from,
        to,
      });
    }
  }

  private assertReason(reason_: string): void {
    if (reason_.trim().length < LAWYER_MIN_REASON_LENGTH) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_REASON_TOO_SHORT, {
        minLength: LAWYER_MIN_REASON_LENGTH,
      });
    }
  }

  private resolveDueAt(raw: string | undefined, now: Date, defaultDays: number): Date {
    if (!raw) return addDays(now, defaultDays);
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() < now.getTime()) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_INVALID_DUE_DATE, {
        dueAt: raw,
      });
    }
    return parsed;
  }

  private resolveValidUntil(raw: string | undefined, now: Date, defaultDays: number): Date {
    if (!raw) return addDays(now, defaultDays);
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() < now.getTime()) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_INVALID_VALID_UNTIL, {
        validUntil: raw,
      });
    }
    return parsed;
  }

  /**
   * Review numbers are `LR-<year>-<6 digits>`. Concurrent creation can collide on the unique
   * index, so a bounded retry walks the counter forward instead of failing the request.
   */
  private async createWithReviewNumber(
    tx: LawyerDatabaseClient,
    year: number,
    data: Record<string, unknown>,
  ): Promise<RightsLawyerReviewRecord> {
    const prefix = `${LAWYER_REVIEW_NUMBER_PREFIX}-${year}-`;
    const existingCount = await tx.rightsLawyerReview.count({
      where: { reviewNumber: { startsWith: prefix } },
    });

    for (let attempt = 0; attempt < LAWYER_REVIEW_NUMBER_MAX_RETRIES; attempt += 1) {
      const reviewNumber = `${prefix}${String(existingCount + 1 + attempt).padStart(6, '0')}`;
      try {
        return await tx.rightsLawyerReview.create({ data: { ...data, reviewNumber } });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }

    throw lawyerError(
      HttpStatus.CONFLICT,
      LAWYER_ERROR_CODES.LAWYER_REVIEW_NUMBER_GENERATION_FAILED,
      { prefix },
    );
  }

  private async createCondition(
    tx: LawyerDatabaseClient,
    reviewId: string,
    dto: CreateConditionDto,
    userId: string,
  ): Promise<RightsLawyerReviewConditionRecord> {
    const created = await tx.rightsLawyerReviewCondition.create({
      data: {
        rightsLawyerReviewId: reviewId,
        code: dto.code.trim().toUpperCase(),
        textRu: dto.textRu,
        isBlocking: dto.isBlocking ?? true,
        affectedCountryCodes: normaliseCountryCodes(dto.affectedCountryCodes),
      },
    });

    await this.recordEvent(tx, reviewId, {
      eventType: RightsLawyerReviewEventType.CONDITION_ADDED,
      messageRu: `Добавлено условие «${created.code}»: ${created.textRu}`,
      payload: { conditionId: created.id, code: created.code, isBlocking: created.isBlocking },
      userId,
    });

    return created;
  }

  /** Events are append-only: they are never updated and never deleted. */
  private async recordEvent(
    tx: LawyerDatabaseClient,
    reviewId: string,
    input: RecordEventInput,
  ): Promise<void> {
    await tx.rightsLawyerReviewEvent.create({
      data: {
        rightsLawyerReviewId: reviewId,
        eventType: input.eventType,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        messageRu: input.messageRu,
        payload: input.payload ?? undefined,
        createdByUserId: input.userId ?? null,
      },
    });
  }

  /** Condition and opinion counters for a page of reviews, in two queries instead of 2×N. */
  private async loadCounters(reviewIds: string[]): Promise<Map<string, ReviewCounters>> {
    const counters = new Map<string, ReviewCounters>();
    if (reviewIds.length === 0) return counters;

    const database = this.getDatabase();
    const [conditions, opinions] = await Promise.all([
      database.rightsLawyerReviewCondition.findMany({
        where: { rightsLawyerReviewId: { in: reviewIds } },
      }),
      database.rightsLegalOpinion.findMany({
        where: { rightsLawyerReviewId: { in: reviewIds } },
      }),
    ]);

    for (const id of reviewIds) {
      counters.set(id, {
        pendingConditions: 0,
        blockingConditions: 0,
        satisfiedConditions: 0,
        opinions: 0,
        activeOpinions: 0,
      });
    }

    for (const condition of conditions) {
      const entry = counters.get(condition.rightsLawyerReviewId);
      if (!entry) continue;
      if (condition.status === RightsLawyerConditionStatus.PENDING) {
        entry.pendingConditions += 1;
        if (condition.isBlocking) entry.blockingConditions += 1;
      }
      if (condition.status === RightsLawyerConditionStatus.SATISFIED) {
        entry.satisfiedConditions += 1;
      }
    }

    for (const opinion of opinions) {
      const entry = counters.get(opinion.rightsLawyerReviewId);
      if (!entry) continue;
      entry.opinions += 1;
      if (!opinion.archivedAt) entry.activeOpinions += 1;
    }

    return counters;
  }

  toDto(
    record: RightsLawyerReviewRecord,
    counters: Map<string, ReviewCounters>,
    now: Date,
  ): LawyerReviewDto {
    const embedded = record.conditions ?? [];
    const embeddedOpinions = record.opinions ?? [];
    const counted = counters.get(record.id) ?? countInline(embedded, embeddedOpinions);

    const expiredByDate =
      LAWYER_REVIEW_POSITIVE_STATUSES.includes(record.status) &&
      !!record.validUntil &&
      record.validUntil.getTime() <= now.getTime();
    const effectiveStatus = expiredByDate ? RightsLawyerReviewStatus.EXPIRED : record.status;
    const timing = this.getTimingConfig();
    const daysUntilExpiry = record.validUntil ? daysUntil(record.validUntil, now) : null;

    return {
      id: record.id,
      reviewNumber: record.reviewNumber,
      status: record.status,
      effectiveStatus,
      trigger: record.trigger,
      riskLevel: record.riskLevel,
      rightsProfileId: record.rightsProfileId,
      rightsIntakeId: record.rightsIntakeId,
      rightsReviewId: record.rightsReviewId,
      bookId: record.bookId,
      bookVersionId: record.bookVersionId,
      rightsClaimId: record.rightsClaimId,
      titleRu: record.titleRu,
      questionRu: record.questionRu,
      contextRu: record.contextRu,
      affectedCountryCodes: toStringArray(record.affectedCountryCodes),
      affectedLanguages: toStringArray(record.affectedLanguages),
      affectedComponentIds: toStringArray(record.affectedComponentIds),
      blocksApproval: record.blocksApproval,
      requestedByUserId: record.requestedByUserId,
      requestedAt: new Date(record.requestedAt).toISOString(),
      dueAt: record.dueAt ? new Date(record.dueAt).toISOString() : null,
      assignedLawyerId: record.assignedLawyerId,
      assignedLawyerName: record.assignedLawyer?.fullName ?? null,
      assignedAt: record.assignedAt ? new Date(record.assignedAt).toISOString() : null,
      startedAt: record.startedAt ? new Date(record.startedAt).toISOString() : null,
      decision: record.decision,
      decidedAt: record.decidedAt ? new Date(record.decidedAt).toISOString() : null,
      decidedByUserId: record.decidedByUserId,
      decidedLawyerId: record.decidedLawyerId,
      lawyerNameSnapshot: record.lawyerNameSnapshot,
      opinionSummaryRu: record.opinionSummaryRu,
      restrictionsRu: record.restrictionsRu,
      approvedCountryCodes: toStringArray(record.approvedCountryCodes),
      blockedCountryCodes: toStringArray(record.blockedCountryCodes),
      validUntil: record.validUntil ? new Date(record.validUntil).toISOString() : null,
      expiredAt: record.expiredAt ? new Date(record.expiredAt).toISOString() : null,
      withdrawnAt: record.withdrawnAt ? new Date(record.withdrawnAt).toISOString() : null,
      withdrawReasonRu: record.withdrawReasonRu,
      reopenedAt: record.reopenedAt ? new Date(record.reopenedAt).toISOString() : null,

      isOverdue:
        LAWYER_REVIEW_OPEN_STATUSES.includes(record.status) &&
        !!record.dueAt &&
        record.dueAt.getTime() < now.getTime(),
      daysUntilDue: record.dueAt ? daysUntil(record.dueAt, now) : null,
      daysUntilExpiry,
      isExpiringSoon:
        daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry <= timing.expiryWarnDays,
      blocksPublication:
        (record.blocksApproval && effectiveStatus !== RightsLawyerReviewStatus.APPROVED) ||
        counted.blockingConditions > 0,
      pendingConditionsCount: counted.pendingConditions,
      blockingConditionsCount: counted.blockingConditions,
      satisfiedConditionsCount: counted.satisfiedConditions,
      opinionsCount: counted.opinions,
      activeOpinionsCount: counted.activeOpinions,

      intakeTitle: record.rightsIntake?.candidateTitle ?? null,
      bookSlug: record.book?.slug ?? null,
      versionLanguage: record.bookVersion?.language ?? null,

      createdAt: new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
    };
  }

  private toDetailDto(record: RightsLawyerReviewRecord, now: Date): LawyerReviewDetailDto {
    const counters = new Map<string, ReviewCounters>([
      [record.id, countInline(record.conditions ?? [], record.opinions ?? [])],
    ]);

    return {
      ...this.toDto(record, counters, now),
      conditions: (record.conditions ?? []).map((condition) => toConditionDto(condition)),
      opinions: (record.opinions ?? []).map((opinion) => toOpinionDto(opinion)),
      events: (record.events ?? []).map((event) => toEventDto(event)),
      riskFactors: storedFactorsToDtos(record.riskFactors),
    };
  }
}

interface ReviewCounters {
  pendingConditions: number;
  blockingConditions: number;
  satisfiedConditions: number;
  opinions: number;
  activeOpinions: number;
}

const countInline = (
  conditions: RightsLawyerReviewConditionRecord[],
  opinions: RightsLegalOpinionRecord[],
): ReviewCounters => ({
  pendingConditions: conditions.filter(
    (condition) => condition.status === RightsLawyerConditionStatus.PENDING,
  ).length,
  blockingConditions: conditions.filter(
    (condition) => condition.status === RightsLawyerConditionStatus.PENDING && condition.isBlocking,
  ).length,
  satisfiedConditions: conditions.filter(
    (condition) => condition.status === RightsLawyerConditionStatus.SATISFIED,
  ).length,
  opinions: opinions.length,
  activeOpinions: opinions.filter((opinion) => !opinion.archivedAt).length,
});

export const toConditionDto = (record: RightsLawyerReviewConditionRecord): LawyerConditionDto => ({
  id: record.id,
  rightsLawyerReviewId: record.rightsLawyerReviewId,
  code: record.code,
  textRu: record.textRu,
  status: record.status,
  isBlocking: record.isBlocking,
  affectedCountryCodes: toStringArray(record.affectedCountryCodes),
  satisfiedAt: record.satisfiedAt ? new Date(record.satisfiedAt).toISOString() : null,
  satisfiedNotesRu: record.satisfiedNotesRu,
  waivedAt: record.waivedAt ? new Date(record.waivedAt).toISOString() : null,
  waiveReasonRu: record.waiveReasonRu,
  createdAt: new Date(record.createdAt).toISOString(),
});

export const toOpinionDto = (record: RightsLegalOpinionRecord): LegalOpinionDto => ({
  id: record.id,
  rightsLawyerReviewId: record.rightsLawyerReviewId,
  kind: record.kind,
  titleRu: record.titleRu,
  bodyRu: record.bodyRu,
  lawyerId: record.lawyerId,
  lawyerNameSnapshot: record.lawyerNameSnapshot,
  documentUrl: record.documentUrl,
  documentSha256: record.documentSha256,
  fileName: record.fileName,
  mimeType: record.mimeType,
  issuedAt: record.issuedAt ? new Date(record.issuedAt).toISOString() : null,
  jurisdictionCodes: toStringArray(record.jurisdictionCodes),
  rightsEvidenceId: record.rightsEvidenceId,
  archivedAt: record.archivedAt ? new Date(record.archivedAt).toISOString() : null,
  archiveReasonRu: record.archiveReasonRu,
  createdAt: new Date(record.createdAt).toISOString(),
});

const toEventDto = (record: RightsLawyerReviewEventRecord): LawyerReviewEventDto => ({
  id: record.id,
  eventType: record.eventType,
  fromStatus: record.fromStatus,
  toStatus: record.toStatus,
  messageRu: record.messageRu,
  payload: (record.payload as Record<string, unknown> | null) ?? null,
  createdByUserId: record.createdByUserId,
  createdAt: new Date(record.createdAt).toISOString(),
});

const reason = (
  code: string,
  messageRu: string,
  lawyerReviewId: string | null,
  details: Record<string, unknown> | null,
): LawyerGateReasonDto => ({ code, messageRu, lawyerReviewId, details });

const normaliseCountryCodes = (codes: string[] | undefined): string[] =>
  codes ? [...new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean))] : [];

const formatDate = (date: Date | null | undefined, fallback = 'бессрочно'): string =>
  date ? new Date(date).toISOString().slice(0, 10) : fallback;

const describeFactors = (factors: Array<{ messageRu: string }> | undefined): string => {
  if (!factors || factors.length === 0) return 'ручной запрос редактора';
  return factors
    .slice(0, 3)
    .map((factor) => factor.messageRu)
    .join(' ');
};

const buildDefaultQuestion = (factors: Array<{ messageRu: string }>): string =>
  `Можно ли публиковать это произведение с учётом выявленных факторов риска? ${describeFactors(factors)}`;

const buildContext = (
  riskLevel: RightsRiskLevel,
  factors: Array<{ code: string; messageRu: string }>,
): string =>
  [
    `Уровень риска: ${RISK_LEVEL_LABELS_RU[riskLevel]}.`,
    ...factors.map((factor) => `• ${factor.code}: ${factor.messageRu}`),
  ].join('\n');

/**
 * Reads the `riskFactors` JSON snapshot back into DTOs. The snapshot is a frozen picture of the
 * factors at request time, so unknown codes from an older release are passed through as they are
 * rather than dropped.
 */
const storedFactorsToDtos = (raw: unknown): RiskFactorDto[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      code: item['code'] as RightsRiskFactorCode,
      level: item['level'] as RightsRiskLevel,
      messageRu: typeof item['messageRu'] === 'string' ? item['messageRu'] : '',
      details:
        item['details'] && typeof item['details'] === 'object'
          ? (item['details'] as Record<string, unknown>)
          : null,
    }));
};
