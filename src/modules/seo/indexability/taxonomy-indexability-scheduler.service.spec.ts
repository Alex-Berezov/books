import { ConfigService } from '@nestjs/config';
import { TaxonomyIndexabilityService } from './taxonomy-indexability.service';
import { BackgroundJobsRegistry } from '../../background-jobs/background-jobs.registry';
import { TaxonomyIndexabilitySchedulerService } from './taxonomy-indexability-scheduler.service';

const makeConfig = (values: Record<string, string> = {}): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const makeIndexability = (
  result = { categoryTranslations: 10, tagTranslations: 5, changed: 3, opened: 2, closed: 1 },
) => {
  const recomputeAll = jest.fn().mockResolvedValue(result);
  return {
    service: { recomputeAll } as unknown as TaxonomyIndexabilityService,
    recomputeAll,
  };
};

/**
 * Настоящий реестр, а не заглушка: он дешёвый, и через него видно, что механизм
 * действительно объявляет своё состояние — а это половина смысла правки.
 */
const makeRegistry = () => new BackgroundJobsRegistry();

describe('TaxonomyIndexabilitySchedulerService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stays off when the kill switch is set', () => {
    const service = new TaxonomyIndexabilitySchedulerService(
      makeIndexability().service,
      makeConfig({ TAXONOMY_INDEXABILITY_SCHEDULER_ENABLED: '0' }),
      makeRegistry(),
    );

    service.onModuleInit();

    expect(service.getStatus().enabled).toBe(false);
    expect(service.getStatus().nextRunAt).toBeNull();
    service.onModuleDestroy();
  });

  it('pins the next run to the configured wall-clock hour, not to process start', () => {
    // A redeploy at an arbitrary moment must not move the slot.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T10:17:42.000Z'));

    const service = new TaxonomyIndexabilitySchedulerService(
      makeIndexability().service,
      makeConfig({ TAXONOMY_INDEXABILITY_SWEEP_HOUR_UTC: '3' }),
      makeRegistry(),
    );
    service.onModuleInit();

    // 10:17 is past 03:00, so the next slot is tomorrow at 03:00 sharp.
    expect(service.getStatus().nextRunAt).toBe('2026-08-06T03:00:00.000Z');
    service.onModuleDestroy();
  });

  it('takes today’s slot when it is still ahead', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T01:00:00.000Z'));

    const service = new TaxonomyIndexabilitySchedulerService(
      makeIndexability().service,
      makeConfig({ TAXONOMY_INDEXABILITY_SWEEP_HOUR_UTC: '3' }),
      makeRegistry(),
    );
    service.onModuleInit();

    expect(service.getStatus().nextRunAt).toBe('2026-08-05T03:00:00.000Z');
    service.onModuleDestroy();
  });

  it('records the result of a run so it can be confirmed from outside', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T02:59:59.000Z'));
    const { service: indexability, recomputeAll } = makeIndexability();

    const service = new TaxonomyIndexabilitySchedulerService(
      indexability,
      makeConfig({ TAXONOMY_INDEXABILITY_SWEEP_HOUR_UTC: '3' }),
      makeRegistry(),
    );
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(1000);

    const status = service.getStatus();
    expect(recomputeAll).toHaveBeenCalledTimes(1);
    expect(status.lastChanged).toBe(3);
    // The number that proves work happened: "changed 0" alone is also what a
    // sweep that scanned nothing would report.
    expect(status.lastScanned).toBe(15);
    expect(status.lastOpened).toBe(2);
    expect(status.lastClosed).toBe(1);
    expect(status.lastError).toBeNull();
    expect(status.lastFinishedAt).not.toBeNull();
    // And the schedule survives the run.
    expect(status.nextRunAt).toBe('2026-08-06T03:00:00.000Z');
    service.onModuleDestroy();
  });

  it('records a failure instead of dying with it', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T02:59:59.000Z'));
    const indexability = {
      recomputeAll: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as TaxonomyIndexabilityService;

    const service = new TaxonomyIndexabilitySchedulerService(
      indexability,
      makeConfig({ TAXONOMY_INDEXABILITY_SWEEP_HOUR_UTC: '3' }),
      makeRegistry(),
    );
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(1000);

    const status = service.getStatus();
    expect(status.lastError).toBe('db down');
    // A failed run must not leave last run's numbers standing — they would read
    // as evidence that this run did the work.
    expect(status.lastScanned).toBeNull();
    expect(status.lastChanged).toBeNull();
    expect(status.nextRunAt).toBe('2026-08-06T03:00:00.000Z');
    service.onModuleDestroy();
  });
});
