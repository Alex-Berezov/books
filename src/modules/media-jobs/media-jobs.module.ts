import { Module, Provider } from '@nestjs/common';
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
const cleanupBootstrapProvider: Provider = {
  provide: 'MEDIA_CLEANUP_BOOTSTRAP',
  inject: [REDIS_CONNECTION, ConfigService, MediaCleanupService],
  useFactory: async (
    connection: IORedis | undefined,
    config: ConfigService,
    cleanup: MediaCleanupService,
  ): Promise<{ queue: Queue; worker: Worker } | undefined> => {
    if (!connection) return undefined;
    const enabled = !/^(0|false)$/i.test(config.get<string>('MEDIA_CLEANUP_ENABLED') ?? 'true');
    if (!enabled) return undefined;
    const name = config.get<string>('BULLMQ_MEDIA_CLEANUP_QUEUE') || CLEANUP_QUEUE_NAME_DEFAULT;
    const queue = new Queue(name, {
      connection: connection as unknown as QueueOptions['connection'],
    });
    // Schedule repeatable job (default every 24h at 03:15 UTC)
    const pattern = config.get<string>('MEDIA_CLEANUP_CRON') || '15 3 * * *';
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
    const flag = config.get<string>('BULLMQ_IN_PROCESS_WORKER');
    const inProcess = flag === undefined ? true : !/^(0|false)$/i.test(flag);
    const worker = inProcess
      ? new Worker(
          name,
          async () => {
            await cleanup.cleanup();
          },
          { connection: connection as unknown as WorkerOptions['connection'], concurrency: 1 },
        )
      : (undefined as unknown as Worker);
    return { queue, worker };
  },
};

@Module({
  imports: [ConfigModule, QueueModule, StorageModule],
  providers: [
    MediaProbeService,
    MediaCleanupService,
    probeQueueProvider,
    probeWorkerProvider,
    cleanupBootstrapProvider,
  ],
  controllers: [MediaJobsController],
  exports: [MediaProbeService, MediaCleanupService],
})
export class MediaJobsModule {}
