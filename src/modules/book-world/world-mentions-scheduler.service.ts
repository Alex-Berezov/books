import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { WorldMentionsService } from './world-mentions.service';

/** Пауза между проходами очереди пересчёта. */
export const WORLD_MENTIONS_TICK_MS = 15_000;
/**
 * Версия берётся не раньше, чем через столько после последней правки: перевод пишет главы по одной,
 * и пересчёт после каждой главы был бы лишней работой (решение арбитра `F08 | F08-2` Q1).
 */
export const WORLD_MENTIONS_SETTLE_MS = 10_000;

/**
 * Планировщик пересчёта присутствия мира книги (`F08-2`): проход очереди `WorldMentionsPending`
 * таймером в процессе, как `MediaCleanupSchedulerService`. Ключа окружения нет: подсчёт не зовёт
 * модель и ничего не удаляет. При нескольких экземплярах строка очереди не захватывается: каждый
 * посчитает одну и ту же версию (лишняя работа процессора), а записи разведёт замок мира — второй
 * пересчёт ничего не пишет (хвост в журнале техдолга, F08-2).
 */
@Injectable()
export class WorldMentionsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorldMentionsSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private isRunning = false;
  /** Идущий проход: остановка модуля его дожидается, а не бросает на закрывающемся клиенте. */
  private running: Promise<void> | null = null;

  constructor(
    private readonly mentions: WorldMentionsService,
    private readonly backgroundJobs: BackgroundJobsRegistry,
  ) {}

  onModuleInit(): void {
    this.scheduleNext();
    this.backgroundJobs.register({
      name: 'world-mentions-recount',
      state: 'ACTIVE',
      schedule: `every ${WORLD_MENTIONS_TICK_MS / 1000}s`,
      purpose: 'Recounts book world mentions by chapter after chapters or name forms change',
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = null;
        this.scheduleNext();
      });
    }, WORLD_MENTIONS_TICK_MS);
    this.timer.unref?.();
  }

  /** Исключение прохода не останавливает расписание: строка очереди остаётся до следующего. */
  async tick(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.mentions.recountPending(WORLD_MENTIONS_SETTLE_MS);
    } catch (e: unknown) {
      this.logger.error(
        `World mentions recount failed: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    } finally {
      this.isRunning = false;
    }
  }
}
