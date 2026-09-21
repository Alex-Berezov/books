import { MediaJobsModule } from './media-jobs.module';
import type { Queue, Worker } from 'bullmq';

/**
 * 🔴 `LEGACY-364`. До 03.09.2026 закрытие здесь стояло под `catch { /* ignore *\/ }`.
 * Глушение ловит **отказ**, но не **зависание**: `Worker.close()` дублирует связь
 * для блокирующих операций и делает по дублю `quit()`, который на
 * переподключающейся связи не возвращается никогда. Один такой воркер вешал
 * выключение всего приложения.
 *
 * Без этого набора откат файла к прежнему виду прошёл бы мимо всех проверок.
 *
 * `media-cleanup` больше не участвует здесь (`LEGACY-059`, пачка `W3`) — очередь
 * и воркер убраны, уборка идёт таймером `MediaCleanupSchedulerService`, у него
 * своя посадка в `media-cleanup-scheduler.service.spec.ts`.
 */
describe('MediaJobsModule — закрытие завершается всегда (LEGACY-364)', () => {
  const build = (parts: { probeQueue?: Partial<Queue>; probeWorker?: Partial<Worker> }) =>
    new MediaJobsModule(parts.probeQueue as Queue, parts.probeWorker as Worker);

  it('зависший воркер не отменяет закрытие очереди', async () => {
    const probeWorker = { close: jest.fn(() => new Promise<void>(() => {})) };
    const probeQueue = { close: jest.fn().mockResolvedValue(undefined) };

    const started = Date.now();
    await build({ probeWorker, probeQueue }).onModuleDestroy();

    expect(probeQueue.close).toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('отказ закрытия воркера не отменяет закрытие очереди', async () => {
    const probeWorker = { close: jest.fn().mockRejectedValue(new Error('воркер не закрылся')) };
    const probeQueue = { close: jest.fn().mockResolvedValue(undefined) };

    await build({ probeWorker, probeQueue }).onModuleDestroy();

    expect(probeQueue.close).toHaveBeenCalled();
  });

  it('без поднятой очереди закрытие проходит молча', async () => {
    // Redis не настроен: провайдеры отдают undefined.
    await expect(build({}).onModuleDestroy()).resolves.toBeUndefined();
  });
});
