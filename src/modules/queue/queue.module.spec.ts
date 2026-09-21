import { QueueModule } from './queue.module';
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
 * `QueueModule` с 21.09.2026 (`LEGACY-059`, пачка `W3`) хостит только
 * соединение — демо-очередь, её воркер и `QueueEvents` сняты как мёртвый код,
 * поэтому конструктор здесь принимает только `connection`.
 */
describe('QueueModule — закрытие завершается всегда (LEGACY-364)', () => {
  const build = (connection?: Partial<IORedis>) => new QueueModule(connection as IORedis);

  it('зависший quit не держит закрытие — сокет рвётся disconnect-ом', async () => {
    const disconnect = jest.fn();
    // Никогда не разрешается — ровно то, что делает `quit()` на порванной связи.
    const connection = { quit: jest.fn(() => new Promise<'OK'>(() => {})), disconnect };

    const started = Date.now();
    await build(connection).onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
    // Ограничение — 2 с; проверяем порядок величины, а не точное значение.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('quit успешно разрешается — disconnect всё равно зовётся следом', async () => {
    const disconnect = jest.fn();
    const quit = jest.fn().mockResolvedValue('OK' as const);

    await build({ quit, disconnect }).onModuleDestroy();

    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('без настроенной связи закрытие проходит молча', async () => {
    // Локальный прогон без Redis: провайдер отдаёт undefined, падать не на чем.
    await expect(build().onModuleDestroy()).resolves.toBeUndefined();
  });
});
