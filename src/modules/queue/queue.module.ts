import { Module, Provider, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  Queue,
  Worker,
  QueueEvents,
  QueueOptions,
  WorkerOptions,
  QueueEventsOptions,
} from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';
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
  inject: [REDIS_CONNECTION, ConfigService],
  useFactory: (connection: IORedis | undefined, config: ConfigService): Queue | undefined => {
    if (!connection) return undefined;
    const name = config.get<string>('BULLMQ_DEMO_QUEUE') || 'demo';

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
  imports: [ConfigModule],
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

  async onModuleDestroy() {
    // Graceful shutdown: close worker, queue, events, and Redis connection
    if (this.worker) {
      await this.worker.close();
    }
    if (this.queueEvents) {
      await this.queueEvents.close();
    }
    if (this.queue) {
      await this.queue.close();
    }
    if (this.connection) {
      await this.connection.quit();
    }
  }
}
