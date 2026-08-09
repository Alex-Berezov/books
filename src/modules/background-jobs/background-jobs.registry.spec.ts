import { Logger } from '@nestjs/common';
import { BackgroundJobsRegistry } from './background-jobs.registry';
import { BackgroundJobsService } from './background-jobs.service';

/**
 * `tasks/background-jobs-visibility/TASK.md`.
 *
 * За одну неделю нашлись три механизма, которые не выполнялись, и ни один не
 * подал признака. Общее у всех трёх — отсутствие работы **неотличимо от
 * нормальной работы**: ни ошибки, ни метрики, ни строки в логе.
 */
describe('BackgroundJobsRegistry', () => {
  const active = { name: 'a', state: 'ACTIVE' as const, schedule: 'daily', purpose: 'p' };

  it('keeps every registered mechanism, in registration order', () => {
    const registry = new BackgroundJobsRegistry();
    registry.register(active);
    registry.register({ name: 'b', state: 'DISABLED', reason: 'no REDIS_URL', purpose: 'p' });

    expect(registry.list().map((j) => j.name)).toEqual(['a', 'b']);
    expect(registry.summary().counts).toEqual({ ACTIVE: 1, DEGRADED: 0, DISABLED: 1 });
  });

  /**
   * 🔴 «Выключено» без «почему» отправляет читателя искать ответ в код — то есть
   * ровно туда, откуда эта задача его выводит.
   */
  it('complains when a non-active state comes without a reason', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new BackgroundJobsRegistry().register({ name: 'a', state: 'DISABLED', purpose: 'p' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('must say why');
    warn.mockRestore();
  });

  // Два механизма под одним именем делают один из них невидимым — то самое
  // состояние, которого задача и не допускает.
  it('complains when two mechanisms share a name', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = new BackgroundJobsRegistry();
    registry.register(active);
    registry.register({ ...active, schedule: 'hourly' });

    expect(warn.mock.calls.some((c) => String(c[0]).includes('registered twice'))).toBe(true);
    expect(registry.list()).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('BackgroundJobsService', () => {
  /**
   * 🔴 Строка печатается **всегда**, в том числе когда всё активно: именно
   * молчание три раза подряд и оказалось неотличимо от работы.
   */
  it('logs a line for a healthy mechanism too', () => {
    const registry = new BackgroundJobsRegistry();
    registry.register({
      name: 'taxonomy-indexability-sweep',
      state: 'ACTIVE',
      schedule: 'daily at 03:00 UTC',
      purpose: 'p',
    });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    new BackgroundJobsService(registry).onApplicationBootstrap();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('taxonomy-indexability-sweep');
    expect(log.mock.calls[0][0]).toContain('daily at 03:00 UTC');
    log.mockRestore();
  });

  // Причина обязана дойти до лога: без неё строка сообщает о проблеме и не
  // говорит, что с ней делать.
  it('names the reason a mechanism is not running', () => {
    const registry = new BackgroundJobsRegistry();
    registry.register({
      name: 'media-cleanup',
      state: 'DISABLED',
      reason: 'no REDIS_URL / REDIS_HOST',
      purpose: 'p',
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    new BackgroundJobsService(registry).onApplicationBootstrap();

    expect(warn.mock.calls[0][0]).toContain('no REDIS_URL');
    warn.mockRestore();
  });

  /**
   * 🔴 Пустой реестр — не «механизмов нет», а «никто не зарегистрировался».
   * Разница существенная: сломанная регистрация выглядела бы как здоровый старт,
   * то есть инвентарь воспроизвёл бы дефект, который призван закрывать.
   */
  it('treats an empty registry as a failure, not as a clean bill of health', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    new BackgroundJobsService(new BackgroundJobsRegistry()).onApplicationBootstrap();

    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
