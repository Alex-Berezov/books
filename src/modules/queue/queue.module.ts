import { Module, Provider, OnModuleDestroy, Inject, Optional, Logger } from '@nestjs/common';
import { closeWithin } from '../../shared/shutdown/graceful-close';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BackgroundJobsRegistryModule } from '../background-jobs/background-jobs-registry.module';
import {
  Queue,
  Worker,
  QueueEvents,
  QueueOptions,
  WorkerOptions,
  QueueEventsOptions,
} from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { QueueService } from './queue.service';
import { QueueController } from './queue.controller';
// RolesGuard/PrismaService are provided globally via SecurityModule/PrismaModule

export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');
export const DEMO_QUEUE = Symbol('DEMO_QUEUE');
export const DEMO_QUEUE_EVENTS = Symbol('DEMO_QUEUE_EVENTS');

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

const demoQueueProvider: Provider = {
  provide: DEMO_QUEUE,
  inject: [REDIS_CONNECTION, ConfigService, BackgroundJobsRegistry],
  useFactory: (
    connection: IORedis | undefined,
    config: ConfigService,
    registry: BackgroundJobsRegistry,
  ): Queue | undefined => {
    // Регистрация стоит внутри той же ветки, что и создание очереди, — иначе
    // отчёт и реальность разъедутся, а расходящийся отчёт хуже отсутствующего.
    if (!connection) {
      registry.register({
        name: 'demo-queue',
        state: 'DISABLED',
        reason: 'no REDIS_URL / REDIS_HOST',
        purpose: 'Demonstration queue; carries no product traffic',
      });
      return undefined;
    }
    const name = config.get<string>('BULLMQ_DEMO_QUEUE') || 'demo';
    registry.register({
      name: 'demo-queue',
      state: 'ACTIVE',
      schedule: 'on demand',
      purpose: 'Demonstration queue; carries no product traffic',
    });

    const conn = connection as unknown as QueueOptions['connection'];
    const opts: QueueOptions = { connection: conn };
    return new Queue(name, opts);
  },
};

const demoQueueEventsProvider: Provider = {
  provide: DEMO_QUEUE_EVENTS,
  inject: [REDIS_CONNECTION, ConfigService],
  useFactory: (connection: IORedis | undefined, config: ConfigService): QueueEvents | undefined => {
    if (!connection) return undefined;
    const name = config.get<string>('BULLMQ_DEMO_QUEUE') || 'demo';

    const conn = connection as unknown as QueueEventsOptions['connection'];
    const opts: QueueEventsOptions = { connection: conn };
    return new QueueEvents(name, opts);
  },
};

const demoWorkerProvider: Provider = {
  provide: 'DEMO_WORKER',
  inject: [REDIS_CONNECTION, ConfigService],
  useFactory: (connection: IORedis | undefined, config: ConfigService): Worker | undefined => {
    if (!connection) return undefined;
    // Allow disabling in-process worker (for prod where worker runs as a separate process)
    const flag = config.get<string>('BULLMQ_IN_PROCESS_WORKER');
    const inProcess = flag === undefined ? true : !/^(0|false)$/i.test(flag);
    if (!inProcess) return undefined;
    const concurrency = Number(config.get<string>('BULLMQ_DEMO_CONCURRENCY') ?? '2');
    const name = config.get<string>('BULLMQ_DEMO_QUEUE') || 'demo';

    const conn = connection as unknown as WorkerOptions['connection'];
    const opts: WorkerOptions = { connection: conn, concurrency };
    return new Worker<{ delayMs?: number }>(
      name,
      async (job) => {
        const ms = Number(job.data?.delayMs ?? 10);
        await new Promise((r) => setTimeout(r, ms));
        return { ok: true, at: new Date().toISOString() } as const;
      },
      opts,
    );
  },
};

@Module({
  imports: [BackgroundJobsRegistryModule, ConfigModule],
  providers: [
    redisProvider,
    demoQueueProvider,
    demoQueueEventsProvider,
    demoWorkerProvider,
    QueueService,
  ],
  controllers: [QueueController],
  exports: [QueueService, REDIS_CONNECTION, DEMO_QUEUE, DEMO_QUEUE_EVENTS],
})
export class QueueModule implements OnModuleDestroy {
  constructor(
    @Optional() @Inject('DEMO_WORKER') private readonly worker?: Worker,
    @Optional() @Inject(DEMO_QUEUE_EVENTS) private readonly queueEvents?: QueueEvents,
    @Optional() @Inject(DEMO_QUEUE) private readonly queue?: Queue,
    @Optional() @Inject(REDIS_CONNECTION) private readonly connection?: IORedis,
  ) {}

  private readonly logger = new Logger(QueueModule.name);

  /**
   * 🔴 `LEGACY-364`. Закрытие обязано **завершаться**, а не только быть вежливым.
   *
   * Прежняя версия шла четырьмя голыми `await` подряд. Отказ любого из первых трёх
   * не давал дойти до связи, а `quit()` на переподключающейся связи не возвращается
   * вовсе: это команда, а у связи BullMQ стоит `maxRetriesPerRequest: null`
   * (обязателен для блокирующих операций), поэтому команды ждут восстановления вечно.
   *
   * ⚠️ Ограничены **все** закрытия, а не только `quit()`. `Worker` дублирует связь
   * для блокирующих операций (`shared: false`) и в `close()` делает `quit()` уже
   * по дублю — то есть тот же тупик наступал бы раньше, чем дело дойдёт до связи
   * модуля, и защита одного `quit()` не спасала. Причина ограничения — в
   * `shared/shutdown/graceful-close.ts`.
   *
   * `disconnect()` зовётся всегда: он рвёт сокет немедленно и снимает таймеры
   * переподключения, тогда как `quit()` ждёт ответа сервера.
   */
  async onModuleDestroy() {
    await closeWithin(this.logger, 'demo worker', () => this.worker?.close());
    await closeWithin(this.logger, 'demo queue events', () => this.queueEvents?.close());
    await closeWithin(this.logger, 'demo queue', () => this.queue?.close());

    const connection = this.connection;
    if (!connection) return;

    await closeWithin(this.logger, 'redis quit', () => connection.quit());
    // Идемпотентен и синхронен: повторный вызов после успешного `quit()` безвреден.
    connection.disconnect();
  }
}
