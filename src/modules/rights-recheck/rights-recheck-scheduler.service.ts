import { HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsService } from '../rights-agent/rights-notifications.service';
import {
  RightsNotificationSeverity,
  RightsNotificationType,
} from '../rights-agent/rights-agent-interface';
import {
  RECHECK_CONTENT_DRIVEN_REASONS,
  RECHECK_ERROR_CODES,
  RECHECK_LIST_DEFAULT_LIMIT,
  RECHECK_LIST_MAX_LIMIT,
  RECHECK_OPEN_STATUSES,
  RECHECK_SCAN_INITIAL_DELAY_MS_DEFAULT,
  RECHECK_SCAN_INTERVAL_MS_DEFAULT,
  RECHECK_SCHEDULABLE_PROFILE_STATUSES,
} from './rights-recheck.constants';
import { recheckError } from './rights-recheck.errors';
import { RightsRecheckService, type RecheckRuntimeConfig } from './rights-recheck.service';
import {
  RightsRecheckEventType,
  RightsRecheckReason,
  RightsRecheckReminderStage,
  RightsRecheckResolution,
  RightsRecheckScanStatus,
  RightsRecheckTriggerSource,
} from './rights-recheck-interface';
import {
  addDays,
  computeReminderStage,
  computeScheduledDueAt,
  computeTaskSeverity,
  daysUntil,
  parsePositiveInt,
  reminderStageRank,
  severityRank,
  staleReasonToRecheckReason,
} from './rights-recheck.util';
import type { ListScanRunsDto } from './dto/list-scan-runs.dto';
import type {
  RecheckScanRunDto,
  RecheckScanRunListResponseDto,
} from './dto/recheck-scan-response.dto';
import type {
  RecheckDatabaseClient,
  RightsRecheckScanRunRecord,
  RightsRecheckTaskRecord,
} from './rights-recheck-interface';

interface ScanCounters {
  profilesScanned: number;
  versionsScanned: number;
  tasksCreated: number;
  tasksEscalated: number;
  tasksAutoClosed: number;
  remindersSent: number;
}

/** Notification type and severity per reminder stage (§3.3 of the Phase 18 spec). */
const REMINDER_NOTIFICATION: Partial<
  Record<
    RightsRecheckReminderStage,
    { type: RightsNotificationType; severity: RightsNotificationSeverity; titleRu: string }
  >
> = {
  [RightsRecheckReminderStage.LEAD_30]: {
    type: RightsNotificationType.RECHECK_DUE,
    severity: RightsNotificationSeverity.INFO,
    titleRu: 'Приближается срок перепроверки прав',
  },
  [RightsRecheckReminderStage.LEAD_7]: {
    type: RightsNotificationType.RECHECK_DUE,
    severity: RightsNotificationSeverity.INFO,
    titleRu: 'Приближается срок перепроверки прав',
  },
  [RightsRecheckReminderStage.DUE]: {
    type: RightsNotificationType.RECHECK_DUE,
    severity: RightsNotificationSeverity.WARNING,
    titleRu: 'Наступил срок перепроверки прав',
  },
  [RightsRecheckReminderStage.OVERDUE]: {
    type: RightsNotificationType.RECHECK_OVERDUE,
    severity: RightsNotificationSeverity.WARNING,
    titleRu: 'Перепроверка прав просрочена',
  },
  [RightsRecheckReminderStage.ESCALATED]: {
    type: RightsNotificationType.RECHECK_OVERDUE,
    severity: RightsNotificationSeverity.ERROR,
    titleRu: 'Перепроверка прав просрочена',
  },
};

/**
 * In-process scan that turns dates and Phase 8 staleness flags into recheck tasks.
 *
 * Why `setInterval` and not `@nestjs/schedule` or BullMQ:
 * - `@nestjs/schedule` is not a dependency of this project and Phase 18 adds none;
 * - BullMQ exists, but Redis is optional in this deployment (`QueueModule` yields
 *   undefined providers without `REDIS_URL`/`REDIS_HOST`) — the rights scheduler must not
 *   silently switch itself off when Redis is absent;
 * - the application runs in a single container. Under horizontal scaling two instances would
 *   scan concurrently: safe, because every scan operation is idempotent (`ensureTask`
 *   deduplicates, reminders only fire on a stage increase), but wasteful. Recorded as a known
 *   limitation in `ai-context/legacy-warnings.md`; not fixed in this phase.
 *
 * The scan is a pull model on purpose: `RightsContentHashService` lives in `RightsIntakeModule`,
 * which must not import `RightsRecheckModule` (that would be a module cycle). Staleness is
 * therefore discovered by scanning, not pushed at detection time.
 */
@Injectable()
export class RightsRecheckSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RightsRecheckSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly recheckService: RightsRecheckService,
    private readonly notifications: RightsNotificationsService,
    private readonly config: ConfigService,
    private readonly backgroundJobs: BackgroundJobsRegistry,
  ) {}

  private static readonly PURPOSE = 'Re-checks rights clearances and opens overdue recheck tasks';

  private getDatabase(): RecheckDatabaseClient {
    return this.prisma as unknown as RecheckDatabaseClient;
  }

  onModuleInit(): void {
    if ((this.config.get('RIGHTS_RECHECK_SCHEDULER_ENABLED') ?? '1') === '0') {
      this.logger.log('Rights recheck scheduler disabled by RIGHTS_RECHECK_SCHEDULER_ENABLED=0');
      this.backgroundJobs.register({
        name: 'rights-recheck-scan',
        state: 'DISABLED',
        reason: 'RIGHTS_RECHECK_SCHEDULER_ENABLED=0',
        purpose: RightsRecheckSchedulerService.PURPOSE,
      });
      return;
    }

    const intervalMs = parsePositiveInt(
      this.config.get('RIGHTS_RECHECK_SCAN_INTERVAL_MS'),
      RECHECK_SCAN_INTERVAL_MS_DEFAULT,
    );
    const initialDelayMs = parsePositiveInt(
      this.config.get('RIGHTS_RECHECK_SCAN_INITIAL_DELAY_MS'),
      RECHECK_SCAN_INITIAL_DELAY_MS_DEFAULT,
    );

    this.initialTimer = setTimeout(() => {
      void this.runScanSafely();
      this.timer = setInterval(() => void this.runScanSafely(), intervalMs);
      // Never hold the event loop open — tests and graceful shutdown depend on it.
      this.timer.unref?.();
    }, initialDelayMs);
    this.initialTimer.unref?.();

    this.backgroundJobs.register({
      name: 'rights-recheck-scan',
      state: 'ACTIVE',
      schedule: `every ${Math.round(intervalMs / 60000)}min, first run after ${Math.round(initialDelayMs / 1000)}s`,
      purpose: RightsRecheckSchedulerService.PURPOSE,
    });
  }

  onModuleDestroy(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
  }

  /** Automatic entry point: an exception must never kill the timer. */
  private async runScanSafely(): Promise<void> {
    try {
      await this.runScan(RightsRecheckTriggerSource.SCHEDULER, null);
    } catch (error: unknown) {
      this.logger.error(
        `Rights recheck scan failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async runScan(
    source: RightsRecheckTriggerSource,
    userId: string | null,
  ): Promise<RecheckScanRunDto> {
    if (this.isRunning) {
      if (source === RightsRecheckTriggerSource.MANUAL) {
        throw recheckError(HttpStatus.CONFLICT, RECHECK_ERROR_CODES.RECHECK_SCAN_ALREADY_RUNNING);
      }
      this.logger.warn('Rights recheck scan skipped: a previous run is still in progress');
      const last = await this.getDatabase().rightsRecheckScanRun.findFirst({
        orderBy: { startedAt: 'desc' },
      });
      return this.toScanRunDto(last as RightsRecheckScanRunRecord);
    }

    this.isRunning = true;
    const database = this.getDatabase();
    const startedAt = new Date();

    const run = await database.rightsRecheckScanRun.create({
      data: {
        status: RightsRecheckScanStatus.RUNNING,
        source,
        startedAt,
        triggeredByUserId: userId,
      },
    });

    const counters: ScanCounters = {
      profilesScanned: 0,
      versionsScanned: 0,
      tasksCreated: 0,
      tasksEscalated: 0,
      tasksAutoClosed: 0,
      remindersSent: 0,
    };

    try {
      const config = this.recheckService.getRuntimeConfig();
      const now = new Date();

      await this.scanScheduledDueDates(database, config, now, counters);
      await this.scanStaleVersions(database, config, now, counters);
      await this.scanStaleReviews(database, config, now, counters);
      await this.autoCloseSupersededTasks(database, now, counters);
      await this.sendReminders(database, config, now, counters);
      await this.escalateSeverities(database, config, now, counters);

      const finishedAt = new Date();
      const finished = await database.rightsRecheckScanRun.update({
        where: { id: run.id },
        data: {
          status: RightsRecheckScanStatus.SUCCEEDED,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          ...counters,
        },
      });
      return this.toScanRunDto(finished);
    } catch (error: unknown) {
      const finishedAt = new Date();
      const message = error instanceof Error ? error.message : 'unknown error';
      const failed = await database.rightsRecheckScanRun.update({
        where: { id: run.id },
        data: {
          status: RightsRecheckScanStatus.FAILED,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          errorMessage: message,
          ...counters,
        },
      });
      this.logger.error(`Rights recheck scan ${run.id} failed: ${message}`);

      // A manual run must surface the failure; the timer must not die because of it.
      if (source === RightsRecheckTriggerSource.MANUAL) {
        throw error;
      }
      return this.toScanRunDto(failed);
    } finally {
      this.isRunning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Step A — planned due dates
  // ---------------------------------------------------------------------------

  private async scanScheduledDueDates(
    database: RecheckDatabaseClient,
    config: RecheckRuntimeConfig,
    now: Date,
    counters: ScanCounters,
  ): Promise<void> {
    const firstLead = config.leadDays[0] ?? 30;
    let skip = 0;

    for (;;) {
      const profiles = await database.rightsProfile.findMany({
        where: {
          isCurrent: true,
          status: { in: [...RECHECK_SCHEDULABLE_PROFILE_STATUSES] },
          recheckPolicy: { not: 'MANUAL_ONLY' },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: config.batchSize,
      });

      for (const profile of profiles) {
        counters.profilesScanned += 1;

        const approvedReview = await this.recheckService.findApprovedReview(database, profile.id);
        const dueAt = computeScheduledDueAt(profile, approvedReview, config, now);

        if (dueAt && now.getTime() >= addDays(dueAt, -firstLead).getTime()) {
          const { created } = await this.recheckService.ensureTask({
            reason: RightsRecheckReason.SCHEDULED_DUE,
            source: RightsRecheckTriggerSource.SCHEDULER,
            rightsProfileId: profile.id,
            rightsIntakeId: profile.rightsIntakeId,
            baselineReviewId: approvedReview?.id ?? null,
            dueAt,
            titleRu: 'Плановая перепроверка прав',
            descriptionRu: `Плановый срок перепроверки прав — ${dueAt.toISOString().slice(0, 10)}. Проверьте, не изменились ли основания clearance.`,
          });
          if (created) counters.tasksCreated += 1;
        }

        await database.rightsProfile.update({
          where: { id: profile.id },
          data: { lastRecheckScanAt: now },
        });
      }

      if (profiles.length < config.batchSize) break;
      skip += config.batchSize;
    }
  }

  // ---------------------------------------------------------------------------
  // Step B — versions marked stale by Phase 8
  // ---------------------------------------------------------------------------

  private async scanStaleVersions(
    database: RecheckDatabaseClient,
    config: RecheckRuntimeConfig,
    now: Date,
    counters: ScanCounters,
  ): Promise<void> {
    let skip = 0;

    for (;;) {
      const versions = await database.bookVersion.findMany({
        where: {
          rightsProfileId: { not: null },
          // WP-D.3: черновик находится в окне наполнения (см. `RightsContentHashService`) —
          // его метки staleness обслуживает само окно, задача перепроверки на неопубликованный
          // текст только добавляет просрочку. Опубликованные версии сканируются как прежде.
          status: { not: 'draft' },
          OR: [{ rightsRecheckRequired: true }, { rightsStaleDetectedAt: { not: null } }],
        },
        orderBy: { id: 'asc' },
        skip,
        take: config.batchSize,
        select: {
          id: true,
          bookId: true,
          language: true,
          status: true,
          rightsProfileId: true,
          approvedRightsReviewId: true,
          rightsRecheckRequired: true,
          rightsStaleDetectedAt: true,
          rightsStaleReasonCode: true,
          rightsStaleReasonRu: true,
        },
      });

      for (const version of versions) {
        counters.versionsScanned += 1;
        if (!version.rightsProfileId) continue;

        const profile = await database.rightsProfile.findUnique({
          where: { id: version.rightsProfileId },
        });

        const reason = staleReasonToRecheckReason(version.rightsStaleReasonCode);
        const { created } = await this.recheckService.ensureTask({
          reason,
          source: RightsRecheckTriggerSource.CONTENT_HASH,
          rightsProfileId: version.rightsProfileId,
          rightsIntakeId: profile?.rightsIntakeId ?? null,
          bookId: version.bookId,
          bookVersionId: version.id,
          baselineReviewId: version.approvedRightsReviewId,
          triggerCode: version.rightsStaleReasonCode,
          dueAt: addDays(now, config.eventDueDays),
          titleRu: `Изменился контент версии (${version.language}) — требуется перепроверка прав`,
          descriptionRu:
            version.rightsStaleReasonRu ??
            'Контент версии изменился после утверждения проверки прав. Требуется перепроверка.',
        });
        if (created) counters.tasksCreated += 1;
      }

      if (versions.length < config.batchSize) break;
      skip += config.batchSize;
    }
  }

  // ---------------------------------------------------------------------------
  // Step C — reviews marked STALE
  // ---------------------------------------------------------------------------

  private async scanStaleReviews(
    database: RecheckDatabaseClient,
    config: RecheckRuntimeConfig,
    now: Date,
    counters: ScanCounters,
  ): Promise<void> {
    const reviews = await database.rightsReview.findMany({
      where: { status: 'STALE', rightsProfile: { isCurrent: true } },
      orderBy: { id: 'asc' },
      take: config.batchSize,
      select: {
        id: true,
        rightsProfileId: true,
        status: true,
        approvedAt: true,
        nextReviewAt: true,
        previousReviewId: true,
        chainRootReviewId: true,
        revisionNumber: true,
      },
    });

    for (const review of reviews) {
      const profile = await database.rightsProfile.findUnique({
        where: { id: review.rightsProfileId },
      });

      const { created } = await this.recheckService.ensureTask({
        reason: RightsRecheckReason.REVIEW_STALE,
        source: RightsRecheckTriggerSource.CONTENT_HASH,
        rightsProfileId: review.rightsProfileId,
        rightsIntakeId: profile?.rightsIntakeId ?? null,
        baselineReviewId: review.id,
        dueAt: addDays(now, config.eventDueDays),
        titleRu: 'Проверка прав помечена как устаревшая',
        descriptionRu:
          'Утверждённая проверка прав переведена в статус STALE. Нужна новая проверка, чтобы вернуть clearance в силу.',
      });
      if (created) counters.tasksCreated += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Step D — reminders
  // ---------------------------------------------------------------------------

  private async sendReminders(
    database: RecheckDatabaseClient,
    config: RecheckRuntimeConfig,
    now: Date,
    counters: ScanCounters,
  ): Promise<void> {
    const tasks = await this.loadOpenTasks(database, config.batchSize);

    for (const task of tasks) {
      // A snoozed task neither reminds nor advances its stage.
      if (task.snoozedUntil && new Date(task.snoozedUntil).getTime() > now.getTime()) continue;

      const newStage = computeReminderStage(
        new Date(task.dueAt),
        now,
        config.leadDays,
        config.graceDays,
      );

      // Only an increase fires a reminder — repeated scans stay silent.
      if (reminderStageRank(newStage) <= reminderStageRank(task.reminderStage)) continue;

      const notification = REMINDER_NOTIFICATION[newStage];
      if (!notification) continue;

      const intakeTitle = await this.resolveIntakeTitle(database, task.rightsIntakeId);

      await database.$transaction(async (client) => {
        await client.rightsRecheckTask.update({
          where: { id: task.id },
          data: {
            reminderStage: newStage,
            remindersSentCount: task.remindersSentCount + 1,
            lastReminderAt: now,
          },
        });
        await this.recheckService.recordEvent(client, task.id, {
          eventType: RightsRecheckEventType.REMINDER_SENT,
          messageRu: `Отправлено напоминание (стадия ${newStage}).`,
          payload: { stage: newStage, previousStage: task.reminderStage },
        });
      });

      await this.notifications.create({
        type: notification.type,
        severity: notification.severity,
        titleRu: notification.titleRu,
        messageRu: this.buildReminderMessage(newStage, intakeTitle, task, now, config),
        targetUserId: null,
        rightsIntakeId: task.rightsIntakeId,
        rightsProfileId: task.rightsProfileId,
        bookVersionId: task.bookVersionId,
        payload: { recheckTaskId: task.id, stage: newStage },
      });

      counters.remindersSent += 1;
    }
  }

  private buildReminderMessage(
    stage: RightsRecheckReminderStage,
    intakeTitle: string,
    task: RightsRecheckTaskRecord,
    now: Date,
    config: RecheckRuntimeConfig,
  ): string {
    const dueAt = new Date(task.dueAt);
    const dueLabel = dueAt.toISOString().slice(0, 10);

    if (
      stage === RightsRecheckReminderStage.OVERDUE ||
      stage === RightsRecheckReminderStage.ESCALATED
    ) {
      const overdueDays = Math.abs(daysUntil(dueAt, now));
      return `По интейку «${intakeTitle}» перепроверка просрочена на ${overdueDays} дн. Публикация новых версий будет заблокирована после ${config.graceDays} дн. просрочки.`;
    }

    if (stage === RightsRecheckReminderStage.DUE) {
      return `По интейку «${intakeTitle}» наступил срок перепроверки прав (${dueLabel}).`;
    }

    return `По интейку «${intakeTitle}» перепроверка прав должна быть выполнена до ${dueLabel} (осталось дней: ${daysUntil(dueAt, now)}).`;
  }

  // ---------------------------------------------------------------------------
  // Step E — auto-close
  // ---------------------------------------------------------------------------

  async autoCloseSupersededTasks(
    database: RecheckDatabaseClient,
    now: Date,
    counters: ScanCounters,
  ): Promise<void> {
    const tasks = await this.loadOpenTasks(
      database,
      this.recheckService.getRuntimeConfig().batchSize,
    );

    for (const task of tasks) {
      if (!task.rightsProfileId) continue;

      // A newer approved review for the same intake supersedes the task outright.
      const newerReview = task.rightsIntakeId
        ? await database.rightsReview.findFirst({
            where: {
              rightsProfile: { rightsIntakeId: task.rightsIntakeId },
              status: 'HUMAN_APPROVED',
              approvedAt: { gt: task.createdAt },
            },
            orderBy: { approvedAt: 'desc' },
            select: {
              id: true,
              rightsProfileId: true,
              status: true,
              approvedAt: true,
              nextReviewAt: true,
              previousReviewId: true,
              chainRootReviewId: true,
              revisionNumber: true,
            },
          })
        : null;

      if (newerReview && (await this.isSupersedeReflectedOnVersion(database, task, newerReview))) {
        await database.$transaction(async (client) => {
          await this.recheckService.closeTask(client, task, {
            resolution: RightsRecheckResolution.SUPERSEDED_BY_NEW_REVIEW,
            completedReviewId: newerReview.id,
            userId: null,
          });
        });
        counters.tasksAutoClosed += 1;
        continue;
      }

      // A content-driven task closes once Phase 8 no longer flags the version.
      if (RECHECK_CONTENT_DRIVEN_REASONS.includes(task.reason as never) && task.bookVersionId) {
        const version = await database.bookVersion.findUnique({
          where: { id: task.bookVersionId },
          select: {
            id: true,
            bookId: true,
            language: true,
            status: true,
            rightsProfileId: true,
            approvedRightsReviewId: true,
            rightsRecheckRequired: true,
            rightsStaleDetectedAt: true,
            rightsStaleReasonCode: true,
            rightsStaleReasonRu: true,
          },
        });

        if (version && !version.rightsRecheckRequired && version.rightsStaleDetectedAt === null) {
          await database.$transaction(async (client) => {
            await this.recheckService.closeTask(client, task, {
              resolution: RightsRecheckResolution.CONTENT_REVERTED,
              userId: null,
            });
          });
          counters.tasksAutoClosed += 1;
        }
      }
    }

    void now;
  }

  /**
   * WP-2.5 / R9-01. A newer approved review at the intake proves the clearance was redone, not that
   * the book followed it: the version keeps its own `approvedRightsReviewId`. Closing the task on
   * the intake alone reported a finished re-check for a book still published under the old
   * clearance — and closed the audit trail that would have shown it.
   *
   * A task not tied to a version has nothing to verify against and keeps the previous behaviour.
   * Same shape as the `CONTENT_REVERTED` branch: the effect is checked on the version itself.
   */
  private async isSupersedeReflectedOnVersion(
    database: RecheckDatabaseClient,
    task: RightsRecheckTaskRecord,
    newerReview: { id: string },
  ): Promise<boolean> {
    if (!task.bookVersionId) return true;

    const version = await database.bookVersion.findUnique({
      where: { id: task.bookVersionId },
      select: { id: true, rightsProfileId: true, approvedRightsReviewId: true },
    });

    return version?.approvedRightsReviewId === newerReview.id;
  }

  // ---------------------------------------------------------------------------
  // Step F — severity escalation
  // ---------------------------------------------------------------------------

  private async escalateSeverities(
    database: RecheckDatabaseClient,
    config: RecheckRuntimeConfig,
    now: Date,
    counters: ScanCounters,
  ): Promise<void> {
    const tasks = await this.loadOpenTasks(database, config.batchSize);

    for (const task of tasks) {
      // Snoozed tasks keep their severity until the snooze expires.
      if (task.snoozedUntil && new Date(task.snoozedUntil).getTime() > now.getTime()) continue;

      const effective = computeTaskSeverity(
        { reason: task.reason, severity: task.severity, dueAt: new Date(task.dueAt) },
        now,
        config.graceDays,
      );

      // Severity never goes down.
      if (severityRank(effective) <= severityRank(task.severity)) continue;

      await database.$transaction(async (client) => {
        await client.rightsRecheckTask.update({
          where: { id: task.id },
          data: { severity: effective },
        });
        await this.recheckService.recordEvent(client, task.id, {
          eventType: RightsRecheckEventType.SEVERITY_ESCALATED,
          messageRu: `Критичность задачи повышена: ${task.severity} → ${effective}.`,
          payload: { from: task.severity, to: effective },
        });
      });

      counters.tasksEscalated += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Scan run history
  // ---------------------------------------------------------------------------

  async listScanRuns(query: ListScanRunsDto): Promise<RecheckScanRunListResponseDto> {
    const database = this.getDatabase();
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit =
      query.limit && query.limit > 0
        ? Math.min(query.limit, RECHECK_LIST_MAX_LIMIT)
        : RECHECK_LIST_DEFAULT_LIMIT;

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;

    const [total, items] = await Promise.all([
      database.rightsRecheckScanRun.count({ where }),
      database.rightsRecheckScanRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { items: items.map((item) => this.toScanRunDto(item)), total, page, limit };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private loadOpenTasks(
    database: RecheckDatabaseClient,
    batchSize: number,
  ): Promise<RightsRecheckTaskRecord[]> {
    return database.rightsRecheckTask.findMany({
      where: { status: { in: [...RECHECK_OPEN_STATUSES] } },
      orderBy: { dueAt: 'asc' },
      take: batchSize,
    });
  }

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

  private toScanRunDto(run: RightsRecheckScanRunRecord | null): RecheckScanRunDto {
    if (!run) {
      // Only reachable when a concurrent automatic run is skipped before any run exists.
      const nowIso = new Date().toISOString();
      return {
        id: '',
        status: RightsRecheckScanStatus.RUNNING,
        source: RightsRecheckTriggerSource.SCHEDULER,
        startedAt: nowIso,
        finishedAt: null,
        durationMs: null,
        profilesScanned: 0,
        versionsScanned: 0,
        tasksCreated: 0,
        tasksEscalated: 0,
        tasksAutoClosed: 0,
        remindersSent: 0,
        errorMessage: null,
        triggeredByUserId: null,
      };
    }

    return {
      id: run.id,
      status: run.status,
      source: run.source,
      startedAt: new Date(run.startedAt).toISOString(),
      finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
      durationMs: run.durationMs,
      profilesScanned: run.profilesScanned,
      versionsScanned: run.versionsScanned,
      tasksCreated: run.tasksCreated,
      tasksEscalated: run.tasksEscalated,
      tasksAutoClosed: run.tasksAutoClosed,
      remindersSent: run.remindersSent,
      errorMessage: run.errorMessage,
      triggeredByUserId: run.triggeredByUserId,
    };
  }
}
