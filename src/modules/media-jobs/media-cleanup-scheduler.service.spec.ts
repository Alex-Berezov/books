import { ConfigService } from '@nestjs/config';
import { MediaCleanupService, CleanupResult } from './media-cleanup.service';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { MediaCleanupSchedulerService } from './media-cleanup-scheduler.service';

const makeConfig = (values: Record<string, string> = {}): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const makeCleanup = (
  result: CleanupResult = {
    markedSoftDeleted: 2,
    hardDeleted: 1,
    storageFilesRemoved: 1,
    storageErrors: 0,
    scanned: 40,
    skippedByUrlReference: 8,
  },
) => {
  const cleanup = jest.fn().mockResolvedValue(result);
  return { service: { cleanup } as unknown as MediaCleanupService, cleanup };
};

/**
 * Настоящий реестр, а не заглушка: он дешёвый, и через него видно, что механизм
 * действительно объявляет своё состояние — а это половина смысла правки
 * (`LEGACY-059`, пачка `W3`).
 */
const makeRegistry = () => new BackgroundJobsRegistry();

/** Согласие включить уборку. Без него планировщик обязан остаться выключенным. */
const ON = { MEDIA_CLEANUP_ENABLED: '1' };

describe('MediaCleanupSchedulerService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * 🔴 Главная посадка правки. Уборка необратима (stage 2 делает `storage.delete`), критерий
   * сироты проверяет четыре адресных колонки из девяти, а `LEGACY-058` требует прогнать
   * `dryRun` и сверить список до включения. Решение арбитра 21.09.2026: opt-in.
   * Верните умолчание «включено» — этот кейс покраснеет.
   */
  it('stays off when MEDIA_CLEANUP_ENABLED is not set at all', () => {
    const { service: cleanupService, cleanup } = makeCleanup();
    const registry = makeRegistry();
    const service = new MediaCleanupSchedulerService(cleanupService, makeConfig(), registry);

    service.onModuleInit();

    expect(service.getStatus().enabled).toBe(false);
    expect(service.getStatus().nextRunAt).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
    // И молчать об этом нельзя: выключенный механизм обязан назвать причину.
    expect(registry.list()).toContainEqual(
      expect.objectContaining({
        name: 'media-cleanup',
        state: 'DISABLED',
        reason: expect.stringContaining('LEGACY-058'),
      }),
    );
    service.onModuleDestroy();
  });

  it('stays off when the kill switch is set explicitly', () => {
    const service = new MediaCleanupSchedulerService(
      makeCleanup().service,
      makeConfig({ MEDIA_CLEANUP_ENABLED: '0' }),
      makeRegistry(),
    );

    service.onModuleInit();

    expect(service.getStatus().enabled).toBe(false);
    expect(service.getStatus().nextRunAt).toBeNull();
    service.onModuleDestroy();
  });

  it('registers ACTIVE with the registry once explicitly enabled', () => {
    const registry = makeRegistry();
    const service = new MediaCleanupSchedulerService(
      makeCleanup().service,
      makeConfig(ON),
      registry,
    );

    service.onModuleInit();

    expect(registry.list()).toContainEqual(
      expect.objectContaining({ name: 'media-cleanup', state: 'ACTIVE' }),
    );
    service.onModuleDestroy();
  });

  it('accepts "true" as consent, not only "1"', () => {
    const service = new MediaCleanupSchedulerService(
      makeCleanup().service,
      makeConfig({ MEDIA_CLEANUP_ENABLED: 'true' }),
      makeRegistry(),
    );

    service.onModuleInit();

    expect(service.getStatus().enabled).toBe(true);
    service.onModuleDestroy();
  });

  it('pins the next run to 05:00 UTC, not to process start', () => {
    // A redeploy at an arbitrary moment must not move the slot.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T10:17:42.000Z'));

    const service = new MediaCleanupSchedulerService(
      makeCleanup().service,
      makeConfig(ON),
      makeRegistry(),
    );
    service.onModuleInit();

    // 10:17 is past 05:00, so the next slot is tomorrow at 05:00 sharp.
    expect(service.getStatus().nextRunAt).toBe('2026-08-06T05:00:00.000Z');
    service.onModuleDestroy();
  });

  it('takes today’s slot when it is still ahead', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T01:00:00.000Z'));

    const service = new MediaCleanupSchedulerService(
      makeCleanup().service,
      makeConfig(ON),
      makeRegistry(),
    );
    service.onModuleInit();

    expect(service.getStatus().nextRunAt).toBe('2026-08-05T05:00:00.000Z');
    service.onModuleDestroy();
  });

  /**
   * Час выбран отличным от соседних таймеров: таксономия в 03:00
   * (`taxonomy-indexability-scheduler.service.ts`), истечение заключений в 04:00
   * (`rights-lawyer-expiry-scheduler.service.ts`). Сведите их в один час — покраснеет.
   */
  it('does not share its slot with the other daily sweeps', () => {
    const service = new MediaCleanupSchedulerService(
      makeCleanup().service,
      makeConfig(ON),
      makeRegistry(),
    );
    service.onModuleInit();

    expect(service.getStatus().scheduledHourUtc).not.toBe(3);
    expect(service.getStatus().scheduledHourUtc).not.toBe(4);
    service.onModuleDestroy();
  });

  it('records the result of a run so it can be confirmed from outside', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T04:59:59.000Z'));
    const { service: cleanupService, cleanup } = makeCleanup({
      markedSoftDeleted: 4,
      hardDeleted: 2,
      storageFilesRemoved: 2,
      storageErrors: 1,
      scanned: 120,
      skippedByUrlReference: 15,
    });

    const service = new MediaCleanupSchedulerService(
      cleanupService,
      makeConfig(ON),
      makeRegistry(),
    );
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(1000);

    const status = service.getStatus();
    expect(cleanup).toHaveBeenCalledTimes(1);
    // Число, которое доказывает, что прогон был: «удалено 0» отдаёт и прогон,
    // не посмотревший ни одной строки (`L-015`).
    expect(status.lastScanned).toBe(120);
    expect(status.lastSkippedByUrlReference).toBe(15);
    expect(status.lastMarkedSoftDeleted).toBe(4);
    expect(status.lastHardDeleted).toBe(2);
    expect(status.lastStorageFilesRemoved).toBe(2);
    expect(status.lastStorageErrors).toBe(1);
    expect(status.lastError).toBeNull();
    expect(status.lastFinishedAt).not.toBeNull();
    // And the schedule survives the run.
    expect(status.nextRunAt).toBe('2026-08-06T05:00:00.000Z');
    service.onModuleDestroy();
  });

  it('records a failure instead of dying with it', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T04:59:59.000Z'));
    const cleanupService = {
      cleanup: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as MediaCleanupService;

    const service = new MediaCleanupSchedulerService(
      cleanupService,
      makeConfig(ON),
      makeRegistry(),
    );
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(1000);

    const status = service.getStatus();
    expect(status.lastError).toBe('db down');
    // A failed run must not leave last run's numbers standing — they would read
    // as evidence that this run did the work.
    expect(status.lastScanned).toBeNull();
    expect(status.lastMarkedSoftDeleted).toBeNull();
    expect(status.lastHardDeleted).toBeNull();
    expect(status.nextRunAt).toBe('2026-08-06T05:00:00.000Z');
    service.onModuleDestroy();
  });

  it('reports isRunning while a sweep is in flight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T04:59:59.000Z'));
    let resolveFirst: (() => void) | undefined;
    const pending = new Promise<CleanupResult>((resolve) => {
      resolveFirst = () =>
        resolve({
          markedSoftDeleted: 1,
          hardDeleted: 0,
          storageFilesRemoved: 0,
          storageErrors: 0,
          scanned: 7,
          skippedByUrlReference: 0,
        });
    });
    const cleanupFn = jest.fn().mockReturnValueOnce(pending);
    const cleanupService = { cleanup: cleanupFn } as unknown as MediaCleanupService;

    const service = new MediaCleanupSchedulerService(
      cleanupService,
      makeConfig(ON),
      makeRegistry(),
    );
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(1000);
    expect(service.getStatus().isRunning).toBe(true);

    resolveFirst?.();
    await jest.advanceTimersByTimeAsync(0);
    expect(service.getStatus().isRunning).toBe(false);
    service.onModuleDestroy();
  });

  /**
   * 🔴 `scheduleNext` перевзводится из `.finally()` — то есть прогон, начавшийся до закрытия
   * модуля, заводил бы новый `setTimeout` уже после того, как `onModuleDestroy` погасил
   * прежний. Снятие флага `stopped` (или проверки на него в `scheduleNext`) роняет этот кейс.
   */
  it('does not re-arm the timer after the module has been destroyed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T04:59:59.000Z'));
    let resolveRun: (() => void) | undefined;
    const pending = new Promise<CleanupResult>((resolve) => {
      resolveRun = () =>
        resolve({
          markedSoftDeleted: 0,
          hardDeleted: 0,
          storageFilesRemoved: 0,
          storageErrors: 0,
          scanned: 3,
          skippedByUrlReference: 0,
        });
    });
    const cleanupFn = jest.fn().mockReturnValueOnce(pending);
    const cleanupService = { cleanup: cleanupFn } as unknown as MediaCleanupService;

    const service = new MediaCleanupSchedulerService(
      cleanupService,
      makeConfig(ON),
      makeRegistry(),
    );
    service.onModuleInit();

    // Прогон пошёл, и прямо во время него модуль гасят.
    await jest.advanceTimersByTimeAsync(1000);
    expect(service.getStatus().isRunning).toBe(true);
    service.onModuleDestroy();

    // Прогон дозавершается уже после закрытия и пытается перевзвести таймер.
    resolveRun?.();
    await jest.advanceTimersByTimeAsync(0);

    // Сутки вперёд: ни одного нового прогона у погашенного модуля быть не должно.
    await jest.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1000);
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });
});
