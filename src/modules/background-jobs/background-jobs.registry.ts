import { Injectable, Logger } from '@nestjs/common';

/**
 * Что механизм делает на самом деле.
 *
 * Три состояния, а не два, потому что «работает» и «не работает» не покрывают
 * реальный случай: probe медиа без очереди не умирает, а выполняется прямо в
 * HTTP-запросе на загрузку — без ретраев и внутри цикла ответа. Это не отказ, но
 * и не то, что задумано, и слить его с `ACTIVE` значило бы снова сделать
 * отклонение невидимым.
 */
export type BackgroundJobState = 'ACTIVE' | 'DEGRADED' | 'DISABLED';

export interface BackgroundJobStatus {
  /** Устойчивое имя механизма. Оно же ключ в ответе эндпоинта. */
  name: string;
  state: BackgroundJobState;
  /**
   * Причина — обязательна для `DEGRADED` и `DISABLED` и запрещена быть пустой:
   * «выключено» без «почему» отправляет читателя искать ответ в код, то есть
   * ровно туда, откуда эта задача его и выводит.
   */
  reason?: string;
  /** Расписание для активных: «daily at 03:00 UTC», «every 6h». */
  schedule?: string;
  /** Одна фраза о том, что механизм делает, — для того, кто видит имя впервые. */
  purpose: string;
}

/**
 * Реестр фоновых механизмов приложения.
 *
 * 🔴 Заведён потому, что за одну неделю нашлись **три** механизма, которые не
 * выполнялись, и ни один не подал признака: пересчёт индексируемости не
 * отрабатывал ни разу с момента добавления, суточная уборка медиа не
 * регистрировалась вовсе, холодный старт пересчёта требовал ручного SQL.
 * Общее у всех трёх — отсутствие работы **неотличимо от нормальной работы**:
 * ни ошибки, ни метрики, ни строки в логе.
 *
 * ⚠️ Механизмы регистрируются **сами**, а не перечисляются списком в одном
 * месте. Список пришлось бы поддерживать, следующий механизм в него забыли бы
 * вписать — и задача вернулась бы в том же виде.
 *
 * ⚠️ И регистрироваться механизм обязан **в той же ветке кода, которая
 * принимает решение** — там, где очередь создаётся или не создаётся. Отдельный
 * «репортёр», повторяющий то же условие, разошёлся бы с реальностью, а
 * расходящийся отчёт хуже отсутствующего: ему верят.
 */
@Injectable()
export class BackgroundJobsRegistry {
  private readonly logger = new Logger(BackgroundJobsRegistry.name);
  private readonly jobs = new Map<string, BackgroundJobStatus>();

  register(status: BackgroundJobStatus): void {
    if (status.state !== 'ACTIVE' && !status.reason) {
      // Не бросаем: инвентарь не вправе ронять приложение. Но и молча принять
      // «выключено без причины» нельзя — это возвращает исходную проблему.
      this.logger.warn(
        `Background job "${status.name}" reported ${status.state} without a reason. ` +
          'A state that is not ACTIVE must say why.',
      );
    }

    if (this.jobs.has(status.name)) {
      this.logger.warn(
        `Background job "${status.name}" registered twice — the later registration wins. ` +
          'Two mechanisms sharing a name make one of them invisible.',
      );
    }

    this.jobs.set(status.name, status);
  }

  /** Все механизмы, в порядке регистрации. */
  list(): BackgroundJobStatus[] {
    return [...this.jobs.values()];
  }

  /**
   * Сводка для эндпоинта. `ok` означает лишь «нет ничего неожиданно выключенного
   * по технической причине» — намеренно выключенный флагом механизм это не
   * нарушение, и алерт по нему был бы ложным.
   */
  summary(): {
    checkedAt: string;
    counts: Record<BackgroundJobState, number>;
    jobs: BackgroundJobStatus[];
  } {
    const jobs = this.list();
    const counts: Record<BackgroundJobState, number> = { ACTIVE: 0, DEGRADED: 0, DISABLED: 0 };
    for (const job of jobs) counts[job.state] += 1;

    return { checkedAt: new Date().toISOString(), counts, jobs };
  }
}
