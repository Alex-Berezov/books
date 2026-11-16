import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { stableJson } from '../../shared/json/stable-json';
import { toJsonInput } from '../../shared/prisma/json-field.util';
import {
  BOOK_WORLD_SELECT,
  readStoredEntity,
  worldMentionSourceOf,
  type WorldEditorRow,
} from './book-world-data';
import { runInWorldTx, type WorldVersionState } from './book-world-lock';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import { computeWorldCore } from './world-core';
import { countWorldMentions, type StoredWorldMentions } from './world-mentions-count';
import { worldDerivedUnchanged, worldListedWrite } from './world-public';
import { deferWorldMentions, dueWorldMentions, requeueWorldMentions } from './world-mentions-queue';
import { versionFingerprint } from './world-quote-check';

/** Итог пересчёта версии: `retry` — главы или сущности сдвинулись во время подсчёта (R3a). */
export type WorldRecountOutcome = { status: 'done'; written: number } | { status: 'retry' };

/** Сколько версий из очереди берёт один проход. */
export const WORLD_MENTIONS_PASS_LIMIT = 5;

/**
 * Пересчёт присутствия мира книги по версии (`F08-2`, `tech.md` §4; решения арбитра `F08 | F08-2`
 * Q1–Q3). Подсчёт — до транзакции и вне замков; в транзакции мира (`runInWorldTx`) — сверка
 * отпечатков глав и `updatedAt` сущностей, затем запись через `worldListedWrite` с прежним
 * `updatedAt` (как отметки, R6). Неизменённые строки не пишутся.
 */
@Injectable()
export class WorldMentionsService {
  private readonly logger = new Logger(WorldMentionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Проход очереди: версии, осевшие `settleMs` по часам базы (перевод пишет главы по одной —
   * пауза собирает их в один пересчёт). Строка снимается только при том же `generation`, что взят
   * (решение арбитра R1). Ошибка подсчёта откладывает версию с нарастающей паузой (R3): одна
   * неисправная версия не держит голову очереди. Сдвиг текста или сущности во время подсчёта —
   * не сбой: строка перепоставляется на обычную осадку без роста попыток (R3a).
   */
  async recountPending(settleMs: number): Promise<{ versions: number; written: number }> {
    const due = await dueWorldMentions(this.prisma, settleMs, WORLD_MENTIONS_PASS_LIMIT);
    let written = 0;
    for (const row of due) {
      const taken = { bookVersionId: row.bookVersionId, generation: row.generation };
      let outcome: WorldRecountOutcome;
      try {
        outcome = await this.recountVersion(row.bookVersionId);
      } catch (e: unknown) {
        this.logger.error(
          `World mentions recount of ${row.bookVersionId} failed: ${e instanceof Error ? e.message : 'unknown error'}`,
        );
        await deferWorldMentions(this.prisma, taken);
        continue;
      }
      if (outcome.status === 'retry') {
        await requeueWorldMentions(this.prisma, taken);
        continue;
      }
      written += outcome.written;
      await this.prisma.worldMentionsPending.deleteMany({ where: taken });
    }
    return { versions: due.length, written };
  }

  async recountVersion(bookVersionId: string): Promise<WorldRecountOutcome> {
    const rows = await this.prisma.bookWorldEntity.findMany({
      where: { bookVersionId },
      select: BOOK_WORLD_SELECT,
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    });
    if (rows.length === 0) return { status: 'done', written: 0 };
    const counted = await countWorldMentions(
      this.prisma,
      bookVersionId,
      rows.map(worldMentionSourceOf),
    );
    const seen = new Map(rows.map((r) => [r.key, r.updatedAt.getTime()]));

    try {
      return await runInWorldTx(this.prisma, bookVersionId, async (tx, version) => {
        const current = await tx.bookWorldEntity.findMany({
          where: { bookVersionId },
          select: BOOK_WORLD_SELECT,
          orderBy: { key: 'asc' },
          take: BOOK_WORLD_LIMITS.entities,
        });
        const moved =
          current.length !== seen.size ||
          current.some((r) => seen.get(r.key) !== r.updatedAt.getTime()) ||
          counted.fingerprint !== (await versionFingerprint(tx, bookVersionId));
        if (moved) {
          this.logger.log(`World mentions of ${bookVersionId}: text moved during the count, retry`);
          return { status: 'retry' } as const;
        }
        let written = 0;
        const now = new Date();
        for (const row of current) {
          const mentions = counted.byKey.get(row.key);
          if (mentions && (await writeMentions(tx, bookVersionId, row, mentions, version, now))) {
            written++;
          }
        }
        return { status: 'done', written } as const;
      });
    } catch (e: unknown) {
      // Версию удалили: строка очереди ушла каскадом, пересчитывать нечего.
      if (e instanceof NotFoundException) return { status: 'done', written: 0 };
      throw e;
    }
  }
}

/**
 * Третий писатель сущности (после записи и отметок): `mentions`, ядро, `isListed` — заново;
 * `updatedAt` прежний (вкладка с прежним `expectedUpdatedAt` не ловит 409), `autoTextAt` и `readAt`
 * не трогаются (Q2). `mentionsAt` — только когда `mentions` изменились (Q4). `false` — писать нечего.
 */
async function writeMentions(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
  row: WorldEditorRow,
  mentions: StoredWorldMentions,
  version: WorldVersionState,
  now: Date,
): Promise<boolean> {
  const core = computeWorldCore({ ...readStoredEntity(row), mentions });
  const coreMissing = core.missing.map((m) => m.part);
  const listed = worldListedWrite({ ...row, mentions, hasCore: core.hasCore }, version, now);
  const mentionsChanged = stableJson(row.mentions) !== stableJson(mentions);
  // Колонки числа глав и первой главы — вместе с `mentions`; строка, у которой они пусты при тех же
  // `mentions` (записана до колонки), получает их без сдвига `mentionsAt`.
  const chaptersColumnStale =
    row.mentionChapters !== mentions.chapters.length || row.mentionFirst !== mentions.first;
  if (
    !mentionsChanged &&
    !chaptersColumnStale &&
    worldDerivedUnchanged(row, { hasCore: core.hasCore, coreMissing }, listed)
  ) {
    return false;
  }
  await tx.bookWorldEntity.update({
    where: { bookVersionId_key: { bookVersionId, key: row.key } },
    data: {
      ...(mentionsChanged ? { mentions: toJsonInput(mentions), mentionsAt: now } : {}),
      ...(mentionsChanged || chaptersColumnStale
        ? { mentionChapters: mentions.chapters.length, mentionFirst: mentions.first }
        : {}),
      hasCore: core.hasCore,
      coreMissing,
      ...listed,
      updatedAt: row.updatedAt,
    },
  });
  return true;
}
