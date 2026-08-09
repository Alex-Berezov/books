import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { BackgroundJobsRegistry } from './background-jobs.registry';

/**
 * Печатает инвентарь фоновых механизмов при старте приложения.
 *
 * 🔴 Строка печатается **всегда**, в том числе когда всё активно. Молчание не
 * должно ничего означать: именно молчание три раза подряд и оказалось
 * неотличимо от работы.
 */
@Injectable()
export class BackgroundJobsService implements OnApplicationBootstrap {
  private readonly logger = new Logger('BackgroundJobs');

  constructor(private readonly registry: BackgroundJobsRegistry) {}

  onApplicationBootstrap(): void {
    const jobs = this.registry.list();

    if (jobs.length === 0) {
      // Пустой реестр — не «механизмов нет», а «никто не зарегистрировался».
      // Разница существенная: молчащий инвентарь ровно так и выглядел бы.
      this.logger.error(
        'No background mechanism registered itself. Either the application really has none, ' +
          'or registration broke — and the second case looks exactly like a healthy start.',
      );
      return;
    }

    const width = Math.max(...jobs.map((job) => job.name.length));
    for (const job of jobs) {
      const detail =
        job.state === 'ACTIVE'
          ? job.schedule
            ? `(${job.schedule})`
            : ''
          : `(${job.reason ?? 'no reason given'})`;
      const line = `${job.name.padEnd(width)}  ${job.state} ${detail}`.trimEnd();

      // Уровень по состоянию: выключенный механизм — не ошибка (его могли
      // выключить намеренно), но и не рядовая строка, которую взгляд пропустит.
      if (job.state === 'ACTIVE') this.logger.log(line);
      else this.logger.warn(line);
    }
  }
}
