import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runInWorldTx } from './book-world-lock';
import { WORLD_OBJECT_TYPES } from './dto/book-world-blocks.dto';
import { markWorldMentionsDirty } from './world-mentions-queue';
import { relistWorldObjects, WORLD_OBJECTS } from './world-public';

/** Версий за один запрос пересчёта. */
export const WORLD_OBJECTS_RELIST_PAGE = 200;

/**
 * Разовый пересчёт `isListed` предметов, понятий и событий при старте (решение арбитра
 * `F08 | F08-13` Q6, пачка `F08-13c`, по образцу мест `F08 | F08-12a` R4): записанные при
 * выключенном рубильнике `WORLD_OBJECTS` выходят на сайт без повторной записи. Каждая версия — своей
 * транзакцией мира (`runInWorldTx`), поэтому запуск на нескольких экземплярах разводит замок, а повтор
 * ничего не пишет. Старт его не ждёт; отказ базы пишется в журнал и процесс не роняет. Снять
 * следующей пачкой.
 */
@Injectable()
export class WorldObjectsRelistService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorldObjectsRelistService.name);
  /** Идущий пересчёт: остановка модуля его дожидается, а не бросает на закрывающемся клиенте. */
  private running: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    if (!WORLD_OBJECTS.public) return;
    this.running = this.relistAll().then(
      ({ written, failed }) =>
        this.logger.log(
          `World objects relisted at startup: ${written} written, ${failed} versions failed`,
        ),
      (e: unknown) =>
        this.logger.error(
          'World objects relist did not run at startup',
          e instanceof Error ? e.stack : String(e),
        ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.running;
  }

  /**
   * Все версии с предметом, понятием или событием порциями по `WORLD_OBJECTS_RELIST_PAGE`: выборка
   * идёт по версиям, а не по строкам с `distinct` — Prisma режет `take` до `distinct`
   * (`LEGACY-254`). Отказ одной версии пишется в журнал, ставится в очередь пересчёта присутствия
   * и не обрывает остальные. Выключенный рубильник — без запросов. Число записанных строк и версий
   * с отказом.
   */
  async relistAll(): Promise<{ written: number; failed: number }> {
    const result = { written: 0, failed: 0 };
    if (!WORLD_OBJECTS.public) return result;
    let after: string | undefined;
    for (;;) {
      const page = await this.prisma.bookVersion.findMany({
        where: {
          worldEntities: { some: { type: { in: [...WORLD_OBJECT_TYPES] } } },
          ...(after ? { id: { gt: after } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: WORLD_OBJECTS_RELIST_PAGE,
      });
      for (const { id } of page) {
        try {
          result.written += await runInWorldTx(this.prisma, id, (tx, version) =>
            relistWorldObjects(tx, id, version, new Date()),
          );
        } catch (e: unknown) {
          result.failed++;
          this.logger.error(
            `World objects relist failed for version ${id}`,
            e instanceof Error ? e.stack : String(e),
          );
          await this.queueRecount(id);
        }
      }
      if (page.length < WORLD_OBJECTS_RELIST_PAGE) return result;
      after = page[page.length - 1].id;
    }
  }

  /**
   * Отказавшую версию дочитывает очередь пересчёта присутствия: пересчёт пишет `isListed` тем же
   * `worldListedWrite`, повторяет с паузой и переживает рестарт. Отказ постановки — строка журнала,
   * проход идёт дальше.
   */
  private async queueRecount(bookVersionId: string): Promise<void> {
    try {
      await markWorldMentionsDirty(this.prisma, bookVersionId);
    } catch (e: unknown) {
      this.logger.error(
        `World objects relist could not queue version ${bookVersionId} for recount`,
        e instanceof Error ? e.stack : String(e),
      );
    }
  }
}
