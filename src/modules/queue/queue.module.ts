import { Module, Provider, OnModuleDestroy, Inject, Optional, Logger } from '@nestjs/common';
import { closeWithin } from '../../shared/shutdown/graceful-close';
import { ConfigModule, ConfigService } from '@nestjs/config';
import IORedis, { RedisOptions } from 'ioredis';

export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');

function buildConnectionOpts(config: ConfigService): RedisOptions | string | null {
  const url = config.get<string>('REDIS_URL');
  const hostEnv = config.get<string>('REDIS_HOST');
  if (!url && !hostEnv) return null;
  if (url) return url;
  const host = hostEnv ?? '127.0.0.1';
  const port = Number(config.get<string>('REDIS_PORT') ?? '6379');
  const password = config.get<string>('REDIS_PASSWORD') || undefined;
  const redisOptions: RedisOptions = {
    host,
    port,
    password,
    // BullMQ requires maxRetriesPerRequest: null for blocking operations (Worker, QueueEvents)
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
  return redisOptions;
}

const redisProvider: Provider = {
  provide: REDIS_CONNECTION,
  inject: [ConfigService],
  useFactory: (config: ConfigService): IORedis | undefined => {
    const opts = buildConnectionOpts(config);
    if (!opts) return undefined;
    if (typeof opts === 'string') {
      // BullMQ requires maxRetriesPerRequest: null for blocking operations
      return new IORedis(opts, { maxRetriesPerRequest: null });
    }

    return new IORedis(opts);
  },
};

/**
 * Хостит только соединение с Redis для настоящих потребителей BullMQ
 * (сейчас — только `media-probe` в `media-jobs.module.ts`).
 *
 * 🔴 Демонстрационная очередь `demo`/`DEMO_QUEUE` снята как мёртвый код
 * (`LEGACY-059`, решение владельца 21.09.2026, пачка `W3`): она не несла
 * продуктового трафика ни дня, только показывала, что BullMQ вообще подключен.
 * Вместе с ней сняты `QueueController` и `QueueService` — их единственным
 * назначением были ручки `/queues/status` и `/queues/demo/*`.
 */
@Module({
  imports: [ConfigModule],
  providers: [redisProvider],
  exports: [REDIS_CONNECTION],
})
export class QueueModule implements OnModuleDestroy {
  constructor(@Optional() @Inject(REDIS_CONNECTION) private readonly connection?: IORedis) {}

  private readonly logger = new Logger(QueueModule.name);

  /**
   * 🔴 `LEGACY-364`. Закрытие обязано **завершаться**, а не только быть вежливым.
   *
   * `quit()` — команда Redis, а у связи BullMQ стоит `maxRetriesPerRequest: null`
   * (обязателен для блокирующих операций), поэтому на переподключающейся связи
   * она не возвращается вовсе.
   *
   * `disconnect()` зовётся всегда: он рвёт сокет немедленно и снимает таймеры
   * переподключения, тогда как `quit()` ждёт ответа сервера.
   */
  async onModuleDestroy() {
    const connection = this.connection;
    if (!connection) return;

    await closeWithin(this.logger, 'redis quit', () => connection.quit());
    // Идемпотентен и синхронен: повторный вызов после успешного `quit()` безвреден.
    connection.disconnect();
  }
}
