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
 */
describe('MediaJobsModule — закрытие завершается всегда (LEGACY-364)', () => {
  const build = (parts: {
    probeQueue?: Partial<Queue>;
    probeWorker?: Partial<Worker>;
    cleanupQueue?: Partial<Queue>;
    cleanupWorker?: Partial<Worker>;
  }) =>
    new MediaJobsModule(
      parts.probeQueue as Queue,
      parts.probeWorker as Worker,
      parts.cleanupQueue as Queue,
      parts.cleanupWorker as Worker,
    );

  it('зависший воркер не отменяет закрытие остальных ресурсов', async () => {
    const probeWorker = { close: jest.fn(() => new Promise<void>(() => {})) };
    const cleanupWorker = { close: jest.fn().mockResolvedValue(undefined) };
    const probeQueue = { close: jest.fn().mockResolvedValue(undefined) };
    const cleanupQueue = { close: jest.fn().mockResolvedValue(undefined) };

    const started = Date.now();
    await build({ probeWorker, cleanupWorker, probeQueue, cleanupQueue }).onModuleDestroy();

    expect(cleanupWorker.close).toHaveBeenCalled();
    expect(probeQueue.close).toHaveBeenCalled();
    expect(cleanupQueue.close).toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('отказ одного закрытия не отменяет соседние', async () => {
    const probeWorker = { close: jest.fn().mockRejectedValue(new Error('воркер не закрылся')) };
    const cleanupQueue = { close: jest.fn().mockResolvedValue(undefined) };

    await build({ probeWorker, cleanupQueue }).onModuleDestroy();

    expect(cleanupQueue.close).toHaveBeenCalled();
  });

  it('без поднятых очередей закрытие проходит молча', async () => {
    // MEDIA_CLEANUP_ENABLED=false или Redis не настроен: провайдеры отдают undefined.
    await expect(build({}).onModuleDestroy()).resolves.toBeUndefined();
  });
});
