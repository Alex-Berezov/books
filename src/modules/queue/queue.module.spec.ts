import { QueueModule } from './queue.module';
import type { Queue, QueueEvents, Worker } from 'bullmq';
import type IORedis from 'ioredis';

/**
 * 🔴 `LEGACY-364`. Закрытие приложения обязано **завершаться**.
 *
 * `connection.quit()` — это команда Redis, а у связи BullMQ стоит
 * `maxRetriesPerRequest: null` (он обязателен для блокирующих операций). На
 * переподключающейся связи такая команда ждёт восстановления вечно, и
 * `app.close()` висит до внешнего таймаута — в e2e это `Exceeded timeout of
 * 30000 ms for a hook` при всех зелёных тестах.
 *
 * Каждый кейс ниже краснеет на своём откате: верните голые `await` подряд —
 * и «связь закрывается, даже если очередь упала» покраснеет; уберите гонку
 * с `disconnect()` — покраснеет «зависший quit не держит закрытие».
 */
describe('QueueModule — закрытие завершается всегда (LEGACY-364)', () => {
  const build = (parts: {
    worker?: Partial<Worker>;
    queueEvents?: Partial<QueueEvents>;
    queue?: Partial<Queue>;
    connection?: Partial<IORedis>;
  }) =>
    new QueueModule(
      parts.worker as Worker,
      parts.queueEvents as QueueEvents,
      parts.queue as Queue,
      parts.connection as IORedis,
    );

  it('зависший quit не держит закрытие — сокет рвётся disconnect-ом', async () => {
    const disconnect = jest.fn();
    // Никогда не разрешается — ровно то, что делает `quit()` на порванной связи.
    const connection = { quit: jest.fn(() => new Promise<'OK'>(() => {})), disconnect };

    const started = Date.now();
    await build({ connection }).onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
    // Ограничение — 2 с; проверяем порядок величины, а не точное значение.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('зависший worker.close() не держит закрытие и не отменяет остальные', async () => {
    // 🔴 Именно этот путь оставался открытым в первой версии правки. `Worker`
    // дублирует связь для блокирующих операций (`shared: false`) и в `close()`
    // делает `quit()` по дублю — тупик наступал раньше, чем дело доходило до
    // связи модуля, поэтому защиты одного `connection.quit()` не хватало.
    const disconnect = jest.fn();
    const quit = jest.fn().mockResolvedValue('OK' as const);
    const worker = { close: jest.fn(() => new Promise<void>(() => {})) };
    const queue = { close: jest.fn().mockResolvedValue(undefined) };

    const started = Date.now();
    await build({ worker, queue, connection: { quit, disconnect } }).onModuleDestroy();

    expect(queue.close).toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('связь закрывается, даже если очередь упала при закрытии', async () => {
    const disconnect = jest.fn();
    const quit = jest.fn().mockResolvedValue('OK' as const);
    const worker = { close: jest.fn().mockRejectedValue(new Error('воркер не закрылся')) };
    const queue = { close: jest.fn().mockRejectedValue(new Error('очередь не закрылась')) };

    await build({ worker, queue, connection: { quit, disconnect } }).onModuleDestroy();

    // Отказ соседа не отменяет ни остальных закрытий, ни закрытия связи.
    expect(queue.close).toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('без настроенной связи закрытие проходит молча', async () => {
    // Локальный прогон без Redis: провайдеры отдают undefined, падать не на чем.
    await expect(build({}).onModuleDestroy()).resolves.toBeUndefined();
  });
});
