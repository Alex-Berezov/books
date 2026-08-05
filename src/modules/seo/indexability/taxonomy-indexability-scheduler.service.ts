import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaxonomyIndexabilityService } from './taxonomy-indexability.service';

/** UTC hour the daily sweep is pinned to. Wall-clock, not process uptime. */
const SWEEP_HOUR_UTC_DEFAULT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TaxonomySweepStatus {
  enabled: boolean;
  /** Wall-clock hour (UTC) the sweep is pinned to. */
  scheduledHourUtc: number;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastChanged: number | null;
  lastError: string | null;
  isRunning: boolean;
}

function parseHour(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback;
}

/**
 * Safety net that re-derives every taxonomy counter once a day.
 *
 * The targeted hooks (publish/unpublish, attach/detach) cover the known paths;
 * this sweep covers the unknown ones. On 05.08.2026 the absence of any such
 * sweep let `autoIndexable` sit at its schema default for every term in
 * production until the sitemap advertised 2205 empty pages — the point of this
 * service is that such a drift can survive at most one day.
 *
 * **Why an in-process timer and not a BullMQ repeatable job** (which `PLAN.md`
 * WP-4.2 called for): production runs no Redis. `docker-compose.prod.yml`
 * defines exactly two services, `app` and `postgres`, and `QueueModule` resolves
 * every one of its providers to `undefined` unless `REDIS_URL` / `REDIS_HOST` is
 * set. A repeatable job would therefore never be scheduled at all — the same
 * silent no-op this package exists to remove, only harder to notice. The
 * precedent and the reasoning are already in `RightsRecheckSchedulerService`.
 *
 * **Accepted limitations**, recorded in `api-contracts.md`:
 * - *Single instance assumed.* Two replicas would sweep concurrently. That is
 *   safe — every write is idempotent and only touches rows whose value actually
 *   changed — but wasteful. Introducing a second replica requires moving this to
 *   a locked job.
 * - *No persistence or retries.* A process that dies mid-sweep simply sweeps
 *   again at the next slot; nothing is queued or resumed.
 *
 * **What was fixed rather than accepted:** the schedule is pinned to a wall-clock
 * UTC hour instead of counting from process start, so a redeploy no longer shifts
 * it; and the last run is observable from outside through
 * `GET /admin/seo/taxonomy-indexability/status`, because a safety net you cannot
 * confirm ran is not a safety net.
 */
@Injectable()
export class TaxonomyIndexabilitySchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaxonomyIndexabilitySchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private enabled = false;
  private scheduledHourUtc = SWEEP_HOUR_UTC_DEFAULT;
  private nextRunAt: Date | null = null;
  private lastStartedAt: Date | null = null;
  private lastFinishedAt: Date | null = null;
  private lastDurationMs: number | null = null;
  private lastChanged: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly indexability: TaxonomyIndexabilityService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if ((this.config.get('TAXONOMY_INDEXABILITY_SCHEDULER_ENABLED') ?? '1') === '0') {
      this.logger.log(
        'Taxonomy indexability sweep disabled by TAXONOMY_INDEXABILITY_SCHEDULER_ENABLED=0',
      );
      return;
    }

    this.enabled = true;
    this.scheduledHourUtc = parseHour(
      this.config.get('TAXONOMY_INDEXABILITY_SWEEP_HOUR_UTC'),
      SWEEP_HOUR_UTC_DEFAULT,
    );
    this.scheduleNext();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Snapshot for the admin status endpoint. */
  getStatus(): TaxonomySweepStatus {
    return {
      enabled: this.enabled,
      scheduledHourUtc: this.scheduledHourUtc,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
      lastStartedAt: this.lastStartedAt?.toISOString() ?? null,
      lastFinishedAt: this.lastFinishedAt?.toISOString() ?? null,
      lastDurationMs: this.lastDurationMs,
      lastChanged: this.lastChanged,
      lastError: this.lastError,
      isRunning: this.isRunning,
    };
  }

  /**
   * Milliseconds until the next occurrence of the configured UTC hour.
   *
   * Pinned to the clock rather than to uptime: with a plain interval, every
   * redeploy silently moved the sweep, so "once a day" drifted into "a day after
   * whenever we last shipped".
   */
  private msUntilNextSlot(from: Date): number {
    const next = new Date(from);
    next.setUTCHours(this.scheduledHourUtc, 0, 0, 0);
    if (next.getTime() <= from.getTime()) {
      next.setTime(next.getTime() + DAY_MS);
    }
    return next.getTime() - from.getTime();
  }

  private scheduleNext(): void {
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
   * An exception must never stop the schedule. The sweep is idempotent — only
   * rows whose count or state changed are written — so a skipped or repeated run
   * is harmless.
   */
  private async runSweepSafely(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Taxonomy indexability sweep skipped: previous run still in progress');
      return;
    }

    this.isRunning = true;
    this.lastStartedAt = new Date();
    this.lastError = null;

    try {
      const result = await this.indexability.recomputeAll();
      this.lastChanged = result.changed;
      // Logged even at zero: "changed 0" is the evidence that the sweep ran and
      // found nothing to fix, which is exactly what silence failed to prove before.
      this.logger.log(
        `Taxonomy indexability sweep: ${result.categoryTranslations} category + ` +
          `${result.tagTranslations} tag translations scanned, ${result.changed} changed`,
      );
    } catch (error: unknown) {
      this.lastError = error instanceof Error ? error.message : 'unknown error';
      this.lastChanged = null;
      this.logger.error(`Taxonomy indexability sweep failed: ${this.lastError}`);
    } finally {
      this.lastFinishedAt = new Date();
      this.lastDurationMs = this.lastFinishedAt.getTime() - this.lastStartedAt.getTime();
      this.isRunning = false;
    }
  }
}
