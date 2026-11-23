import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { utcTimestamp } from '../../../shared/prisma/utc-timestamp';
import { readStoredBlocks } from '../../book-world/book-world-data';
import {
  acceptedImageOf,
  WORLD_IMAGE_FILE_SELECT,
  WorldImageFile,
  worldImageAllowed,
} from '../../book-world/world-image-public';
import { moneyUsd } from '../../llm/dto/llm-money';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { LlmTaskService, stopOperationRows } from '../../llm-worker/llm-task.service';
import { DRAFT_LIMIT_FACTOR, DRAFT_TX_OPTIONS } from '../content-draft/content-draft.constants';
import { WorldImageFileDto, WorldImageStateDto } from '../dto/world-image-response.dto';
import {
  WORLD_IMAGE_CHANGED,
  WORLD_IMAGE_IN_PROGRESS,
  WORLD_IMAGE_NO_APPEARANCE,
  WORLD_IMAGE_NONE,
  WORLD_IMAGE_NOT_ALLOWED,
  WORLD_IMAGE_RESERVE_USD,
  WORLD_IMAGE_STAGE,
  WORLD_IMAGE_TASK_KIND,
} from './world-image.constants';

const IMAGE_SELECT = {
  imageReadAt: true,
  image: { select: WORLD_IMAGE_FILE_SELECT },
  pending: { select: WORLD_IMAGE_FILE_SELECT },
  operation: { select: { id: true, status: true, spentUsd: true } },
} as const satisfies Prisma.BookWorldImageSelect;

type ImageRow = Prisma.BookWorldImageGetPayload<{ select: typeof IMAGE_SELECT }>;

/** Герой версии, которому можно рисовать портрет; иначе - код отказа. */
export interface WorldPortraitSubject {
  bookId: string;
  appearance: string | null;
  allowed: boolean;
}

/** Строка картинки под замком и состояние её последней операции. */
export interface LockedImageRow {
  id: string;
  operationId: string | null;
  pendingMediaId: string | null;
  pendingDeleted: boolean | null;
  operationStatus: string | null;
  /** У операции есть задача `running`: шаг ещё идёт, даже если операция уже не `active`. */
  operationRunning: boolean;
}

const notAllowed = () =>
  llmTaskConflict(
    WORLD_IMAGE_NOT_ALLOWED,
    'Only a main or secondary character gets an illustration',
  );
const inProgress = () =>
  llmTaskConflict(WORLD_IMAGE_IN_PROGRESS, 'The illustration is being generated');

/**
 * Иллюстрация героя (`F08-11a`; решения арбитра `F08 | F08-11` Р2-Р5, `F08 | F08-11a` Q1, Q2). Строка
 * `BookWorldImage` - на книгу и ключ; кнопка «Generate»/«Regenerate» заводит операцию `draft` и
 * задачу исполнителя (модель ручка не зовёт - Р25 модуля LLM), результат ложится в ожидающую
 * ячейку; «Accept» переносит её в принятую. Запись строки - под замком строки (`FOR UPDATE`).
 */
@Injectable()
export class WorldImageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly budget: LlmBudgetService,
    private readonly tasks: LlmTaskService,
  ) {}

  async state(bookVersionId: string, key: string): Promise<WorldImageStateDto> {
    const subject = await this.subject(bookVersionId, key);
    const row = await this.prisma.bookWorldImage.findUnique({
      where: { bookId_key: { bookId: subject.bookId, key } },
      select: IMAGE_SELECT,
    });
    return this.toState(key, subject, row, moneyUsd(await this.callUpperBound()));
  }

  /**
   * «Generate» и «Regenerate» - одна кнопка (Р3): пишет только в ожидающую ячейку, принятая
   * картинка остаётся на сайте до нового «Accept». Вторая генерация до конца первой - 409;
   * стоящая на паузе операция картинки отменяется и заменяется новой (Q2).
   */
  async generate(
    bookVersionId: string,
    key: string,
    createdById: string,
  ): Promise<WorldImageStateDto> {
    const subject = await this.subject(bookVersionId, key);
    if (!subject.allowed) throw notAllowed();
    if (!subject.appearance) {
      throw llmTaskConflict(
        WORLD_IMAGE_NO_APPEARANCE,
        'The character has no appearance text: the portrait is drawn from it',
      );
    }
    this.llm.assertEnabled();
    if (await this.budget.ceilingReached()) {
      throw llmTaskConflict('LLM_CEILING_REACHED', 'LLM spending ceiling is reached');
    }
    const opData = await this.llm.operationData({
      kind: 'draft',
      bookVersionId,
      limitUsd: (await this.callUpperBound()).mul(DRAFT_LIMIT_FACTOR),
      createdById,
      contentKind: null,
    });
    await this.prisma.$transaction(async (tx) => {
      const row = await lockImageRow(tx, subject.bookId, key);
      if (row.operationId && row.operationStatus === 'paused') {
        // Пауза операции картинки - тупик: «Continue» ей нечего ставить (Q2). Пока её шаг идёт,
        // отмена ничего не освободит - 409; иначе отмена и новая операция.
        if (row.operationRunning) throw inProgress();
        const cancelled = await stopOperationRows(tx, row.operationId, 'cancelled', null);
        if (!cancelled) throw inProgress();
      } else if (row.operationStatus === 'active') {
        throw inProgress();
      }
      const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
      const queued = await this.tasks.enqueue(
        {
          kind: WORLD_IMAGE_TASK_KIND,
          operationId: op.id,
          bookVersionId,
          payload: { key },
          // Ключ пары - своей операции: задача прежней генерации, ещё `running`, не держит новую.
          pairKey: `${WORLD_IMAGE_TASK_KIND}:${op.id}`,
        },
        tx,
      );
      // Операция без задачи осталась бы `active` навсегда: откат всей транзакции.
      if (!queued.created) throw inProgress();
      await tx.bookWorldImage.update({ where: { id: row.id }, data: { operationId: op.id } });
    }, DRAFT_TX_OPTIONS);
    return this.state(bookVersionId, key);
  }

  /**
   * «Accept» (Р3): ожидающая - в принятую. Без живой ожидающей - 409 `WORLD_IMAGE_NONE`, чужая
   * ожидающая - 409 `WORLD_IMAGE_CHANGED`, сущность без права на картинку - 409 (Q1).
   */
  async accept(
    bookVersionId: string,
    key: string,
    pendingMediaId: string,
  ): Promise<WorldImageStateDto> {
    const subject = await this.subject(bookVersionId, key);
    if (!subject.allowed) throw notAllowed();
    await this.prisma.$transaction(async (tx) => {
      const row = await lockImageRow(tx, subject.bookId, key);
      if (!row.pendingMediaId || row.pendingDeleted) {
        throw llmTaskConflict(WORLD_IMAGE_NONE, 'There is no generated illustration to accept');
      }
      if (row.pendingMediaId !== pendingMediaId) {
        throw llmTaskConflict(WORLD_IMAGE_CHANGED, 'The illustration was regenerated: reload it');
      }
      await tx.bookWorldImage.update({
        where: { id: row.id },
        data: { imageMediaId: row.pendingMediaId, imageReadAt: new Date(), pendingMediaId: null },
      });
    }, DRAFT_TX_OPTIONS);
    return this.state(bookVersionId, key);
  }

  /**
   * Верхняя граница одной генерации: резерв картинки на основную и каждую запасную модель этапа -
   * оплаченный отказ основной (таймаут, обрыв) не должен закрыть дорогу запасной лимитом операции.
   */
  private async callUpperBound(): Promise<Prisma.Decimal> {
    const setting = await this.llm.getStageSetting(WORLD_IMAGE_STAGE);
    return WORLD_IMAGE_RESERVE_USD.mul(1 + setting.fallbacks.length);
  }

  /** Герой версии: книга, внешность и право на картинку (Р5). Нет сущности - 404. */
  private async subject(bookVersionId: string, key: string): Promise<WorldPortraitSubject> {
    const entity = await this.prisma.bookWorldEntity.findUnique({
      where: { bookVersionId_key: { bookVersionId, key } },
      select: { type: true, role: true, blocks: true, bookVersion: { select: { bookId: true } } },
    });
    if (!entity) throw new NotFoundException('World entity not found');
    return portraitSubject(entity);
  }

  private async toState(
    key: string,
    subject: WorldPortraitSubject,
    row: ImageRow | null,
    estimateUsd: string,
  ): Promise<WorldImageStateDto> {
    const op = row?.operation ?? null;
    const failed =
      op && op.status !== 'active' && op.status !== 'done'
        ? await this.prisma.llmTask.findFirst({
            where: { operationId: op.id, lastError: { not: null } },
            orderBy: { updatedAt: 'desc' },
            select: { lastError: true },
          })
        : null;
    // Принятая - тем же правилом, что видит сайт (`acceptedImageOf`), второй копии нет.
    const accepted = row ? acceptedImageOf(row) : null;
    return {
      key,
      allowed: subject.allowed && subject.appearance !== null,
      accepted: fileDto(accepted),
      acceptedAt: accepted && row ? row.imageReadAt : null,
      pending: fileDto(row?.pending && !row.pending.isDeleted ? row.pending : null),
      generation: op
        ? {
            operationId: op.id,
            status: op.status,
            failedReason: failed?.lastError ?? null,
            spentUsd: moneyUsd(op.spentUsd),
          }
        : null,
      estimateUsd,
    };
  }
}

/** Право на портрет (Р5, Q1): `worldImageAllowed`; внешность - блок «Внешность» этой версии. */
export function portraitSubject(entity: {
  type: string;
  role: string | null;
  blocks: Prisma.JsonValue;
  bookVersion: { bookId: string };
}): WorldPortraitSubject {
  const appearance = readStoredBlocks(entity.blocks).appearance?.trim() || null;
  return {
    bookId: entity.bookVersion.bookId,
    appearance,
    allowed: worldImageAllowed(entity),
  };
}

function fileDto(file: WorldImageFile | null): WorldImageFileDto | null {
  return file ? { mediaId: file.id, url: file.url, width: file.width, height: file.height } : null;
}

/**
 * Строка картинки под замком: заводится, если её нет (`ON CONFLICT DO NOTHING` - две первые
 * генерации не дают P2002, который оборвал бы транзакцию), и берётся `FOR UPDATE`. Статус операции,
 * её шаг и живость ожидающего файла читаются **отдельным оператором после замка** (L-019): при
 * `read committed` оператор, ждавший замка, видит соседние таблицы снимком до ожидания - вторая
 * «Generate» прочла бы операцию первой ещё не созданной и завела бы вторую оплаченную генерацию.
 */
export async function lockImageRow(
  tx: Prisma.TransactionClient,
  bookId: string,
  key: string,
): Promise<LockedImageRow> {
  const now = new Date();
  await tx.$executeRaw`
    INSERT INTO "BookWorldImage" ("id", "bookId", "key", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${bookId}, ${key}, ${utcTimestamp(now)}, ${utcTimestamp(now)})
    ON CONFLICT ("bookId", "key") DO NOTHING`;
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "BookWorldImage"
    WHERE "bookId" = ${bookId} AND "key" = ${key}
    FOR UPDATE`;
  const rows = await tx.$queryRaw<LockedImageRow[]>`
    SELECT i."id", i."operationId", i."pendingMediaId",
           m."isDeleted" AS "pendingDeleted",
           o."status"::text AS "operationStatus",
           EXISTS (
             SELECT 1 FROM "LlmTask" t
             WHERE t."operationId" = i."operationId" AND t."status" = 'running'
           ) AS "operationRunning"
    FROM "BookWorldImage" i
    LEFT JOIN "LlmOperation" o ON o."id" = i."operationId"
    LEFT JOIN "MediaAsset" m ON m."id" = i."pendingMediaId"
    WHERE i."id" = ${locked.id}`;
  return rows[0];
}
