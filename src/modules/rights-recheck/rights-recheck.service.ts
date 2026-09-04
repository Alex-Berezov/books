import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsService } from '../rights-agent/rights-notifications.service';
import {
  RightsNotificationSeverity,
  RightsNotificationType,
  type AgentDatabaseClient,
} from '../rights-agent/rights-agent-interface';
import {
  RECHECK_EMBEDDED_TASKS_LIMIT,
  RECHECK_ERROR_CODES,
  RECHECK_EVENT_DRIVEN_DUE_DAYS_DEFAULT,
  RECHECK_GATE_CODES,
  RECHECK_LEGAL_CHANGE_DUE_DAYS_DEFAULT,
  RECHECK_LIST_DEFAULT_LIMIT,
  RECHECK_LIST_MAX_LIMIT,
  RECHECK_MAX_SNOOZE_DAYS,
  RECHECK_OPEN_STATUSES,
  RECHECK_OVERDUE_GRACE_DAYS_DEFAULT,
  RECHECK_REASON_LABELS_RU,
  RECHECK_REMINDER_LEAD_DAYS_DEFAULT,
  RECHECK_RESOLUTION_LABELS_RU,
  RECHECK_SCAN_BATCH_SIZE_DEFAULT,
  RECHECK_VERSION_SCOPED_REASONS,
  RECHECK_DEFAULT_INTERVAL_DAYS,
} from './rights-recheck.constants';
import { recheckError } from './rights-recheck.errors';
import {
  RightsRecheckEventType,
  RightsRecheckPolicy,
  RightsRecheckReason,
  RightsRecheckResolution,
  RightsRecheckSeverity,
  RightsRecheckStatus,
  RightsRecheckTriggerSource,
  toCountryCodeArray,
} from './rights-recheck-interface';
import {
  addDays,
  computeScheduledDueAt,
  computeTaskSeverity,
  daysUntil,
  parseLeadDays,
  parsePositiveInt,
  type RecheckDateConfig,
} from './rights-recheck.util';
import type { CompleteRecheckTaskDto } from './dto/complete-recheck-task.dto';
import type { CreateRecheckTaskDto } from './dto/create-recheck-task.dto';
import type { DismissRecheckTaskDto } from './dto/dismiss-recheck-task.dto';
import type { ListRecheckTasksDto } from './dto/list-recheck-tasks.dto';
import type {
  RecheckScheduleDto,
  RecheckScheduleWithTasksDto,
  RecheckTaskDetailDto,
  RecheckTaskDto,
  RecheckTaskEventDto,
  RecheckTaskListResponseDto,
} from './dto/recheck-task-response.dto';
import type { SnoozeRecheckTaskDto } from './dto/snooze-recheck-task.dto';
import type { UpdateRecheckScheduleDto } from './dto/update-recheck-schedule.dto';
import type {
  RecheckGateEvaluationDto,
  RecheckGateReasonDto,
  VersionRecheckDto,
} from './dto/version-recheck-response.dto';
import type {
  RecheckDatabaseClient,
  RecheckProfileRecord,
  RightsRecheckEventRecord,
  RightsRecheckTaskRecord,
} from './rights-recheck-interface';

/** Everything `ensureTask` needs to create (or find) a task. */
export interface EnsureRecheckTaskInput {
  reason: RightsRecheckReason;
  source: RightsRecheckTriggerSource;
  titleRu: string;
  descriptionRu: string;
  dueAt: Date;
  severity?: RightsRecheckSeverity;
  rightsProfileId?: string | null;
  rightsIntakeId?: string | null;
  baselineReviewId?: string | null;
  bookId?: string | null;
  bookVersionId?: string | null;
  legalChangeEventId?: string | null;
  triggerCode?: string | null;
  affectedCountryCodes?: string[] | null;
  createdByUserId?: string | null;
  /** Mass operations (legal change apply) send one summary notification instead of N. */
  suppressNotification?: boolean;
}

export interface EnsureRecheckTaskResult {
  task: RightsRecheckTaskRecord;
  created: boolean;
}

interface RecordEventInput {
  eventType: RightsRecheckEventType;
  messageRu: string;
  fromStatus?: RightsRecheckStatus | null;
  toStatus?: RightsRecheckStatus | null;
  payload?: Record<string, unknown> | null;
  userId?: string | null;
}

/** Resolved Phase 18 runtime configuration. */
export interface RecheckRuntimeConfig extends RecheckDateConfig {
  legalChangeDueDays: number;
  eventDueDays: number;
  batchSize: number;
  blockPublishOnOverdue: boolean;
}

const CLOSED_STATUSES: readonly RightsRecheckStatus[] = [
  RightsRecheckStatus.COMPLETED,
  RightsRecheckStatus.DISMISSED,
];

/**
 * The recheck task is the single unit of work of Phase 18: schedule, content change,
 * language addition, legal change and manual requests all converge on it.
 * Tasks and their events are never physically deleted — closing is a status change.
 */
@Injectable()
export class RightsRecheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: RightsNotificationsService,
    private readonly config: ConfigService,
  ) {}

  private getDatabase(): RecheckDatabaseClient {
    return this.prisma as unknown as RecheckDatabaseClient;
  }

  /** Resolved once per call so tests can change env between assertions. */
  getRuntimeConfig(): RecheckRuntimeConfig {
    return {
      defaultIntervalDays: parsePositiveInt(
        this.config.get('RIGHTS_RECHECK_DEFAULT_INTERVAL_DAYS'),
        RECHECK_DEFAULT_INTERVAL_DAYS,
      ),
      leadDays: parseLeadDays(
        this.config.get<string>('RIGHTS_RECHECK_REMINDER_LEAD_DAYS'),
        RECHECK_REMINDER_LEAD_DAYS_DEFAULT,
      ),
      graceDays: parsePositiveInt(
        this.config.get('RIGHTS_RECHECK_OVERDUE_GRACE_DAYS'),
        RECHECK_OVERDUE_GRACE_DAYS_DEFAULT,
      ),
      legalChangeDueDays: parsePositiveInt(
        this.config.get('RIGHTS_RECHECK_LEGAL_CHANGE_DUE_DAYS'),
        RECHECK_LEGAL_CHANGE_DUE_DAYS_DEFAULT,
      ),
      eventDueDays: parsePositiveInt(
        this.config.get('RIGHTS_RECHECK_EVENT_DUE_DAYS'),
        RECHECK_EVENT_DRIVEN_DUE_DAYS_DEFAULT,
      ),
      batchSize: parsePositiveInt(
        this.config.get('RIGHTS_RECHECK_SCAN_BATCH_SIZE'),
        RECHECK_SCAN_BATCH_SIZE_DEFAULT,
      ),
      blockPublishOnOverdue:
        (this.config.get('RIGHTS_RECHECK_BLOCK_PUBLISH_ON_OVERDUE') ?? '1') !== '0',
    };
  }

  // ---------------------------------------------------------------------------
  // Task creation
  // ---------------------------------------------------------------------------

  /**
   * Idempotent task creation. Every trigger goes through here, so repeated scans, repeated
   * content-hash events and a re-applied legal change never produce duplicates.
   */
  async ensureTask(
    input: EnsureRecheckTaskInput,
    tx?: RecheckDatabaseClient,
  ): Promise<EnsureRecheckTaskResult> {
    const database = tx ?? this.getDatabase();

    const existing = await database.rightsRecheckTask.findFirst({
      where: this.buildDuplicateWhere(input),
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      // A newer trigger with an earlier deadline pulls the existing task forward.
      if (input.dueAt.getTime() < existing.dueAt.getTime()) {
        // LEGACY-036: без своего `tx` здесь работал корневой клиент, и перенос срока с записью
        // о нём шли двумя независимыми `await` — ни один из вызывающих `ensureTask` транзакции
        // не передаёт. Ветка создания задачи ниже такую транзакцию открывает, эта — не открывала.
        const moveDueDate = async (
          client: RecheckDatabaseClient,
        ): Promise<RightsRecheckTaskRecord> => {
          const moved = await client.rightsRecheckTask.update({
            where: { id: existing.id },
            data: { dueAt: input.dueAt },
          });
          await this.recordEvent(client, existing.id, {
            eventType: RightsRecheckEventType.DUE_DATE_CHANGED,
            messageRu: `Срок задачи перенесён на ${input.dueAt.toISOString()}.`,
            payload: {
              previousDueAt: existing.dueAt.toISOString(),
              dueAt: input.dueAt.toISOString(),
            },
          });
          return moved;
        };

        const moved = tx ? await moveDueDate(tx) : await database.$transaction(moveDueDate);
        return { task: moved, created: false };
      }
      return { task: existing, created: false };
    }

    const run = async (client: RecheckDatabaseClient): Promise<RightsRecheckTaskRecord> => {
      const task = await client.rightsRecheckTask.create({
        data: {
          reason: input.reason,
          source: input.source,
          severity: input.severity ?? RightsRecheckSeverity.INFO,
          status: RightsRecheckStatus.PENDING,
          rightsProfileId: input.rightsProfileId ?? null,
          rightsIntakeId: input.rightsIntakeId ?? null,
          baselineReviewId: input.baselineReviewId ?? null,
          bookId: input.bookId ?? null,
          bookVersionId: input.bookVersionId ?? null,
          legalChangeEventId: input.legalChangeEventId ?? null,
          titleRu: input.titleRu,
          descriptionRu: input.descriptionRu,
          triggerCode: input.triggerCode ?? null,
          affectedCountryCodes: input.affectedCountryCodes ?? undefined,
          dueAt: input.dueAt,
          createdByUserId: input.createdByUserId ?? null,
        },
      });

      await this.recordEvent(client, task.id, {
        eventType: RightsRecheckEventType.TASK_CREATED,
        toStatus: RightsRecheckStatus.PENDING,
        messageRu: `Открыта задача перепроверки: ${RECHECK_REASON_LABELS_RU[input.reason]}.`,
        payload: { reason: input.reason, source: input.source, dueAt: input.dueAt.toISOString() },
        userId: input.createdByUserId ?? null,
      });

      if (!input.suppressNotification) {
        const intakeTitle = await this.resolveIntakeTitle(client, input.rightsIntakeId ?? null);
        await this.notifications.create(
          {
            type: RightsNotificationType.RECHECK_TASK_OPENED,
            severity: RightsNotificationSeverity.INFO,
            titleRu: 'Открыта задача перепроверки прав',
            messageRu: `По интейку «${intakeTitle}» открыта задача перепроверки: ${RECHECK_REASON_LABELS_RU[input.reason]}. Срок — ${this.formatDate(input.dueAt)}.`,
            targetUserId: null,
            rightsIntakeId: input.rightsIntakeId ?? null,
            rightsProfileId: input.rightsProfileId ?? null,
            bookVersionId: input.bookVersionId ?? null,
            payload: { recheckTaskId: task.id, reason: input.reason },
          },
          client as unknown as AgentDatabaseClient,
        );
      }

      return task;
    };

    // Task, event and notification must land together.
    const task = tx ? await run(tx) : await database.$transaction(run);
    return { task, created: true };
  }

  /**
   * Deduplication key: always (profile, reason); additionally the version for version-scoped
   * reasons and the legal-change event for LEGAL_CHANGE.
   */
  private buildDuplicateWhere(input: EnsureRecheckTaskInput): Record<string, unknown> {
    const where: Record<string, unknown> = {
      status: { in: [...RECHECK_OPEN_STATUSES] },
      reason: input.reason,
      rightsProfileId: input.rightsProfileId ?? null,
    };

    if (RECHECK_VERSION_SCOPED_REASONS.includes(input.reason as never)) {
      where.bookVersionId = input.bookVersionId ?? null;
    }

    if (input.reason === RightsRecheckReason.LEGAL_CHANGE) {
      where.legalChangeEventId = input.legalChangeEventId ?? null;
    }

    // A task with no profile at all still must not duplicate for the same intake.
    if (!input.rightsProfileId && input.rightsIntakeId) {
      where.rightsIntakeId = input.rightsIntakeId;
    }

    return where;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async list(query: ListRecheckTasksDto): Promise<RecheckTaskListResponseDto> {
    const database = this.getDatabase();
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit =
      query.limit && query.limit > 0
        ? Math.min(query.limit, RECHECK_LIST_MAX_LIMIT)
        : RECHECK_LIST_DEFAULT_LIMIT;

    const where = this.buildListWhere(query, new Date());

    const [total, items] = await Promise.all([
      database.rightsRecheckTask.count({ where }),
      database.rightsRecheckTask.findMany({
        where,
        orderBy: [{ severity: 'desc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const now = new Date();
    const config = this.getRuntimeConfig();
    return {
      items: items.map((item) => this.toTaskDto(item, now, config)),
      total,
      page,
      limit,
    };
  }

  private buildListWhere(query: ListRecheckTasksDto, now: Date): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.reason) where.reason = query.reason;
    if (query.severity) where.severity = query.severity;
    if (query.source) where.source = query.source;
    if (query.rightsIntakeId) where.rightsIntakeId = query.rightsIntakeId;
    if (query.rightsProfileId) where.rightsProfileId = query.rightsProfileId;
    if (query.bookId) where.bookId = query.bookId;
    if (query.bookVersionId) where.bookVersionId = query.bookVersionId;
    if (query.legalChangeEventId) where.legalChangeEventId = query.legalChangeEventId;

    if (query.overdueOnly) {
      where.status = { in: [...RECHECK_OPEN_STATUSES] };
      where.dueAt = { lt: now };
    } else if (query.dueWithinDays !== undefined) {
      where.status = { in: [...RECHECK_OPEN_STATUSES] };
      where.dueAt = { lte: addDays(now, query.dueWithinDays) };
    }

    return where;
  }

  async getById(taskId: string): Promise<RecheckTaskDetailDto> {
    const database = this.getDatabase();
    const task = await database.rightsRecheckTask.findUnique({
      where: { id: taskId },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });

    if (!task) {
      throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.RECHECK_TASK_NOT_FOUND);
    }

    const now = new Date();
    const config = this.getRuntimeConfig();
    return {
      ...this.toTaskDto(task, now, config),
      events: (task.events ?? []).map((event) => this.toEventDto(event)),
      targets: await this.loadTargets(database, task),
    };
  }

  async listByIntake(
    intakeId: string,
    query: ListRecheckTasksDto,
  ): Promise<RecheckTaskListResponseDto> {
    await this.assertIntakeExists(intakeId);
    return this.list({ ...query, rightsIntakeId: intakeId });
  }

  // ---------------------------------------------------------------------------
  // Manual creation and lifecycle transitions
  // ---------------------------------------------------------------------------

  async createManual(dto: CreateRecheckTaskDto, userId: string): Promise<RecheckTaskDetailDto> {
    if (!dto.rightsProfileId && !dto.rightsIntakeId && !dto.bookVersionId) {
      throw recheckError(HttpStatus.BAD_REQUEST, RECHECK_ERROR_CODES.RECHECK_TARGET_REQUIRED);
    }

    const database = this.getDatabase();
    const config = this.getRuntimeConfig();

    // SCHEDULED_DUE belongs to the scheduler alone — a manual request never claims it.
    const reason =
      dto.reason && dto.reason !== RightsRecheckReason.SCHEDULED_DUE
        ? dto.reason
        : RightsRecheckReason.MANUAL_REQUEST;

    const targets = await this.resolveTargets(database, dto);

    const { task } = await this.ensureTask({
      reason,
      source: RightsRecheckTriggerSource.MANUAL,
      severity: dto.severity ?? RightsRecheckSeverity.WARNING,
      titleRu: dto.titleRu,
      descriptionRu: dto.descriptionRu,
      dueAt: dto.dueAt ? new Date(dto.dueAt) : addDays(new Date(), config.eventDueDays),
      rightsProfileId: targets.rightsProfileId,
      rightsIntakeId: targets.rightsIntakeId,
      baselineReviewId: targets.baselineReviewId,
      bookId: targets.bookId,
      bookVersionId: targets.bookVersionId,
      createdByUserId: userId,
    });

    return this.getById(task.id);
  }

  async start(taskId: string, userId: string): Promise<RecheckTaskDetailDto> {
    const database = this.getDatabase();
    const task = await this.loadOpenTask(database, taskId);

    if (task.status !== RightsRecheckStatus.PENDING) {
      throw recheckError(HttpStatus.CONFLICT, RECHECK_ERROR_CODES.RECHECK_TASK_INVALID_TRANSITION, {
        status: task.status,
      });
    }

    await database.$transaction(async (client) => {
      await client.rightsRecheckTask.update({
        where: { id: taskId },
        data: {
          status: RightsRecheckStatus.IN_PROGRESS,
          startedAt: new Date(),
          startedByUserId: userId,
        },
      });
      await this.recordEvent(client, taskId, {
        eventType: RightsRecheckEventType.STARTED,
        fromStatus: task.status,
        toStatus: RightsRecheckStatus.IN_PROGRESS,
        messageRu: 'Задача взята в работу.',
        userId,
      });
    });

    return this.getById(taskId);
  }

  async complete(
    taskId: string,
    dto: CompleteRecheckTaskDto,
    userId: string | null,
  ): Promise<RecheckTaskDetailDto> {
    const database = this.getDatabase();
    const task = await this.loadOpenTask(database, taskId);

    if (dto.completedReviewId) {
      const review = await database.rightsReview.findUnique({
        where: { id: dto.completedReviewId },
        select: { id: true },
      });
      if (!review) {
        throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.RECHECK_REVIEW_NOT_FOUND);
      }
    }

    const resolution = dto.resolution ?? RightsRecheckResolution.MANUALLY_CLOSED;

    await database.$transaction(async (client) => {
      await this.closeTask(client, task, {
        resolution,
        completedReviewId: dto.completedReviewId ?? null,
        completionNotesRu: dto.notesRu ?? null,
        userId,
      });
    });

    return this.getById(taskId);
  }

  async dismiss(
    taskId: string,
    dto: DismissRecheckTaskDto,
    userId: string,
  ): Promise<RecheckTaskDetailDto> {
    const database = this.getDatabase();
    const task = await this.loadOpenTask(database, taskId);

    await database.$transaction(async (client) => {
      await client.rightsRecheckTask.update({
        where: { id: taskId },
        data: {
          status: RightsRecheckStatus.DISMISSED,
          dismissedAt: new Date(),
          dismissedByUserId: userId,
          dismissReasonRu: dto.reasonRu,
          resolution: RightsRecheckResolution.DISMISSED_NOT_APPLICABLE,
        },
      });
      await this.recordEvent(client, taskId, {
        eventType: RightsRecheckEventType.DISMISSED,
        fromStatus: task.status,
        toStatus: RightsRecheckStatus.DISMISSED,
        messageRu: `Задача отклонена: ${dto.reasonRu}`,
        userId,
      });
    });

    return this.getById(taskId);
  }

  /** Admin-only: brings a closed task back into the queue. */
  async reopen(taskId: string, userId: string): Promise<RecheckTaskDetailDto> {
    const database = this.getDatabase();
    const task = await database.rightsRecheckTask.findUnique({ where: { id: taskId } });
    if (!task) {
      throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.RECHECK_TASK_NOT_FOUND);
    }

    if (!CLOSED_STATUSES.includes(task.status)) {
      throw recheckError(HttpStatus.CONFLICT, RECHECK_ERROR_CODES.RECHECK_TASK_INVALID_TRANSITION, {
        status: task.status,
      });
    }

    await database.$transaction(async (client) => {
      await client.rightsRecheckTask.update({
        where: { id: taskId },
        data: {
          status: RightsRecheckStatus.PENDING,
          completedAt: null,
          completedByUserId: null,
          completedReviewId: null,
          dismissedAt: null,
          dismissedByUserId: null,
          resolution: null,
        },
      });
      await this.recordEvent(client, taskId, {
        eventType: RightsRecheckEventType.REOPENED,
        fromStatus: task.status,
        toStatus: RightsRecheckStatus.PENDING,
        messageRu: 'Задача возвращена в работу.',
        userId,
      });
    });

    return this.getById(taskId);
  }

  async snooze(
    taskId: string,
    dto: SnoozeRecheckTaskDto,
    userId: string,
  ): Promise<RecheckTaskDetailDto> {
    const database = this.getDatabase();
    // Guard only: snoozing a closed task is a 409, and the record itself is not needed here.
    await this.loadOpenTask(database, taskId);

    const until = new Date(dto.until);
    const now = new Date();
    const maxUntil = addDays(now, RECHECK_MAX_SNOOZE_DAYS);
    if (Number.isNaN(until.getTime()) || until <= now || until > maxUntil) {
      throw recheckError(HttpStatus.BAD_REQUEST, RECHECK_ERROR_CODES.RECHECK_INVALID_SNOOZE_DATE, {
        maxSnoozeDays: RECHECK_MAX_SNOOZE_DAYS,
      });
    }

    await database.$transaction(async (client) => {
      await client.rightsRecheckTask.update({
        where: { id: taskId },
        data: { snoozedUntil: until, snoozeReasonRu: dto.reasonRu ?? null },
      });
      await this.recordEvent(client, taskId, {
        eventType: RightsRecheckEventType.SNOOZED,
        messageRu: `Напоминания отложены до ${this.formatDate(until)}.`,
        payload: { snoozedUntil: until.toISOString() },
        userId,
      });
    });

    return this.getById(taskId);
  }

  // ---------------------------------------------------------------------------
  // Schedule
  // ---------------------------------------------------------------------------

  async getScheduleForProfile(profileId: string): Promise<RecheckScheduleWithTasksDto> {
    const database = this.getDatabase();
    const profile = await this.loadProfile(database, profileId);
    const config = this.getRuntimeConfig();
    const now = new Date();

    const openTasks = await database.rightsRecheckTask.findMany({
      where: { rightsProfileId: profileId, status: { in: [...RECHECK_OPEN_STATUSES] } },
      orderBy: [{ severity: 'desc' }, { dueAt: 'asc' }],
      take: RECHECK_EMBEDDED_TASKS_LIMIT,
    });

    const schedule = await this.buildScheduleDto(database, profile, config, now, openTasks.length);
    return { ...schedule, openTasks: openTasks.map((task) => this.toTaskDto(task, now, config)) };
  }

  async updateSchedule(
    profileId: string,
    dto: UpdateRecheckScheduleDto,
    userId: string,
  ): Promise<RecheckScheduleWithTasksDto> {
    const database = this.getDatabase();
    await this.loadProfile(database, profileId);

    const data: Record<string, unknown> = {};
    if (dto.nextReviewAt !== undefined) {
      data.nextReviewAt = dto.nextReviewAt ? new Date(dto.nextReviewAt) : null;
    }
    if (dto.recheckPolicy !== undefined) data.recheckPolicy = dto.recheckPolicy;
    if (dto.recheckIntervalDays !== undefined) data.recheckIntervalDays = dto.recheckIntervalDays;
    if (dto.recheckPausedUntil !== undefined) {
      data.recheckPausedUntil = dto.recheckPausedUntil ? new Date(dto.recheckPausedUntil) : null;
    }
    if (dto.recheckPauseReasonRu !== undefined) {
      data.recheckPauseReasonRu = dto.recheckPauseReasonRu;
    }

    if (Object.keys(data).length > 0) {
      await database.rightsProfile.update({ where: { id: profileId }, data });
    }

    void userId;
    return this.getScheduleForProfile(profileId);
  }

  private async buildScheduleDto(
    database: RecheckDatabaseClient,
    profile: RecheckProfileRecord,
    config: RecheckRuntimeConfig,
    now: Date,
    openTasksCount: number,
  ): Promise<RecheckScheduleDto> {
    const approvedReview = await this.findApprovedReview(database, profile.id);
    const computedDueAt = computeScheduledDueAt(profile, approvedReview, config, now);

    return {
      rightsProfileId: profile.id,
      recheckPolicy: profile.recheckPolicy ?? RightsRecheckPolicy.INHERIT_REPORT,
      recheckIntervalDays: profile.recheckIntervalDays ?? null,
      nextReviewAt: this.toIso(profile.nextReviewAt),
      recheckPausedUntil: this.toIso(profile.recheckPausedUntil),
      recheckPauseReasonRu: profile.recheckPauseReasonRu ?? null,
      lastRecheckScanAt: this.toIso(profile.lastRecheckScanAt),
      computedDueAt: this.toIso(computedDueAt),
      openTasksCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Publication gate integration
  // ---------------------------------------------------------------------------

  /**
   * Phase 18 contribution to the publication gate. Existing gate codes are untouched —
   * this only adds `RIGHTS_RECHECK_*` reasons.
   */
  async evaluateVersionRecheck(versionId: string): Promise<RecheckGateEvaluationDto> {
    const database = this.getDatabase();
    const version = await database.bookVersion.findUnique({
      where: { id: versionId },
      select: { id: true, rightsProfileId: true },
    });

    if (!version) {
      throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.RECHECK_VERSION_NOT_FOUND);
    }

    const now = new Date();
    const config = this.getRuntimeConfig();
    const tasks = await this.findVersionTasks(database, versionId, version.rightsProfileId ?? null);

    const blockers: RecheckGateReasonDto[] = [];
    const warnings: RecheckGateReasonDto[] = [];

    let overdueTasksCount = 0;
    let blockingTasksCount = 0;
    let nextDueAt: Date | null = null;

    for (const task of tasks) {
      const effectiveSeverity = computeTaskSeverity(task, now, config.graceDays);
      const isSnoozed = task.snoozedUntil !== null && task.snoozedUntil.getTime() > now.getTime();
      const isOverdue = task.dueAt.getTime() < now.getTime();

      if (isOverdue) overdueTasksCount += 1;
      if (effectiveSeverity === RightsRecheckSeverity.BLOCKING) blockingTasksCount += 1;
      if (!nextDueAt || task.dueAt.getTime() < nextDueAt.getTime()) nextDueAt = task.dueAt;

      // A snoozed task never blocks: the editor has explicitly deferred it.
      if (isSnoozed) {
        warnings.push(
          this.gateReason(
            RECHECK_GATE_CODES.RIGHTS_RECHECK_TASK_SNOOZED,
            `Задача перепроверки отложена до ${this.formatDate(task.snoozedUntil as Date)}: ${task.titleRu}`,
            task.id,
            { reason: task.reason, snoozedUntil: (task.snoozedUntil as Date).toISOString() },
          ),
        );
        continue;
      }

      if (
        task.reason === RightsRecheckReason.LEGAL_CHANGE &&
        effectiveSeverity === RightsRecheckSeverity.BLOCKING
      ) {
        blockers.push(
          this.gateReason(
            RECHECK_GATE_CODES.RIGHTS_RECHECK_LEGAL_CHANGE_PENDING,
            `Изменение законодательства требует перепроверки прав: ${task.titleRu}`,
            task.id,
            { reason: task.reason, legalChangeEventId: task.legalChangeEventId },
          ),
        );
        continue;
      }

      if (effectiveSeverity === RightsRecheckSeverity.BLOCKING) {
        const reason = this.gateReason(
          RECHECK_GATE_CODES.RIGHTS_RECHECK_OVERDUE,
          `Перепроверка прав просрочена: ${task.titleRu} (срок ${this.formatDate(task.dueAt)}).`,
          task.id,
          { reason: task.reason, dueAt: task.dueAt.toISOString() },
        );
        if (config.blockPublishOnOverdue) {
          blockers.push(reason);
        } else {
          warnings.push(reason);
        }
        continue;
      }

      if (isOverdue) {
        warnings.push(
          this.gateReason(
            RECHECK_GATE_CODES.RIGHTS_RECHECK_DUE,
            `Срок перепроверки прав прошёл: ${task.titleRu} (срок ${this.formatDate(task.dueAt)}).`,
            task.id,
            { reason: task.reason, dueAt: task.dueAt.toISOString() },
          ),
        );
        continue;
      }

      warnings.push(
        this.gateReason(
          RECHECK_GATE_CODES.RIGHTS_RECHECK_TASK_OPEN,
          `Открыта задача перепроверки прав: ${task.titleRu} (срок ${this.formatDate(task.dueAt)}).`,
          task.id,
          { reason: task.reason, dueAt: task.dueAt.toISOString() },
        ),
      );
    }

    // No open task, but the planned date is already within the final lead window.
    if (tasks.length === 0 && version.rightsProfileId) {
      const profile = await database.rightsProfile.findUnique({
        where: { id: version.rightsProfileId },
      });
      if (profile) {
        const approvedReview = await this.findApprovedReview(database, profile.id);
        const computedDueAt = computeScheduledDueAt(profile, approvedReview, config, now);
        const finalLead = config.leadDays[config.leadDays.length - 1] ?? 7;
        if (computedDueAt && computedDueAt.getTime() <= addDays(now, finalLead).getTime()) {
          nextDueAt = computedDueAt;
          warnings.push(
            this.gateReason(
              RECHECK_GATE_CODES.RIGHTS_RECHECK_DUE_SOON,
              `Приближается плановый срок перепроверки прав: ${this.formatDate(computedDueAt)}.`,
              null,
              { computedDueAt: computedDueAt.toISOString() },
            ),
          );
        }
      }
    }

    return {
      versionId,
      blockers,
      warnings,
      openTasksCount: tasks.length,
      overdueTasksCount,
      blockingTasksCount,
      nextRecheckDueAt: this.toIso(nextDueAt),
      taskIds: tasks.map((task) => task.id),
    };
  }

  /** `GET /admin/versions/:id/recheck` — the evaluation plus everything the UI renders. */
  async getVersionRecheck(versionId: string): Promise<VersionRecheckDto> {
    const database = this.getDatabase();
    const evaluation = await this.evaluateVersionRecheck(versionId);

    const version = await database.bookVersion.findUnique({
      where: { id: versionId },
      select: { id: true, rightsProfileId: true },
    });

    const now = new Date();
    const config = this.getRuntimeConfig();

    const tasks = await database.rightsRecheckTask.findMany({
      where: this.versionTasksWhere(versionId, version?.rightsProfileId ?? null),
      orderBy: [{ severity: 'desc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
      take: RECHECK_EMBEDDED_TASKS_LIMIT,
    });

    let schedule: RecheckScheduleDto | null = null;
    if (version?.rightsProfileId) {
      const profile = await database.rightsProfile.findUnique({
        where: { id: version.rightsProfileId },
      });
      if (profile) {
        const openTasksCount = await database.rightsRecheckTask.count({
          where: {
            rightsProfileId: profile.id,
            status: { in: [...RECHECK_OPEN_STATUSES] },
          },
        });
        schedule = await this.buildScheduleDto(database, profile, config, now, openTasksCount);
      }
    }

    return {
      ...evaluation,
      tasks: tasks.map((task) => this.toTaskDto(task, now, config)),
      schedule,
    };
  }

  /** Open tasks of the version itself plus profile-wide tasks that are not version-scoped. */
  private versionTasksWhere(versionId: string, profileId: string | null): Record<string, unknown> {
    const targets: Record<string, unknown>[] = [{ bookVersionId: versionId }];
    if (profileId) {
      targets.push({ rightsProfileId: profileId, bookVersionId: null });
    }
    return { status: { in: [...RECHECK_OPEN_STATUSES] }, OR: targets };
  }

  private findVersionTasks(
    database: RecheckDatabaseClient,
    versionId: string,
    profileId: string | null,
  ): Promise<RightsRecheckTaskRecord[]> {
    return database.rightsRecheckTask.findMany({
      where: this.versionTasksWhere(versionId, profileId),
      orderBy: [{ severity: 'desc' }, { dueAt: 'asc' }],
      take: RECHECK_EMBEDDED_TASKS_LIMIT,
    });
  }

  // ---------------------------------------------------------------------------
  // Shared helpers used by the scheduler
  // ---------------------------------------------------------------------------

  /** Writes a task event. Always called inside the transaction that made the mutation. */
  async recordEvent(
    client: RecheckDatabaseClient,
    taskId: string,
    input: RecordEventInput,
  ): Promise<void> {
    await client.rightsRecheckEvent.create({
      data: {
        recheckTaskId: taskId,
        eventType: input.eventType,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        messageRu: input.messageRu,
        payload: input.payload ?? undefined,
        createdByUserId: input.userId ?? null,
      },
    });
  }

  /** Shared close path: used by `complete` and by the scheduler's auto-close step. */
  async closeTask(
    client: RecheckDatabaseClient,
    task: RightsRecheckTaskRecord,
    options: {
      resolution: RightsRecheckResolution;
      completedReviewId?: string | null;
      completionNotesRu?: string | null;
      userId: string | null;
      notify?: boolean;
    },
  ): Promise<void> {
    await client.rightsRecheckTask.update({
      where: { id: task.id },
      data: {
        status: RightsRecheckStatus.COMPLETED,
        completedAt: new Date(),
        completedByUserId: options.userId,
        completionNotesRu: options.completionNotesRu ?? null,
        completedReviewId: options.completedReviewId ?? null,
        resolution: options.resolution,
      },
    });

    await this.recordEvent(client, task.id, {
      eventType: RightsRecheckEventType.COMPLETED,
      fromStatus: task.status,
      toStatus: RightsRecheckStatus.COMPLETED,
      messageRu: `Задача закрыта: ${RECHECK_RESOLUTION_LABELS_RU[options.resolution]}.`,
      payload: { resolution: options.resolution },
      userId: options.userId,
    });

    if (options.completedReviewId) {
      await this.recordEvent(client, task.id, {
        eventType: RightsRecheckEventType.LINKED_TO_REVIEW,
        messageRu: 'Задача связана с проверкой прав.',
        payload: { reviewId: options.completedReviewId },
        userId: options.userId,
      });
    }

    if (options.notify !== false) {
      const intakeTitle = await this.resolveIntakeTitle(client, task.rightsIntakeId);
      await this.notifications.create(
        {
          type: RightsNotificationType.RECHECK_COMPLETED,
          severity: RightsNotificationSeverity.SUCCESS,
          titleRu: 'Задача перепроверки закрыта',
          messageRu: `Задача перепроверки по интейку «${intakeTitle}» закрыта: ${RECHECK_RESOLUTION_LABELS_RU[options.resolution]}.`,
          targetUserId: null,
          rightsIntakeId: task.rightsIntakeId,
          rightsProfileId: task.rightsProfileId,
          bookVersionId: task.bookVersionId,
          payload: { recheckTaskId: task.id, resolution: options.resolution },
        },
        client as unknown as AgentDatabaseClient,
      );
    }
  }

  /** The approved review of a profile, or the most recent one when nothing is approved yet. */
  async findApprovedReview(
    database: RecheckDatabaseClient,
    profileId: string,
  ): Promise<{ id: string; approvedAt: Date | null; nextReviewAt: Date | null } | null> {
    const approved = await database.rightsReview.findFirst({
      where: { rightsProfileId: profileId, status: 'HUMAN_APPROVED' },
      orderBy: { approvedAt: 'desc' },
      select: { id: true, approvedAt: true, nextReviewAt: true },
    });
    return approved ?? null;
  }

  // ---------------------------------------------------------------------------
  // Mapping
  // ---------------------------------------------------------------------------

  toTaskDto(task: RightsRecheckTaskRecord, now: Date, config: RecheckDateConfig): RecheckTaskDto {
    const isOpen = (RECHECK_OPEN_STATUSES as readonly RightsRecheckStatus[]).includes(task.status);
    return {
      id: task.id,
      reason: task.reason,
      reasonRu: RECHECK_REASON_LABELS_RU[task.reason] ?? task.reason,
      status: task.status,
      severity: task.severity,
      source: task.source,
      rightsProfileId: task.rightsProfileId,
      rightsIntakeId: task.rightsIntakeId,
      baselineReviewId: task.baselineReviewId,
      bookId: task.bookId,
      bookVersionId: task.bookVersionId,
      legalChangeEventId: task.legalChangeEventId,
      titleRu: task.titleRu,
      descriptionRu: task.descriptionRu,
      triggerCode: task.triggerCode,
      affectedCountryCodes: toCountryCodeArray(task.affectedCountryCodes),
      dueAt: new Date(task.dueAt).toISOString(),
      reminderStage: task.reminderStage,
      remindersSentCount: task.remindersSentCount,
      lastReminderAt: this.toIso(task.lastReminderAt),
      snoozedUntil: this.toIso(task.snoozedUntil),
      snoozeReasonRu: task.snoozeReasonRu,
      startedAt: this.toIso(task.startedAt),
      startedByUserId: task.startedByUserId,
      completedAt: this.toIso(task.completedAt),
      completedByUserId: task.completedByUserId,
      completionNotesRu: task.completionNotesRu,
      completedReviewId: task.completedReviewId,
      dismissedAt: this.toIso(task.dismissedAt),
      dismissedByUserId: task.dismissedByUserId,
      dismissReasonRu: task.dismissReasonRu,
      resolution: task.resolution,
      resolutionRu: task.resolution ? RECHECK_RESOLUTION_LABELS_RU[task.resolution] : null,
      createdByUserId: task.createdByUserId,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      isOpen,
      isOverdue: isOpen && new Date(task.dueAt).getTime() < now.getTime(),
      daysUntilDue: daysUntil(new Date(task.dueAt), now),
      isSnoozed:
        task.snoozedUntil !== null && new Date(task.snoozedUntil).getTime() > now.getTime(),
      effectiveSeverity: computeTaskSeverity(
        { reason: task.reason, severity: task.severity, dueAt: new Date(task.dueAt) },
        now,
        config.graceDays,
      ),
    };
  }

  private toEventDto(event: RightsRecheckEventRecord): RecheckTaskEventDto {
    return {
      id: event.id,
      eventType: event.eventType,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      messageRu: event.messageRu,
      payload: (event.payload as Record<string, unknown> | null) ?? null,
      createdByUserId: event.createdByUserId,
      createdAt: new Date(event.createdAt).toISOString(),
    };
  }

  private gateReason(
    code: string,
    messageRu: string,
    taskId: string | null,
    details?: Record<string, unknown>,
  ): RecheckGateReasonDto {
    return { code, messageRu, taskId, details: details ?? null };
  }

  // ---------------------------------------------------------------------------
  // Internal lookups
  // ---------------------------------------------------------------------------

  private async loadOpenTask(
    database: RecheckDatabaseClient,
    taskId: string,
  ): Promise<RightsRecheckTaskRecord> {
    const task = await database.rightsRecheckTask.findUnique({ where: { id: taskId } });
    if (!task) {
      throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.RECHECK_TASK_NOT_FOUND);
    }
    if (CLOSED_STATUSES.includes(task.status)) {
      throw recheckError(HttpStatus.CONFLICT, RECHECK_ERROR_CODES.RECHECK_TASK_ALREADY_CLOSED, {
        status: task.status,
      });
    }
    return task;
  }

  private async loadProfile(
    database: RecheckDatabaseClient,
    profileId: string,
  ): Promise<RecheckProfileRecord> {
    const profile = await database.rightsProfile.findUnique({ where: { id: profileId } });
    if (!profile) {
      throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.RECHECK_PROFILE_NOT_FOUND);
    }
    return profile;
  }

  private async assertIntakeExists(intakeId: string): Promise<void> {
    const intake = await this.getDatabase().rightsIntake.findUnique({
      where: { id: intakeId },
      select: { id: true, candidateTitle: true, workflowStatus: true },
    });
    if (!intake) {
      throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.RECHECK_INTAKE_NOT_FOUND);
    }
  }

  /** Fills in the links the caller did not supply: profile → intake, version → book/profile. */
  private async resolveTargets(
    database: RecheckDatabaseClient,
    dto: CreateRecheckTaskDto,
  ): Promise<{
    rightsProfileId: string | null;
    rightsIntakeId: string | null;
    bookId: string | null;
    bookVersionId: string | null;
    baselineReviewId: string | null;
  }> {
    let rightsProfileId = dto.rightsProfileId ?? null;
    let rightsIntakeId = dto.rightsIntakeId ?? null;
    let bookId: string | null = null;
    let baselineReviewId: string | null = null;

    if (dto.bookVersionId) {
      const version = await database.bookVersion.findUnique({
        where: { id: dto.bookVersionId },
        select: {
          id: true,
          bookId: true,
          rightsProfileId: true,
          approvedRightsReviewId: true,
        },
      });
      if (!version) {
        throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.RECHECK_VERSION_NOT_FOUND);
      }
      bookId = version.bookId;
      rightsProfileId = rightsProfileId ?? version.rightsProfileId;
      baselineReviewId = version.approvedRightsReviewId;
    }

    if (rightsProfileId) {
      const profile = await this.loadProfile(database, rightsProfileId);
      rightsIntakeId = rightsIntakeId ?? profile.rightsIntakeId;
      if (!baselineReviewId) {
        const approved = await this.findApprovedReview(database, rightsProfileId);
        baselineReviewId = approved?.id ?? null;
      }
    }

    if (rightsIntakeId) {
      await this.assertIntakeExists(rightsIntakeId);
    }

    return {
      rightsProfileId,
      rightsIntakeId,
      bookId,
      bookVersionId: dto.bookVersionId ?? null,
      baselineReviewId,
    };
  }

  private async loadTargets(
    database: RecheckDatabaseClient,
    task: RightsRecheckTaskRecord,
  ): Promise<RecheckTaskDetailDto['targets']> {
    const targets: RecheckTaskDetailDto['targets'] = {};

    if (task.rightsIntakeId) {
      const intake = await database.rightsIntake.findUnique({
        where: { id: task.rightsIntakeId },
        select: { id: true, candidateTitle: true, workflowStatus: true },
      });
      targets.intakeTitle = intake?.candidateTitle ?? null;
      targets.intakeStatus = intake?.workflowStatus ?? null;
    }

    if (task.rightsProfileId) {
      const profile = await database.rightsProfile.findUnique({
        where: { id: task.rightsProfileId },
      });
      targets.profileStatus = profile?.status ?? null;
    }

    if (task.bookVersionId) {
      const version = await database.bookVersion.findUnique({
        where: { id: task.bookVersionId },
        select: { id: true, language: true, title: true },
      });
      targets.versionLanguage = version?.language ?? null;
      targets.versionTitle = version?.title ?? null;
    }

    return targets;
  }

  /** Notification texts name the intake; falls back to a neutral label when it is unknown. */
  private async resolveIntakeTitle(
    database: RecheckDatabaseClient,
    intakeId: string | null,
  ): Promise<string> {
    if (!intakeId) return 'без интейка';
    const intake = await database.rightsIntake.findUnique({
      where: { id: intakeId },
      select: { id: true, candidateTitle: true, workflowStatus: true },
    });
    return intake?.candidateTitle ?? 'без интейка';
  }

  private toIso(value: Date | null | undefined): string | null {
    return value ? new Date(value).toISOString() : null;
  }

  private formatDate(value: Date): string {
    return new Date(value).toISOString().slice(0, 10);
  }
}
