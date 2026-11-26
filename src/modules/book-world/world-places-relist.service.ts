import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runInWorldTx } from './book-world-lock';
import { markWorldMentionsDirty } from './world-mentions-queue';
import { relistWorldPlaces, WORLD_PLACES } from './world-public';

/** Версий за один запрос пересчёта. */
export const WORLD_PLACES_RELIST_PAGE = 200;

/**
 * Разовый пересчёт `isListed` мест при старте (решение арбитра `F08 | F08-12a` R4, пачка
 * `F08-12c`): места, записанные при выключенном рубильнике `WORLD_PLACES`, выходят на сайт без
 * повторной записи. Каждая версия — своей транзакцией мира (`runInWorldTx`), поэтому запуск на
 * нескольких экземплярах разводит замок, а повтор ничего не пишет. Старт его не ждёт; отказ базы
 * пишется в журнал и процесс не роняет. Убрать в `F08-12d`.
 */
@Injectable()
export class WorldPlacesRelistService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorldPlacesRelistService.name);
  /** Идущий пересчёт: остановка модуля его дожидается, а не бросает на закрывающемся клиенте. */
  private running: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    if (!WORLD_PLACES.public) return;
    this.running = this.relistAll().then(
      ({ written, failed }) =>
        this.logger.log(
          `World places relisted at startup: ${written} written, ${failed} versions failed`,
        ),
      (e: unknown) =>
        this.logger.error(
          'World places relist did not run at startup',
          e instanceof Error ? e.stack : String(e),
        ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.running;
  }

  /**
   * Все версии с местами порциями по `WORLD_PLACES_RELIST_PAGE`: выборка идёт по версиям
   * (`BookVersion` с местом), а не по строкам мест с `distinct` — Prisma режет `take` до `distinct`
   * (`LEGACY-254`), и порция кончалась бы раньше. Отказ одной версии (версию удалили, замок мира
   * занят дольше `maxWait`) пишется в журнал, ставится в очередь пересчёта присутствия и не обрывает
   * остальные. Выключенный рубильник —
   * без запросов. Число записанных мест и версий с отказом.
   */
  async relistAll(): Promise<{ written: number; failed: number }> {
    const result = { written: 0, failed: 0 };
    if (!WORLD_PLACES.public) return result;
    let after: string | undefined;
    for (;;) {
      const page = await this.prisma.bookVersion.findMany({
        where: {
          worldEntities: { some: { type: 'place' } },
          ...(after ? { id: { gt: after } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: WORLD_PLACES_RELIST_PAGE,
      });
      for (const { id } of page) {
        try {
          result.written += await runInWorldTx(this.prisma, id, (tx, version) =>
            relistWorldPlaces(tx, id, version, new Date()),
          );
        } catch (e: unknown) {
          result.failed++;
          this.logger.error(
            `World places relist failed for version ${id}`,
            e instanceof Error ? e.stack : String(e),
          );
          await this.queueRecount(id);
        }
      }
      if (page.length < WORLD_PLACES_RELIST_PAGE) return result;
      after = page[page.length - 1].id;
    }
  }

  /**
   * Отказавшую версию дочитывает очередь пересчёта присутствия (решение арбитра `F08 | F08-12c`
   * о закрытии после круга 2): пересчёт пишет `isListed` мест тем же `worldListedWrite`, повторяет
   * с паузой и переживает рестарт. Отказ постановки — строка журнала, проход идёт дальше.
   */
  private async queueRecount(bookVersionId: string): Promise<void> {
    try {
      await markWorldMentionsDirty(this.prisma, bookVersionId);
    } catch (e: unknown) {
      this.logger.error(
        `World places relist could not queue version ${bookVersionId} for recount`,
        e instanceof Error ? e.stack : String(e),
      );
    }
  }
}
