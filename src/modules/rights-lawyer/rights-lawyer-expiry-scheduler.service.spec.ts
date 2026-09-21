import { ConfigService } from '@nestjs/config';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { RightsLawyerExpirySchedulerService } from './rights-lawyer-expiry-scheduler.service';
import { RightsLawyerReviewService } from './rights-lawyer-review.service';

const makeConfig = (values: Record<string, string> = {}): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const makeReviews = (
  result = { checkedCount: 4, expiredCount: 1, expiringSoonCount: 1, notificationsSent: 2 },
  { workflowEnabled = true } = {},
) => {
  const runExpiryScan = jest.fn().mockResolvedValue({
    ...result,
    reviewIds: [],
    runAt: new Date().toISOString(),
  });
  const getTimingConfig = jest.fn().mockReturnValue({ workflowEnabled });
  return {
    service: { runExpiryScan, getTimingConfig } as unknown as RightsLawyerReviewService,
    runExpiryScan,
  };
};

/** Real registry, not a stub: proves the mechanism actually declares its own state. */
const makeRegistry = () => new BackgroundJobsRegistry();

describe('RightsLawyerExpirySchedulerService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stays off when the kill switch is set', () => {
    const { service: reviews } = makeReviews();
    const registry = makeRegistry();
    const service = new RightsLawyerExpirySchedulerService(
      reviews,
      makeConfig({ RIGHTS_LAWYER_EXPIRY_SCHEDULER_ENABLED: '0' }),
      registry,
    );

    service.onModuleInit();

    const job = registry.list().find((j) => j.name === 'rights-lawyer-expiry-sweep');
    expect(job?.state).toBe('DISABLED');
    expect(job?.reason).toContain('RIGHTS_LAWYER_EXPIRY_SCHEDULER_ENABLED=0');
    service.onModuleDestroy();
  });

  /**
   * 🔴 Выключенный юридический контур (`RIGHTS_LAWYER_WORKFLOW_ENABLED=0`) не должен
   * продолжать менять правовые статусы: `evaluate` при этом флаге возвращает пустой
   * результат, публикация юристом не блокируется — а подметалка иначе всё равно писала бы
   * `EXPIRED`, эскалировала профили и слала уведомления «публикация заблокирована».
   */
  it('stays off when the whole legal contour is switched off', () => {
    const { service: reviews, runExpiryScan } = makeReviews(undefined, { workflowEnabled: false });
    const registry = makeRegistry();
    const service = new RightsLawyerExpirySchedulerService(reviews, makeConfig(), registry);

    service.onModuleInit();

    const job = registry.list().find((j) => j.name === 'rights-lawyer-expiry-sweep');
    expect(job?.state).toBe('DISABLED');
    expect(job?.reason).toContain('RIGHTS_LAWYER_WORKFLOW_ENABLED=0');
    expect(runExpiryScan).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('does not re-arm the timer after the module is destroyed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T03:59:59.000Z'));
    const { service: reviews } = makeReviews();
    const service = new RightsLawyerExpirySchedulerService(reviews, makeConfig(), makeRegistry());

    service.onModuleInit();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    // Гасим модуль и прокручиваем тик: `scheduleNext` зовётся из `.finally()` уже после
    // `onModuleDestroy`, и без флага он поставил бы таймер, который отменить уже нечем.
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(2000);

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('registers ACTIVE with a daily schedule when enabled', () => {
    const { service: reviews } = makeReviews();
    const registry = makeRegistry();
    const service = new RightsLawyerExpirySchedulerService(reviews, makeConfig(), registry);

    service.onModuleInit();

    const job = registry.list().find((j) => j.name === 'rights-lawyer-expiry-sweep');
    expect(job?.state).toBe('ACTIVE');
    expect(job?.schedule).toMatch(/daily at \d{2}:00 UTC/);
    expect(job?.purpose).toBeTruthy();
    service.onModuleDestroy();
  });

  it('pins the next run to the fixed wall-clock hour, not to process start', () => {
    // A redeploy at an arbitrary moment must not move the slot.
    const now = new Date('2026-08-05T10:17:42.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const { service: reviews } = makeReviews();
    const service = new RightsLawyerExpirySchedulerService(reviews, makeConfig(), makeRegistry());

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    service.onModuleInit();

    // 10:17 is past 04:00, so the next slot is tomorrow at 04:00 sharp.
    const delay = setTimeoutSpy.mock.calls[0]?.[1] as number;
    const expectedNextSlot = new Date('2026-08-06T04:00:00.000Z');
    expect(delay).toBe(expectedNextSlot.getTime() - now.getTime());
    service.onModuleDestroy();
    setTimeoutSpy.mockRestore();
  });

  it('calls runExpiryScan with a null (system) actor and does not crash the timer on success', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T03:59:59.000Z'));
    const { service: reviews, runExpiryScan } = makeReviews();
    const service = new RightsLawyerExpirySchedulerService(reviews, makeConfig(), makeRegistry());

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);

    expect(runExpiryScan).toHaveBeenCalledWith(null);
    expect(runExpiryScan).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('records a failure without dying — the next slot is still scheduled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T03:59:59.000Z'));
    const runExpiryScan = jest.fn().mockRejectedValue(new Error('db down'));
    const reviews = {
      runExpiryScan,
      getTimingConfig: () => ({ workflowEnabled: true }),
    } as unknown as RightsLawyerReviewService;
    const service = new RightsLawyerExpirySchedulerService(reviews, makeConfig(), makeRegistry());

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);

    // A second timer was armed for the next day's slot — the failure did not kill the schedule.
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(1);
    service.onModuleDestroy();
    setTimeoutSpy.mockRestore();
  });

  it('skips a tick while the previous run is still in flight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T03:59:59.000Z'));
    let release: () => void = () => undefined;
    const runExpiryScan = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              checkedCount: 0,
              expiredCount: 0,
              expiringSoonCount: 0,
              notificationsSent: 0,
              reviewIds: [],
              runAt: new Date().toISOString(),
            });
        }),
    );
    const reviews = {
      runExpiryScan,
      getTimingConfig: () => ({ workflowEnabled: true }),
    } as unknown as RightsLawyerReviewService;
    const service = new RightsLawyerExpirySchedulerService(reviews, makeConfig(), makeRegistry());

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000); // fires the first tick, leaves it in flight

    // Force a second tick while the first is still unresolved.
    await (service as unknown as { runSweepSafely(): Promise<void> }).runSweepSafely();

    expect(runExpiryScan).toHaveBeenCalledTimes(1);
    release();
    service.onModuleDestroy();
  });
});
