import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DEMO_QUEUE } from './queue.module';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(@Optional() @Inject(DEMO_QUEUE) private readonly demoQueue?: Queue) {}

  isEnabled(): boolean {
    return !!this.demoQueue;
  }

  status(): { enabled: boolean } {
    return { enabled: this.isEnabled() };
  }

  async enqueueDemo(data: Record<string, unknown> = {}): Promise<{ id: string | undefined }> {
    if (!this.demoQueue)
      throw new ServiceUnavailableException('Queue is not enabled (no Redis config)');
    const job = await this.demoQueue.add('demo', data, {
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    this.logger.debug(`Enqueued demo job ${job.id}`);
    return { id: job.id as string };
  }

  async getDemoStats(): Promise<Record<string, number>> {
    if (!this.demoQueue) return {};
    const counts = await this.demoQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );
    return counts as unknown as Record<string, number>;
  }
}
