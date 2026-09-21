import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { RightsLawyerReviewService } from './rights-lawyer-review.service';

/**
 * UTC hour the daily sweep is pinned to. Wall-clock, not process uptime. Fixed, not read from
 * the environment: unlike the enable switch below, nobody needs to retune the hour itself, and
 * every new environment key here has to be declared in `.env.example` too (`check:env`) —
 * kept to the one that actually earns it. Chosen a distinct hour from
 * `TAXONOMY_INDEXABILITY_SWEEP_HOUR_UTC`'s default (`03:00`) so the two daily sweeps do not
 * contend for the same minute.
 */
const SWEEP_HOUR_UTC = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily sweep that materialises expired legal opinions and sends the expiry notifications —
 * the automatic counterpart of `POST /admin/rights/lawyer-reviews/expiry-scan`.
 *
 * `LEGACY-022`, closed. Phase 19 deliberately shipped without this: the project already had one
 * in-process timer (`RightsRecheckSchedulerService`, `ADR-001`), and wiring a second step into
 * that same scan would have added `RightsRecheckModule → RightsLawyerModule` — an edge the
 * module graph does not have (`rights-lawyer.module.ts` imports `RightsIntakeModule` and
 * `RightsAgentModule` only, one-way; `RightsIntakeModule` must never import this module back).
 * This sweep is its own timer living inside `RightsLawyerModule` instead — the dependency
 * direction stays exactly as it was, nothing new crosses it. See `ADR-020`.
 *
 * Same mechanism as `TaxonomyIndexabilitySchedulerService`: pinned to a wall-clock UTC hour
 * (not counted from process start, so a redeploy does not shift it), a plain `setTimeout` chain
 * — no `@nestjs/schedule`, no BullMQ, for the same reasons as `ADR-001` (no new dependency here,
 * Redis stays optional in this deployment) — and observable through `GET /admin/background-jobs`
 * via `BackgroundJobsRegistry`, because a sweep nobody can confirm ran is not a sweep.
 *
 * Reads and writes go through `RightsLawyerReviewService.runExpiryScan` — the exact method the
 * manual admin endpoint already calls, one implementation, two triggers. `null` marks the run as
 * system-triggered in the audit trail, the same convention `RightsRecheckSchedulerService` uses
 * for its own automatic runs.
 *
 * **Accepted limitation, same shape as `ADR-001` before `LEGACY-021`:** single instance assumed.
 * Two replicas pinned to the same wall-clock hour would sweep at the same instant every day.
 * What that costs is bounded but real, and the bound is worth stating exactly: every write in
 * `runExpiryScan` is guarded by `expiryNotifiedAt` / `expiredAt` **inside its own transaction**
 * (`updateMany` with those columns in `where`), so a second sweeper cannot expire the same
 * review twice or send the same notification twice — it finds nothing left to update and skips.
 * What it does cost is a duplicate read of the whole candidate set. Not fixed with a claim-style
 * lock here: unlike the recheck scan, the losing side does no writes at all, so a lock would buy
 * only the read. Worth revisiting together with `ADR-001`'s own note if the backend is ever
 * horizontally scaled.
 */
@Injectable()
export class RightsLawyerExpirySchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RightsLawyerExpirySchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  /**
   * `scheduleNext` re-arms from a `.finally()` after the sweep, which can land *after*
   * `onModuleDestroy` has already cleared the timer — the new `setTimeout` would then have
   * nothing left to cancel it. The flag is what actually stops the chain; clearing the handle
   * alone does not.
   */
  private stopped = false;

  constructor(
    private readonly reviews: RightsLawyerReviewService,
    private readonly config: ConfigService,
    private readonly backgroundJobs: BackgroundJobsRegistry,
  ) {}

  private static readonly PURPOSE =
    'Daily materialisation of expired legal opinions and their notifications';

  onModuleInit(): void {
    if ((this.config.get('RIGHTS_LAWYER_EXPIRY_SCHEDULER_ENABLED') ?? '1') === '0') {
      this.logger.log(
        'Rights lawyer expiry sweep disabled by RIGHTS_LAWYER_EXPIRY_SCHEDULER_ENABLED=0',
      );
      this.backgroundJobs.register({
        name: 'rights-lawyer-expiry-sweep',
        state: 'DISABLED',
        reason: 'RIGHTS_LAWYER_EXPIRY_SCHEDULER_ENABLED=0',
        purpose: RightsLawyerExpirySchedulerService.PURPOSE,
      });
      return;
    }

    // 🔴 The whole legal contour has its own kill switch, and every other entry point honours
    // it (`RightsLawyerReviewService.evaluate`, `RightsRiskAssessmentService`). A sweep that
    // ignored it would keep writing `EXPIRED`, keep escalating profiles and keep sending
    // "publication is blocked" notices while publication is, in fact, not blocked at all —
    // a switched-off feature still changing legal statuses. Before this timer existed nothing
    // ran on its own, so the question never arose.
    if (!this.reviews.getTimingConfig().workflowEnabled) {
      this.logger.log('Rights lawyer expiry sweep disabled by RIGHTS_LAWYER_WORKFLOW_ENABLED=0');
      this.backgroundJobs.register({
        name: 'rights-lawyer-expiry-sweep',
        state: 'DISABLED',
        reason: 'RIGHTS_LAWYER_WORKFLOW_ENABLED=0 — the whole legal contour is switched off',
        purpose: RightsLawyerExpirySchedulerService.PURPOSE,
      });
      return;
    }

    this.scheduleNext();

    this.backgroundJobs.register({
      name: 'rights-lawyer-expiry-sweep',
      state: 'ACTIVE',
      schedule: `daily at ${String(SWEEP_HOUR_UTC).padStart(2, '0')}:00 UTC`,
      purpose: RightsLawyerExpirySchedulerService.PURPOSE,
    });
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Milliseconds until the next occurrence of the configured UTC hour.
   *
   * Pinned to the clock rather than to uptime, same reasoning as
   * `TaxonomyIndexabilitySchedulerService.msUntilNextSlot`: with a plain interval, every redeploy
   * would silently move the sweep.
   */
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
    const delay = this.msUntilNextSlot(new Date());

    this.timer = setTimeout(() => {
      void this.runSweepSafely().finally(() => this.scheduleNext());
    }, delay);
    // Never hold the event loop open — tests and graceful shutdown depend on it.
    this.timer.unref?.();
  }

  /** An exception must never stop the schedule — `runExpiryScan` itself decides what to touch. */
  private async runSweepSafely(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Rights lawyer expiry sweep skipped: previous run still in progress');
      return;
    }

    this.isRunning = true;
    try {
      const result = await this.reviews.runExpiryScan(null);
      this.logger.log(
        `Rights lawyer expiry sweep: ${result.checkedCount} checked, ` +
          `${result.expiredCount} expired, ${result.expiringSoonCount} expiring soon, ` +
          `${result.notificationsSent} notifications sent`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Rights lawyer expiry sweep failed: ${message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
