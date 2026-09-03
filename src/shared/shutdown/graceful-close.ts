import { Logger } from '@nestjs/common';

/**
 * 🔴 `LEGACY-364`. Закрытие ресурса при выключении обязано **завершаться**.
 *
 * Причина, по которой одного `try/catch` мало: и `Queue`, и `Worker`, и
 * `QueueEvents` в BullMQ закрываются через `RedisConnection.close()`, а тот на
 * неразделяемой связи делает `await this._client.quit()`
 * (`bullmq/dist/cjs/classes/redis-connection.js`). `Worker` вдобавок **дублирует**
 * переданную связь для блокирующих операций (`worker.js`, `shared: false`), и
 * дубль наследует `maxRetriesPerRequest: null` — он обязателен для BullMQ.
 * На такой связи команда ждёт восстановления **вечно**, поэтому `quit()` после
 * обрыва не возвращается, а вместе с ним не возвращается и `app.close()`.
 *
 * ⚠️ Ограничение стоит на **завершении процесса**, а не на проверке. Разница
 * существенная: подгонка проверки прячет дефект, а здесь единственная
 * альтернатива ограничению — висеть до внешнего таймаута, оставив живыми сокеты
 * и таймеры переподключения ioredis. `catch {}` этот случай не ловит вовсе:
 * глушение ловит отказ, но не зависание.
 */
export const CLOSE_GRACE_MS = 2000;

const delay = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ms).unref());

/**
 * Закрывает ресурс, не давая его отказу или зависанию остановить закрытие соседей.
 *
 * Отказ и превышение срока пишутся в лог, а не глушатся молча: тихий `catch {}`
 * уже прятал причину один раз.
 */
export async function closeWithin(
  logger: Logger,
  what: string,
  close: () => Promise<unknown> | undefined,
  ms: number = CLOSE_GRACE_MS,
): Promise<void> {
  try {
    const result = await Promise.race([Promise.resolve(close()), delay(ms)]);
    if (result === 'timeout') {
      logger.warn(`Закрытие «${what}» не уложилось в ${ms} мс — выключение продолжается без него`);
    }
  } catch (error) {
    logger.warn(
      `Не удалось закрыть «${what}»: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
