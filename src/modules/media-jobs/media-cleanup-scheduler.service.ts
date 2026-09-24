import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { MediaCleanupService } from './media-cleanup.service';

/**
 * UTC hour the daily sweep is pinned to. Wall-clock, not process uptime. Fixed, not read from
 * the environment, for the same reason as `RightsLawyerExpirySchedulerService`: nobody needs to
 * retune the hour, and every new environment key would have to be declared in `.env.example`
 * too (`check:env`). Chosen a distinct hour from the two sweeps already running — taxonomy
 * indexability at `03:00` and lawyer expiry at `04:00` — so three daily sweeps do not contend
 * for the same Prisma pool in the same minute.
 */
const SWEEP_HOUR_UTC = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MediaCleanupSweepStatus {
  enabled: boolean;
  /** Wall-clock hour (UTC) the sweep is pinned to. */
  scheduledHourUtc: number;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  /**
   * How many rows the sweep actually looked at.
   *
   * Without this, `lastMarkedSoftDeleted: 0` is indistinguishable between "looked at 400,
   * nothing qualified" and "looked at nothing" — and this endpoint is precisely what the
   * first production run has to be confirmed by (`L-015`).
   */
  lastScanned: number | null;
  /** Of those scanned: how many the URL-reference check saved (covers, audio, avatars). */
  lastSkippedByUrlReference: number | null;
  lastMarkedSoftDeleted: number | null;
  lastHardDeleted: number | null;
  lastStorageFilesRemoved: number | null;
  lastStorageErrors: number | null;
  lastError: string | null;
  isRunning: boolean;
}

/**
 * Daily in-process sweep for orphan `MediaAsset` cleanup.
 *
 * Replaces the BullMQ repeatable job `media-cleanup` (`LEGACY-059`, решение владельца
 * 21.09.2026, пачка `W3`): production runs no Redis at all (`docker-compose.prod.yml` defines
 * exactly `app` and `postgres`), so the old `Queue.add(..., { repeat: { pattern } })` never
 * scheduled anything — the mechanism reported `DISABLED` and never ran once. The owner's answer
 * was explicit: Redis is not being introduced into production, so the job moves to the same
 * in-process timer pattern already proven by `TaxonomyIndexabilitySchedulerService`.
 *
 * 🔴 **Выключен по умолчанию, и это не осторожность, а условие из `LEGACY-058`** (решение
 * арбитра 21.09.2026, `decisions-log.md`). Эта пачка закрывает причину смерти механизма
 * (зависимость от Redis), а не право на первое необратимое удаление: stage 2 делает
 * `storage.delete` и `prisma.mediaAsset.delete`, и `git revert` файл не вернёт. Критерий
 * сироты видит внешние ключи и строковые колонки-адреса (`media/media-references.ts`,
 * LEGACY-413), но **не** картинки внутри HTML и Json и не перепроверяет ссылки на stage 2 —
 * пока открыта `LEGACY-421`, включать таймер нельзя. После неё включение — осознанное
 * действие владельца **после** прогона `POST /admin/media/cleanup-orphans?dryRun=true`
 * и сверки списка, а не побочный эффект выката. Пока `MEDIA_CLEANUP_ENABLED` не выставлен
 * в `1`/`true`, таймер не заводится вовсе.
 *
 * **Accepted limitations**, same as the taxonomy sweep:
 * - *Status is per replica.* Runs are serialised across replicas and against the manual
 *   endpoint by `MediaCleanupService`'s advisory lock (LEGACY-413), but `getStatus()` shows the
 *   state of whichever replica answered.
 * - *No persistence or retries.* A process that dies mid-sweep sweeps again at the next slot.
 */
@Injectable()
export class MediaCleanupSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaCleanupSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private enabled = false;
  /**
   * `scheduleNext` re-arms from a `.finally()` after the sweep, which can land *after*
   * `onModuleDestroy` has already cleared the timer — the new `setTimeout` would then have
   * nothing left to cancel it. The flag is what actually stops the chain; clearing the handle
   * alone does not. Taken from `RightsLawyerExpirySchedulerService`, where it is already fixed.
   */
  private stopped = false;
  private nextRunAt: Date | null = null;
  private lastStartedAt: Date | null = null;
  private lastFinishedAt: Date | null = null;
  private lastDurationMs: number | null = null;
  private lastScanned: number | null = null;
  private lastSkippedByUrlReference: number | null = null;
  private lastMarkedSoftDeleted: number | null = null;
  private lastHardDeleted: number | null = null;
  private lastStorageFilesRemoved: number | null = null;
  private lastStorageErrors: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly cleanup: MediaCleanupService,
    private readonly config: ConfigService,
    private readonly backgroundJobs: BackgroundJobsRegistry,
  ) {}

  private static readonly PURPOSE = 'Deletes media assets nothing references any more (orphans)';

  onModuleInit(): void {
    // Opt-in, а не opt-out: см. разбор `LEGACY-058` в докблоке класса. Принимаются обе формы
    // согласия (`1` и `true`), потому что прежний ключ читался как `false`-выключатель и
    // оператор, однажды написавший `MEDIA_CLEANUP_ENABLED=true`, имел в виду именно «включить».
    const enabled = /^(1|true)$/i.test(this.config.get<string>('MEDIA_CLEANUP_ENABLED') ?? '');
    if (!enabled) {
      this.logger.log(
        'Media cleanup sweep is off: set MEDIA_CLEANUP_ENABLED=1 to enable it, ' +
          'after a dry run via POST /admin/media/cleanup-orphans?dryRun=true (LEGACY-058)',
      );
      this.backgroundJobs.register({
        name: 'media-cleanup',
        state: 'DISABLED',
        reason:
          'MEDIA_CLEANUP_ENABLED is not set — deliberately opt-in until the orphan list is ' +
          'verified with a dry run (LEGACY-058)',
        purpose: MediaCleanupSchedulerService.PURPOSE,
      });
      return;
    }

    this.enabled = true;
    this.scheduleNext();

    this.backgroundJobs.register({
      name: 'media-cleanup',
      state: 'ACTIVE',
      schedule: `daily at ${String(SWEEP_HOUR_UTC).padStart(2, '0')}:00 UTC`,
      purpose: MediaCleanupSchedulerService.PURPOSE,
    });
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Snapshot for the admin status endpoint. */
  getStatus(): MediaCleanupSweepStatus {
    return {
      enabled: this.enabled,
      scheduledHourUtc: SWEEP_HOUR_UTC,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
      lastStartedAt: this.lastStartedAt?.toISOString() ?? null,
      lastFinishedAt: this.lastFinishedAt?.toISOString() ?? null,
      lastDurationMs: this.lastDurationMs,
      lastScanned: this.lastScanned,
      lastSkippedByUrlReference: this.lastSkippedByUrlReference,
      lastMarkedSoftDeleted: this.lastMarkedSoftDeleted,
      lastHardDeleted: this.lastHardDeleted,
      lastStorageFilesRemoved: this.lastStorageFilesRemoved,
      lastStorageErrors: this.lastStorageErrors,
      lastError: this.lastError,
      isRunning: this.isRunning,
    };
  }

  /** Milliseconds until the next occurrence of the pinned UTC hour. */
  private msUntilNextSlot(from: Date): number {
    const next = new Date(from);
    next.setUTCHours(SWEEP_HOUR_UTC, 0, 0, 0);
    if (next.getTime() <= from.getTime()) {
      next.setTime(next.getTime() + DAY_MS);
    }
    return next.getTime() - from.getTime();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const now = new Date();
    const delay = this.msUntilNextSlot(now);
    this.nextRunAt = new Date(now.getTime() + delay);

    this.timer = setTimeout(() => {
      void this.runSweepSafely().finally(() => this.scheduleNext());
    }, delay);
    // Never hold the event loop open — tests and graceful shutdown depend on it.
    this.timer.unref?.();
  }

  /**
   * An exception must never stop the schedule. The cleanup only ever touches rows that still
   * qualify at run time, so a skipped or repeated run is harmless.
   */
  private async runSweepSafely(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Media cleanup sweep skipped: previous run still in progress');
      return;
    }

    this.isRunning = true;
    // Начало видно сразу, а ошибка прошлого прогона снимается: рядом с `isRunning: true`
    // оператор видит свежий прогон, а не зависший и не упавший. Пропуск по замку возвращает
    // прежние значения: иначе они легли бы рядом с числами прошлого прогона и читались бы
    // как доказательство работы, которой не было.
    const previousStartedAt = this.lastStartedAt;
    const previousError = this.lastError;
    const startedAt = new Date();
    this.lastStartedAt = startedAt;
    this.lastError = null;
    let isSkipped = false;

    try {
      const result = await this.cleanup.cleanupIfIdle();
      if (!result) {
        isSkipped = true;
        this.lastStartedAt = previousStartedAt;
        this.lastError = previousError;
        // Идёт ручной прогон или таймер соседней реплики: пропуск, не ошибка.
        this.logger.warn('Media cleanup sweep skipped: another run holds the cleanup lock');
        return;
      }
      this.lastScanned = result.scanned;
      this.lastSkippedByUrlReference = result.skippedByUrlReference;
      this.lastMarkedSoftDeleted = result.markedSoftDeleted;
      this.lastHardDeleted = result.hardDeleted;
      this.lastStorageFilesRemoved = result.storageFilesRemoved;
      this.lastStorageErrors = result.storageErrors;
      // Логируется и при нулях — но доказывает работу именно `scanned`: «удалено 0» само по
      // себе отдаёт и прогон, который ничего не посмотрел.
      this.logger.log(
        `Media cleanup sweep: ${result.scanned} asset(s) scanned, ` +
          `soft=${result.markedSoftDeleted}, hard=${result.hardDeleted}, ` +
          `files=${result.storageFilesRemoved}, storageErrors=${result.storageErrors}`,
      );
    } catch (error: unknown) {
      this.lastError = error instanceof Error ? error.message : 'unknown error';
      this.lastScanned = null;
      this.lastSkippedByUrlReference = null;
      this.lastMarkedSoftDeleted = null;
      this.lastHardDeleted = null;
      this.lastStorageFilesRemoved = null;
      this.lastStorageErrors = null;
      this.logger.error(`Media cleanup sweep failed: ${this.lastError}`);
    } finally {
      if (!isSkipped) {
        this.lastFinishedAt = new Date();
        this.lastDurationMs = this.lastFinishedAt.getTime() - startedAt.getTime();
      }
      this.isRunning = false;
    }
  }
}
