import { HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
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
  RECHECK_SCAN_STALE_RUNNING_MS,
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
import { paginated, type PaginatedResult } from '../../shared/dto/paginated-response.dto';
import type { ListScanRunsDto } from './dto/list-scan-runs.dto';
import type { RecheckScanRunDto } from './dto/recheck-scan-response.dto';
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
 * Single argument of `pg_advisory_xact_lock(bigint)`, same overload as `CategoryTreeService`'s
 * `CATEGORY_TREE_LOCK_KEY` (`category-tree.service.ts:52`, `8_314_270_001n`) — a global lock
 * for the whole scan is enough, there is no per-profile or per-version granularity to lock.
 * Value chosen not to collide with it. The two-argument overload used elsewhere keys off its
 * own `int4` namespaces and cannot collide with a `bigint` key at all:
 * `TAG_KEY_LOCK_NAMESPACE` (`831_427_002`), `CATEGORY_SLUG_LOCK_NAMESPACE` (`831_427_003`),
 * `RIGHTS_PROFILE_LOCK_NAMESPACE` (`831_427_101`), `RIGHTS_REVIEW_LOCK_NAMESPACE`
 * (`831_427_102`).
 */
const RECHECK_SCAN_LOCK_KEY = 8_314_270_002n;

/**
 * Explicit, not Prisma's defaults (`maxWait` 2s, `timeout` 5s), by the same reasoning as
 * `CATEGORY_TREE_TX_OPTIONS` (`category-tree.service.ts:81`): the whole application shares one
 * pool (`LEGACY-130`), and this transaction additionally waits on an advisory lock held by
 * whoever is claiming the slot right now. On the defaults a claim under load fails with
 * `P2024`/`P2028` — a manual scan would answer 500 instead of 409, and an automatic one would
 * skip its tick entirely and wait six hours for the next. The claim itself is three statements,
 * so a wide ceiling costs nothing.
 */
const RECHECK_CLAIM_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * In-process scan that turns dates and Phase 8 staleness flags into recheck tasks.
 *
 * Why `setInterval` and not `@nestjs/schedule` or BullMQ:
 * - `@nestjs/schedule` is not a dependency of this project and Phase 18 adds none;
 * - BullMQ exists, but Redis is optional in this deployment (`QueueModule` yields
 *   undefined providers without `REDIS_URL`/`REDIS_HOST`) — the rights scheduler must not
 *   silently switch itself off when Redis is absent.
 *
 * The scan is a pull model on purpose: `RightsContentHashService` lives in `RightsIntakeModule`,
 * which must not import `RightsRecheckModule` (that would be a module cycle). Staleness is
 * therefore discovered by scanning, not pushed at detection time.
 *
 * **`LEGACY-021`, closed.** Under horizontal scaling every instance runs this same timer, and
 * `isRunning` alone only ever protected concurrent runs *inside one process* — two containers
 * each saw no running scan and both started one. `runScan` now claims its `RightsRecheckScanRun`
 * row under `pg_advisory_xact_lock` (`claimRun`/`lockScan` below, same shape as
 * `CategoryTreeService.lockTree`): the check-then-write that decides "is a scan already running"
 * is now atomic across every instance, not only within one process. See `ADR-001`.
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
    // Fast in-process short-circuit — avoids a claim round trip when this same process already
    // knows it is scanning. Set synchronously, before any `await`, so two calls issued back to
    // back from the same process never both pass it. The cross-process guarantee comes from
    // `claimRun` below, not from this flag (`LEGACY-021`).
    if (this.isRunning) {
      if (source === RightsRecheckTriggerSource.MANUAL) {
        throw recheckError(HttpStatus.CONFLICT, RECHECK_ERROR_CODES.RECHECK_SCAN_ALREADY_RUNNING);
      }
      this.logger.warn('Rights recheck scan skipped: a previous run is still in progress');
      // Filtered by RUNNING, not just "the newest row": without the filter this reports the
      // previous, already finished run as though it were the one in flight — and in the window
      // between `isRunning = true` and `claimRun`'s insert there is no new row yet at all.
      const last = await this.getDatabase().rightsRecheckScanRun.findFirst({
        where: { status: RightsRecheckScanStatus.RUNNING },
        orderBy: { startedAt: 'desc' },
      });
      return this.toScanRunDto(last as RightsRecheckScanRunRecord);
    }

    this.isRunning = true;
    try {
      const claim = await this.claimRun(source, userId);
      if ('skipped' in claim) {
        return this.toScanRunDto(claim.last);
      }

      const database = this.getDatabase();
      const run = claim.run;
      const startedAt = run.startedAt;

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
        const finished = await this.finishRun(database, run.id, {
          status: RightsRecheckScanStatus.SUCCEEDED,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          ...counters,
        });
        return this.toScanRunDto(finished);
      } catch (error: unknown) {
        const finishedAt = new Date();
        const message = error instanceof Error ? error.message : 'unknown error';
        const failed = await this.finishRun(database, run.id, {
          status: RightsRecheckScanStatus.FAILED,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          errorMessage: message,
          ...counters,
        });
        this.logger.error(`Rights recheck scan ${run.id} failed: ${message}`);

        // A manual run must surface the failure; the timer must not die because of it.
        if (source === RightsRecheckTriggerSource.MANUAL) {
          throw error;
        }
        return this.toScanRunDto(failed);
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * `LEGACY-021`. Makes "is a scan already running" and "claim the slot" one atomic step across
   * every instance of the backend, not only within this process.
   *
   * `pg_advisory_xact_lock` serialises the check-then-write — same shape as
   * `CategoryTreeService.lockTree` / `lockCategorySlug`: taken as the transaction's first
   * statement, held only for this short claim and released automatically at commit. The lock is
   * NOT held for the whole scan on purpose: a multi-batch scan over the whole catalogue can run
   * long, and holding a lock (or an open transaction) for that entire time is its own hazard.
   * Once the `RUNNING` row is claimed here, the scan body below reads and writes through the
   * ordinary pooled client, exactly as before.
   *
   * A `RUNNING` row older than `RECHECK_SCAN_STALE_RUNNING_MS` is treated as abandoned
   * (its owning process died mid-scan) and marked `FAILED` so a new run can claim the slot —
   * without this, one crashed process would wedge the scan for every instance forever, which is
   * worse than the race this method closes. Fixed, not read from the environment on purpose:
   * it is an internal safety ceiling nobody needs to retune per deployment, not an operational
   * knob — unlike `RIGHTS_RECHECK_SCAN_INTERVAL_MS` above, which genuinely is one.
   */
  private async claimRun(
    source: RightsRecheckTriggerSource,
    userId: string | null,
  ): Promise<
    { run: RightsRecheckScanRunRecord } | { skipped: true; last: RightsRecheckScanRunRecord | null }
  > {
    const staleAfterMs = RECHECK_SCAN_STALE_RUNNING_MS;

    return this.prisma.$transaction(async (tx) => {
      await this.lockScan(tx);

      const running = (await tx.rightsRecheckScanRun.findFirst({
        where: { status: RightsRecheckScanStatus.RUNNING },
        orderBy: { startedAt: 'desc' },
      })) as RightsRecheckScanRunRecord | null;

      if (running) {
        const abandoned = Date.now() - new Date(running.startedAt).getTime() > staleAfterMs;
        if (!abandoned) {
          if (source === RightsRecheckTriggerSource.MANUAL) {
            throw recheckError(
              HttpStatus.CONFLICT,
              RECHECK_ERROR_CODES.RECHECK_SCAN_ALREADY_RUNNING,
            );
          }
          this.logger.warn('Rights recheck scan skipped: a previous run is still in progress');
          return { skipped: true as const, last: running };
        }

        this.logger.error(
          `Rights recheck scan run ${running.id} abandoned after ${staleAfterMs}ms without ` +
            'finishing — marking it FAILED and claiming a new run',
        );
        await tx.rightsRecheckScanRun.update({
          where: { id: running.id },
          data: {
            status: RightsRecheckScanStatus.FAILED,
            finishedAt: new Date(),
            errorMessage:
              `Abandoned: ran for more than the ${staleAfterMs}ms ceiling without finishing ` +
              '(RECHECK_SCAN_STALE_RUNNING_MS, a code constant — there is no environment ' +
              'override for it). The slot was taken over by a new run.',
          },
        });
      }

      const run = (await tx.rightsRecheckScanRun.create({
        data: {
          status: RightsRecheckScanStatus.RUNNING,
          source,
          startedAt: new Date(),
          triggeredByUserId: userId,
        },
      })) as RightsRecheckScanRunRecord;

      return { run };
    }, RECHECK_CLAIM_TX_OPTIONS);
  }

  /**
   * Closes the run — but only while this run still owns the slot.
   *
   * Guarded by `status: RUNNING` rather than written with a plain `update({ where: { id } })`,
   * because a slot can be taken over: a scan that outlives `RECHECK_SCAN_STALE_RUNNING_MS` is
   * marked `FAILED` by whichever instance reclaims it, and an unconditional write here would
   * then flip that same row back to `SUCCEEDED` with real counters. The operator would be shown
   * a successful scan on the very row that was declared abandoned, and the takeover would leave
   * no trace at all.
   *
   * Losing the slot is not turned into a thrown error: the scan's own work is idempotent and
   * has already happened: what is lost is only the right to write the verdict.
   */
  private async finishRun(
    database: RecheckDatabaseClient,
    runId: string,
    data: Record<string, unknown>,
  ): Promise<RightsRecheckScanRunRecord | null> {
    const { count } = await database.rightsRecheckScanRun.updateMany({
      where: { id: runId, status: RightsRecheckScanStatus.RUNNING },
      data,
    });

    if (count === 0) {
      this.logger.error(
        `Rights recheck scan ${runId} lost its slot while running: another instance reclaimed ` +
          'it as abandoned. The verdict of this run is not recorded — the reclaim stands.',
      );
    }

    return database.rightsRecheckScanRun.findUnique({
      where: { id: runId },
    });
  }

  private async lockScan(tx: Prisma.TransactionClient): Promise<void> {
    // Called from `FROM`, not the select list: `pg_advisory_xact_lock` returns `void`, and
    // `SELECT pg_advisory_xact_lock(...)` fails to parse the column type (see
    // `CategoryTreeService.lockTree`, the same shape).
    await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(${RECHECK_SCAN_LOCK_KEY})`;
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

  async listScanRuns(query: ListScanRunsDto): Promise<PaginatedResult<RecheckScanRunDto>> {
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

    return paginated(
      items.map((item) => this.toScanRunDto(item)),
      { page, limit, total },
    );
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
