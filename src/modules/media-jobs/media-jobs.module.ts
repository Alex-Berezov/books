import { Module, Provider, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Queue, QueueOptions, Worker, WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { QueueModule, REDIS_CONNECTION } from '../queue/queue.module';
import { StorageModule } from '../../shared/storage/storage.module';
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

const probeQueueProvider: Provider = {
  provide: MEDIA_PROBE_QUEUE,
  inject: [REDIS_CONNECTION, ConfigService],
  useFactory: (connection: IORedis | undefined, config: ConfigService): Queue | undefined => {
    if (!connection) return undefined;
    const name = config.get<string>('BULLMQ_MEDIA_PROBE_QUEUE') || PROBE_QUEUE_NAME_DEFAULT;
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
const cleanupQueueProvider: Provider = {
  provide: MEDIA_CLEANUP_QUEUE,
  inject: [REDIS_CONNECTION, ConfigService],
  useFactory: async (
    connection: IORedis | undefined,
    config: ConfigService,
  ): Promise<Queue | undefined> => {
    if (!connection) return undefined;
    const enabled = !/^(0|false)$/i.test(config.get<string>('MEDIA_CLEANUP_ENABLED') ?? 'true');
    if (!enabled) return undefined;
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
  imports: [ConfigModule, QueueModule, StorageModule],
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

  async onModuleDestroy() {
    for (const resource of [this.probeWorker, this.cleanupWorker]) {
      try {
        if (resource) await resource.close();
      } catch {
        /* ignore */
      }
    }
    for (const resource of [this.probeQueue, this.cleanupQueue]) {
      try {
        if (resource) await resource.close();
      } catch {
        /* ignore */
      }
    }
  }
}
