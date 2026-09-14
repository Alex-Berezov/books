import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DEMO_QUEUE } from './queue.module';
import { QueueDemoStatsResponseDto } from './dto/queue-demo-stats-response.dto';

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

  /**
   * Выключенный контур — отказ, а не нулевое измерение (решение арбитра 14.09.2026,
   * `decisions-log.md`). До 14.09.2026 ветка «Redis не настроен» отдавала пустой объект,
   * а тип возврата был `Record<string, number>`: сторож схемы ответа такой тип прочитать
   * не может и держал маршрут в вердикте `unverifiable` (`LEGACY-016`).
   *
   * 🔴 Заменить пустой объект нулями было нельзя: тело `{"waiting":0,…,"failed":0}` байт
   * в байт совпадает с ответом живой пустой очереди, и оператор, разбирающий «задачи
   * не исполняются», видел бы здоровую подсистему там, где её нет вовсе (`L-015` — неизвестное
   * число, выданное за ноль). Поэтому здесь тот же отказ, что и у соседнего `enqueueDemo`:
   * один выключенный контур отвечает одинаково на обоих маршрутах.
   */
  async getDemoStats(): Promise<QueueDemoStatsResponseDto> {
    if (!this.demoQueue)
      throw new ServiceUnavailableException('Queue is not enabled (no Redis config)');
    const counts = await this.demoQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );
    // Шесть счётчиков названы поимённо, а не приведены целиком: `getJobCounts` типизован
    // как словарь, и приведение словаря к DTO вернуло бы сторожу непрозрачный тип.
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      paused: counts.paused ?? 0,
    };
  }
}
