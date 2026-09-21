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
import { MediaCleanupSchedulerService } from './media-cleanup-scheduler.service';
import { MediaJobsController } from './media-jobs.controller';

const PROBE_QUEUE_NAME_DEFAULT = 'media-probe';

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

@Module({
  imports: [BackgroundJobsRegistryModule, ConfigModule, QueueModule, StorageModule],
  providers: [
    MediaProbeService,
    MediaCleanupService,
    MediaCleanupSchedulerService,
    probeQueueProvider,
    probeWorkerProvider,
  ],
  controllers: [MediaJobsController],
  // Планировщик не экспортируется намеренно: его единственный потребитель — контроллер этого
  // же модуля. Экспорт сделал бы таймер внешней поверхностью модуля, и статус уборки стало бы
  // можно читать инжектом мимо `@Roles(Role.Admin)` на `GET /admin/media/cleanup-status`.
  exports: [MediaProbeService, MediaCleanupService],
})
export class MediaJobsModule implements OnModuleDestroy {
  constructor(
    @Optional() @Inject(MEDIA_PROBE_QUEUE) private readonly probeQueue?: Queue,
    @Optional() @Inject(MEDIA_PROBE_WORKER) private readonly probeWorker?: Worker,
  ) {}

  private readonly shutdownLogger = new Logger(MediaJobsModule.name);

  /**
   * 🔴 `LEGACY-364`. Прежняя версия глушила отказ через `catch { /* ignore *\/ }`,
   * но глушение ловит **отказ**, а не **зависание**: `Worker.close()` дублирует
   * связь для блокирующих операций и делает по дублю `quit()`, который на
   * переподключающейся связи не возвращается никогда (`maxRetriesPerRequest:
   * null` обязателен для BullMQ). Один такой воркер вешал всё выключение
   * приложения.
   *
   * Связь здесь не закрывается намеренно: она общая и принадлежит `QueueModule`.
   *
   * `media-cleanup` больше не держит здесь ни очередь, ни воркер (`LEGACY-059`,
   * пачка `W3`) — уборка теперь идёт таймером в `MediaCleanupSchedulerService`,
   * который останавливает свой `setTimeout` в собственном `onModuleDestroy` и
   * ничего не открывает по сети.
   */
  async onModuleDestroy() {
    await closeWithin(this.shutdownLogger, 'media probe worker', () => this.probeWorker?.close());
    await closeWithin(this.shutdownLogger, 'media probe queue', () => this.probeQueue?.close());
  }
}
