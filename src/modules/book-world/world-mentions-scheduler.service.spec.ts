import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import {
  WORLD_MENTIONS_SETTLE_MS,
  WORLD_MENTIONS_TICK_MS,
  WorldMentionsSchedulerService,
} from './world-mentions-scheduler.service';
import type { WorldMentionsService } from './world-mentions.service';

/**
 * F08-2: планировщик пересчёта присутствия (решение арбитра `F08 | F08-2` Q1). Таймер, пауза
 * осевших правок, проход без наложения, ошибка не рвёт расписание, регистрация механизма.
 */
const NOW = new Date('2026-11-15T12:00:00.000Z');

function setup(recount: jest.Mock = jest.fn().mockResolvedValue({ versions: 0, written: 0 })) {
  const registry = new BackgroundJobsRegistry();
  const service = new WorldMentionsSchedulerService(
    { recountPending: recount } as unknown as WorldMentionsService,
    registry,
  );
  return { service, registry, recount };
}

describe('WorldMentionsSchedulerService (F08-2)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('регистрируется ACTIVE с расписанием', async () => {
    const { service, registry } = setup();
    service.onModuleInit();
    expect(registry.list()).toEqual([
      expect.objectContaining({
        name: 'world-mentions-recount',
        state: 'ACTIVE',
        schedule: `every ${WORLD_MENTIONS_TICK_MS / 1000}s`,
      }),
    ]);
    await service.onModuleDestroy();
  });

  it('проход берёт только осевшие правки: пауза передаётся очереди (часы базы)', async () => {
    const { service, recount } = setup();
    await service.tick();
    expect(recount).toHaveBeenCalledTimes(1);
    expect(recount).toHaveBeenCalledWith(WORLD_MENTIONS_SETTLE_MS);
  });

  it('таймер зовёт проход раз в такт и заводится снова после прохода', async () => {
    const { service, recount } = setup();
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(WORLD_MENTIONS_TICK_MS - 1);
    expect(recount).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(recount).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(WORLD_MENTIONS_TICK_MS);
    expect(recount).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('остановка модуля дожидается идущего прохода и новый не заводит', async () => {
    let finish: () => void = () => {};
    const recount = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ versions: 0, written: 0 });
        }),
    );
    const { service } = setup(recount);
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(WORLD_MENTIONS_TICK_MS);
    expect(recount).toHaveBeenCalledTimes(1);
    let destroyed = false;
    const destroy = service.onModuleDestroy().then(() => (destroyed = true));
    await Promise.resolve();
    expect(destroyed).toBe(false);
    finish();
    await destroy;
    expect(destroyed).toBe(true);
    await jest.advanceTimersByTimeAsync(WORLD_MENTIONS_TICK_MS * 3);
    expect(recount).toHaveBeenCalledTimes(1);
  });

  it('проход не накладывается на незаконченный', async () => {
    const pending: Array<() => void> = [];
    const recount = jest.fn(
      () =>
        new Promise<{ versions: number; written: number }>((resolve) => {
          pending.push(() => resolve({ versions: 0, written: 0 }));
        }),
    );
    const { service } = setup(recount);
    const first = service.tick();
    await service.tick();
    expect(recount).toHaveBeenCalledTimes(1);
    pending.forEach((resolve) => resolve());
    await first;
    // Прошлый проход кончился — следующий снова идёт (не дожидаемся: его обещание не разрешается).
    void service.tick();
    expect(recount).toHaveBeenCalledTimes(2);
  });

  it('ошибка прохода не рвёт расписание и не залипает в «идёт проход»', async () => {
    const recount = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ versions: 0, written: 0 });
    const { service } = setup(recount);
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(WORLD_MENTIONS_TICK_MS);
    await jest.advanceTimersByTimeAsync(WORLD_MENTIONS_TICK_MS);
    expect(recount).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('после onModuleDestroy проходов нет', async () => {
    const { service, recount } = setup();
    service.onModuleInit();
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(WORLD_MENTIONS_TICK_MS * 3);
    expect(recount).not.toHaveBeenCalled();
  });
});
