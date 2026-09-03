import { Module, Provider, OnModuleDestroy, Inject, Optional, Logger } from '@nestjs/common';
import { closeWithin } from '../../shared/shutdown/graceful-close';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Queue, QueueOptions, Worker, WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { QueueModule, REDIS_CONNECTION } from '../queue/queue.module';
import { StorageModule } from '../../shared/storage/storage.module';
import { BackgroundJobsRegistryModule } from '../background-jobs/background-jobs-registry.module';
import {
  MEDIA_PROBE_QUEUE,
  MEDIA_PROBE_WORKER,
  MediaProbeJobData,
  MediaProbeService,
} from './media-probe.service';
import { MediaCleanupService } from './media-cleanup.service';
import { MediaJobsController } from './media-jobs.controller';

const PROBE_QUEUE_NAME_DEFAULT = 'media-probe';
const CLEANUP_QUEUE_NAME_DEFAULT = 'media-cleanup';
const MEDIA_CLEANUP_QUEUE = Symbol('MEDIA_CLEANUP_QUEUE');
const MEDIA_CLEANUP_WORKER = Symbol('MEDIA_CLEANUP_WORKER');

const PROBE_PURPOSE = 'Reads audio metadata (duration, bitrate) from an uploaded file';

const probeQueueProvider: Provider = {
  provide: MEDIA_PROBE_QUEUE,
  inject: [REDIS_CONNECTION, ConfigService, BackgroundJobsRegistry],
  useFactory: (
    connection: IORedis | undefined,
    config: ConfigService,
    registry: BackgroundJobsRegistry,
  ): Queue | undefined => {
    // 🔴 DEGRADED, а не DISABLED: без очереди `enqueueProbe` не умирает, а
    // выполняет `runProbe` **синхронно, внутри HTTP-запроса на загрузку** — без
    // ретраев, которые были в очереди (`attempts: 3` + backoff). Это не отказ,
    // но и не то, что задумано; слить его с ACTIVE значило бы снова сделать
    // отклонение невидимым.
    if (!connection) {
      registry.register({
        name: 'media-probe',
        state: 'DEGRADED',
        reason: 'no REDIS_URL / REDIS_HOST — runs inline in the upload request, without retries',
        purpose: PROBE_PURPOSE,
      });
      return undefined;
    }
    const name = config.get<string>('BULLMQ_MEDIA_PROBE_QUEUE') || PROBE_QUEUE_NAME_DEFAULT;
    registry.register({
      name: 'media-probe',
      state: 'ACTIVE',
      schedule: 'on upload',
      purpose: PROBE_PURPOSE,
    });
    const opts: QueueOptions = { connection: connection as unknown as QueueOptions['connection'] };
    return new Queue(name, opts);
  },
};

const probeWorkerProvider: Provider = {
  provide: MEDIA_PROBE_WORKER,
  inject: [REDIS_CONNECTION, ConfigService, MediaProbeService],
  useFactory: (
    connection: IORedis | undefined,
    config: ConfigService,
    probe: MediaProbeService,
  ): Worker | undefined => {
    if (!connection) return undefined;
    const flag = config.get<string>('BULLMQ_IN_PROCESS_WORKER');
    const inProcess = flag === undefined ? true : !/^(0|false)$/i.test(flag);
    if (!inProcess) return undefined;
    const name = config.get<string>('BULLMQ_MEDIA_PROBE_QUEUE') || PROBE_QUEUE_NAME_DEFAULT;
    const concurrency = Number(config.get<string>('BULLMQ_MEDIA_PROBE_CONCURRENCY') ?? '2');
    const opts: WorkerOptions = {
      connection: connection as unknown as WorkerOptions['connection'],
      concurrency,
    };
    return new Worker<MediaProbeJobData>(
      name,
      async (job) => probe.runProbe(job.data.mediaId),
      opts,
    );
  },
};

/** Repeatable cleanup job wiring. Adds a daily repeatable job; worker runs inline. */
const CLEANUP_PURPOSE = 'Deletes media assets nothing references any more (orphans)';

const cleanupQueueProvider: Provider = {
  provide: MEDIA_CLEANUP_QUEUE,
  inject: [REDIS_CONNECTION, ConfigService, BackgroundJobsRegistry],
  useFactory: async (
    connection: IORedis | undefined,
    config: ConfigService,
    registry: BackgroundJobsRegistry,
  ): Promise<Queue | undefined> => {
    if (!connection) {
      registry.register({
        name: 'media-cleanup',
        state: 'DISABLED',
        reason: 'no REDIS_URL / REDIS_HOST',
        purpose: CLEANUP_PURPOSE,
      });
      return undefined;
    }
    const enabled = !/^(0|false)$/i.test(config.get<string>('MEDIA_CLEANUP_ENABLED') ?? 'true');
    if (!enabled) {
      registry.register({
        name: 'media-cleanup',
        state: 'DISABLED',
        reason: 'MEDIA_CLEANUP_ENABLED is off',
        purpose: CLEANUP_PURPOSE,
      });
      return undefined;
    }
    const name = config.get<string>('BULLMQ_MEDIA_CLEANUP_QUEUE') || CLEANUP_QUEUE_NAME_DEFAULT;
    const queue = new Queue(name, {
      connection: connection as unknown as QueueOptions['connection'],
    });
    const pattern = config.get<string>('MEDIA_CLEANUP_CRON') || '15 3 * * *';
    try {
      await queue.add(
        'cleanup',
        {},
        {
          repeat: { pattern },
          jobId: 'media-cleanup-repeatable',
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    } catch {
      /* best-effort scheduling */
    }
    registry.register({
      name: 'media-cleanup',
      state: 'ACTIVE',
      schedule: `cron ${pattern} UTC`,
      purpose: CLEANUP_PURPOSE,
    });
    return queue;
  },
};

const cleanupWorkerProvider: Provider = {
  provide: MEDIA_CLEANUP_WORKER,
  inject: [REDIS_CONNECTION, ConfigService, MediaCleanupService],
  useFactory: (
    connection: IORedis | undefined,
    config: ConfigService,
    cleanup: MediaCleanupService,
  ): Worker | undefined => {
    if (!connection) return undefined;
    const enabled = !/^(0|false)$/i.test(config.get<string>('MEDIA_CLEANUP_ENABLED') ?? 'true');
    if (!enabled) return undefined;
    const flag = config.get<string>('BULLMQ_IN_PROCESS_WORKER');
    const inProcess = flag === undefined ? true : !/^(0|false)$/i.test(flag);
    if (!inProcess) return undefined;
    const name = config.get<string>('BULLMQ_MEDIA_CLEANUP_QUEUE') || CLEANUP_QUEUE_NAME_DEFAULT;
    return new Worker(
      name,
      async () => {
        await cleanup.cleanup();
      },
      { connection: connection as unknown as WorkerOptions['connection'], concurrency: 1 },
    );
  },
};

@Module({
  imports: [BackgroundJobsRegistryModule, ConfigModule, QueueModule, StorageModule],
  providers: [
    MediaProbeService,
    MediaCleanupService,
    probeQueueProvider,
    probeWorkerProvider,
    cleanupQueueProvider,
    cleanupWorkerProvider,
  ],
  controllers: [MediaJobsController],
  exports: [MediaProbeService, MediaCleanupService],
})
export class MediaJobsModule implements OnModuleDestroy {
  constructor(
    @Optional() @Inject(MEDIA_PROBE_QUEUE) private readonly probeQueue?: Queue,
    @Optional() @Inject(MEDIA_PROBE_WORKER) private readonly probeWorker?: Worker,
    @Optional() @Inject(MEDIA_CLEANUP_QUEUE) private readonly cleanupQueue?: Queue,
    @Optional() @Inject(MEDIA_CLEANUP_WORKER) private readonly cleanupWorker?: Worker,
  ) {}

  private readonly shutdownLogger = new Logger(MediaJobsModule.name);

  /**
   * 🔴 `LEGACY-364`, тот же класс, что и в `QueueModule`. Прежняя версия глушила
   * отказ через `catch { /* ignore *\/ }`, но глушение ловит **отказ**, а не
   * **зависание**: `Worker.close()` дублирует связь для блокирующих операций и
   * делает по дублю `quit()`, который на переподключающейся связи не возвращается
   * никогда (`maxRetriesPerRequest: null` обязателен для BullMQ). Один такой
   * воркер вешал всё выключение приложения.
   *
   * Связь здесь не закрывается намеренно: она общая и принадлежит `QueueModule`.
   */
  async onModuleDestroy() {
    await closeWithin(this.shutdownLogger, 'media probe worker', () => this.probeWorker?.close());
    await closeWithin(this.shutdownLogger, 'media cleanup worker', () =>
      this.cleanupWorker?.close(),
    );
    await closeWithin(this.shutdownLogger, 'media probe queue', () => this.probeQueue?.close());
    await closeWithin(this.shutdownLogger, 'media cleanup queue', () => this.cleanupQueue?.close());
  }
}
