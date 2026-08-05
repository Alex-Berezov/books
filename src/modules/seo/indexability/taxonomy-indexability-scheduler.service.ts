import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaxonomyIndexabilityService } from './taxonomy-indexability.service';

/** 24 hours. Counters move only when an editor publishes or re-links a book. */
const SCAN_INTERVAL_MS_DEFAULT = 24 * 60 * 60 * 1000;
/** Let the app finish booting before the first full sweep. */
const INITIAL_DELAY_MS_DEFAULT = 5 * 60 * 1000;

function parsePositiveInt(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
 * Why `setInterval` rather than a BullMQ repeatable job, which `PLAN.md` WP-4.2
 * suggested: BullMQ is wired here only as a demo queue, and every one of its
 * providers resolves to `undefined` when `REDIS_URL` / `REDIS_HOST` is absent
 * (`QueueModule`). A maintenance sweep that silently does not run without Redis
 * would reproduce the exact failure mode this package exists to remove. The same
 * reasoning is already recorded in `RightsRecheckSchedulerService`, and this
 * service follows it: a single container, an in-process timer, an env kill
 * switch, `unref()` so tests and shutdown are not held open.
 */
@Injectable()
export class TaxonomyIndexabilitySchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaxonomyIndexabilitySchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

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

    const intervalMs = parsePositiveInt(
      this.config.get('TAXONOMY_INDEXABILITY_SCAN_INTERVAL_MS'),
      SCAN_INTERVAL_MS_DEFAULT,
    );
    const initialDelayMs = parsePositiveInt(
      this.config.get('TAXONOMY_INDEXABILITY_SCAN_INITIAL_DELAY_MS'),
      INITIAL_DELAY_MS_DEFAULT,
    );

    this.initialTimer = setTimeout(() => {
      void this.runSweepSafely();
      this.timer = setInterval(() => void this.runSweepSafely(), intervalMs);
      this.timer.unref?.();
    }, initialDelayMs);
    this.initialTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
  }

  /**
   * An exception must never kill the timer. The sweep is idempotent — the
   * service writes only rows whose count or state actually changed — so a
   * skipped or repeated run is harmless.
   */
  private async runSweepSafely(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Taxonomy indexability sweep skipped: previous run still in progress');
      return;
    }

    this.isRunning = true;
    try {
      const result = await this.indexability.recomputeAll();
      // Logged even at zero: "changed 0" is the evidence that the sweep ran and
      // found nothing to fix, which is exactly what silence failed to prove before.
      this.logger.log(
        `Taxonomy indexability sweep: ${result.categoryTranslations} category + ` +
          `${result.tagTranslations} tag translations scanned, ${result.changed} changed`,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Taxonomy indexability sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.isRunning = false;
    }
  }
}
