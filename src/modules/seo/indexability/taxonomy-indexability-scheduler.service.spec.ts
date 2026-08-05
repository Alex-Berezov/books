import { ConfigService } from '@nestjs/config';
import { TaxonomyIndexabilityService } from './taxonomy-indexability.service';
import { TaxonomyIndexabilitySchedulerService } from './taxonomy-indexability-scheduler.service';

const makeConfig = (values: Record<string, string> = {}): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const makeIndexability = (
  result = { categoryTranslations: 10, tagTranslations: 5, changed: 3 },
) => {
  const recomputeAll = jest.fn().mockResolvedValue(result);
  return {
    service: { recomputeAll } as unknown as TaxonomyIndexabilityService,
    recomputeAll,
  };
};

describe('TaxonomyIndexabilitySchedulerService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stays off when the kill switch is set', () => {
    const service = new TaxonomyIndexabilitySchedulerService(
      makeIndexability().service,
      makeConfig({ TAXONOMY_INDEXABILITY_SCHEDULER_ENABLED: '0' }),
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
    );
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(1000);

    const status = service.getStatus();
    expect(recomputeAll).toHaveBeenCalledTimes(1);
    expect(status.lastChanged).toBe(3);
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
    );
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(1000);

    const status = service.getStatus();
    expect(status.lastError).toBe('db down');
    expect(status.nextRunAt).toBe('2026-08-06T03:00:00.000Z');
    service.onModuleDestroy();
  });
});
