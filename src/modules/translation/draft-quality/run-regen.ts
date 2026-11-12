import { ConflictException, HttpException } from '@nestjs/common';
import { ContentDraft, LlmOperation, LlmTask, Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';

/**
 * Общее у ходов пересказа (`F06-2`) и анализа (`F07-1b`): задача хода и перегенерации одного текста
 * или блока своей операцией, поиск строки хода по отметке перегенерации, снятие отметки, состояние
 * операций перегенераций в ответе и «Accept all» по одному (решение арбитра `F07 | F07-1a`, К2:
 * одна функция вместо копий в двух ходах).
 */

/** Вид строки хода с перегенерациями. */
export type RunKind = 'summary_write' | 'analysis_write';

type Db = Prisma.TransactionClient | PrismaService;

/** Задача хода (`index` нет) или перегенерации текста или блока `index` (`F06-2` Р2). */
export function runTaskInput(
  kind: string,
  row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
  operationId: string,
  index: number | null,
): EnqueueTaskInput {
  return {
    kind,
    operationId,
    bookVersionId: row.bookVersionId,
    language: row.language,
    payload: index === null ? { draftId: row.id } : { draftId: row.id, index },
    pairKey: index === null ? `${operationId}:${row.id}` : `${operationId}:${row.id}:${index}`,
  };
}

/** Строка хода и номер текста или блока перегенерации из задачи; не той формы - `null`. */
export function runTaskPayload(task: LlmTask): { draftId: string | null; index: number | null } {
  const p = (task.payload ?? {}) as Record<string, unknown>;
  return {
    draftId: typeof p.draftId === 'string' ? p.draftId : null,
    index: Number.isInteger(p.index) ? (p.index as number) : null,
  };
}

/**
 * Путь jsonpath к операциям перегенераций в `ContentDraft.data` - та же отметка, что ищет `regenProbe`
 * (`items[].regen.operationId`); только строки. Переносить отметку - вместе с обоими.
 */
export const REGEN_OPERATION_PATH = '$.items[*].regen.operationId ? (@.type() == "string")';

/** Запрос `data @>`: у текста или блока хода идёт перегенерация операцией `operationId`. */
const regenProbe = (operationId: string): string =>
  JSON.stringify({ items: [{ regen: { operationId } }] });

/**
 * Строка хода вида `kind` с отметкой перегенерации операции `operationId` (Р2): `findUnique` по
 * `operationId` её не находит - операция перегенерации не своя у строки. `readyOnly` - только у
 * хода `ready` («Continue»); снятие отметки ищет строку в любом статусе.
 */
async function regenRowOf(
  db: Db,
  kind: RunKind,
  operationId: string,
  readyOnly: boolean,
): Promise<{ id: string; bookVersionId: string } | null> {
  const rows = await db.$queryRaw<Array<{ id: string; bookVersionId: string }>>`
    SELECT "id", "bookVersionId" FROM "ContentDraft"
    WHERE "kind" = ${kind}::"ContentDraftKind"
      ${readyOnly ? Prisma.sql`AND "status" = 'ready'` : Prisma.empty}
      AND "data" @> ${regenProbe(operationId)}::jsonb
    LIMIT 1`;
  return rows[0] ?? null;
}

/** Элемент хода с отметкой перегенерации - общая форма текстов пересказа и блоков анализа. */
interface RegenMarked {
  regen: { operationId: string } | null;
}

/**
 * «Continue» операции перегенерации: строка по отметке, задача - только пока перегенерация её
 * (`index` - место текста или блока с отметкой).
 */
export async function regenResumeOf(
  prisma: PrismaService,
  kind: RunKind,
  op: Pick<LlmOperation, 'id'>,
  itemsOf: (data: unknown) => readonly RegenMarked[],
  taskOf: (row: ContentDraft, operationId: string, index: number) => EnqueueTaskInput,
): Promise<EnqueueTaskInput[]> {
  const found = await regenRowOf(prisma, kind, op.id, true);
  if (!found) return [];
  const row = await prisma.contentDraft.findUnique({ where: { id: found.id } });
  if (!row) return [];
  const index = itemsOf(row.data).findIndex((i) => i.regen?.operationId === op.id);
  return index < 0 ? [] : [taskOf(row, op.id, index)];
}

/**
 * Снятие отметки перегенерации `operationId` в транзакции отмены или конца задачи: строка по
 * отметке, замок вида (`lock`), перечитанные данные; `clear` - данные без отметки у `index`.
 */
export async function clearRegenMarkOf<D extends { items: readonly RegenMarked[] }>(
  tx: Prisma.TransactionClient,
  kind: RunKind,
  operationId: string,
  options: {
    lock: (tx: Prisma.TransactionClient, bookVersionId: string) => Promise<void>;
    read: (data: unknown) => D;
    clear: (data: D, index: number) => Prisma.InputJsonValue;
  },
): Promise<void> {
  const found = await regenRowOf(tx, kind, operationId, false);
  if (!found) return;
  await options.lock(tx, found.bookVersionId);
  const row = await tx.contentDraft.findUnique({ where: { id: found.id } });
  if (!row) return;
  const data = options.read(row.data);
  const index = data.items.findIndex((i) => i.regen?.operationId === operationId);
  if (index < 0) return;
  await tx.contentDraft.update({
    where: { id: row.id },
    data: { data: options.clear(data, index) },
  });
}

/** Операции перегенераций, идущих у текстов или блоков хода. */
export const regenOperationIds = (items: readonly RegenMarked[]): string[] =>
  items.flatMap((i) => (i.regen ? [i.regen.operationId] : []));

export type RegenOperationState = Pick<LlmOperation, 'id' | 'status' | 'pauseReason'>;

/** Статус и причина паузы операций перегенераций (`F06-5c`) - одним запросом по идущим. */
async function regenOperationStates(
  prisma: PrismaService,
  ids: readonly string[],
): Promise<ReadonlyMap<string, RegenOperationState>> {
  if (ids.length === 0) return new Map();
  const ops = await prisma.llmOperation.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, status: true, pauseReason: true },
  });
  return new Map(ops.map((op) => [op.id, op] as const));
}

/** Поля перегенерации элемента в ответе хода. */
export function regenFieldsOf(
  regen: { operationId: string } | null,
  states: ReadonlyMap<string, RegenOperationState>,
) {
  const op = regen ? states.get(regen.operationId) : undefined;
  return {
    regenerating: regen !== null,
    regenOperationId: regen?.operationId ?? null,
    regenOperationStatus: op?.status ?? null,
    regenPauseReason: op?.pauseReason ?? null,
  };
}

/**
 * «Accept all» по одному (`F06-2` `tech.md` §5, `F07-1b`). `next` выбирает следующее предложение по уже
 * принятым (`null` - больше нечего), `accept` его пишет и возвращает `false`, если пропустил. Отказ 409
 * уходит с тем же телом и списком уже записанного `acceptedIndexes`, пустым тоже: клиент отличает
 * «ничего не записано» от «неизвестно» (ревью `F06-3`; `api-contracts.md` - `acceptedIndexes` в 409). С
 * `anyHttp` (ход анализа; решение арбитра `F07 | F07-1b` по /fix 1, п.6) так же, своим статусом, уходит
 * любой отказ ручки; у пересказа 400 и 404 - как были. Прочие исключения - как есть.
 */
export async function acceptInTurn(
  next: (accepted: readonly number[]) => Promise<number | null> | number | null,
  accept: (index: number) => Promise<boolean | void>,
  options: { anyHttp?: boolean } = {},
): Promise<number[]> {
  const accepted: number[] = [];
  for (let index = await next(accepted); index !== null; index = await next(accepted)) {
    let taken: boolean | void;
    try {
      taken = await accept(index);
    } catch (error) {
      const wrap =
        error instanceof ConflictException ||
        (options.anyHttp === true && error instanceof HttpException);
      if (wrap) {
        const body = error.getResponse();
        const payload = {
          ...(typeof body === 'object' ? body : { message: body }),
          acceptedIndexes: [...accepted],
          // На каком пункте встали: клиент не угадывает его по списку (T174, п.5).
          stoppedIndex: index,
        };
        throw error instanceof ConflictException
          ? new ConflictException(payload)
          : new HttpException(payload, error.getStatus());
      }
      throw error;
    }
    // `false` - предложение пропущено (`next` его больше не выбирает), записанным оно не считается.
    if (taken !== false) accepted.push(index);
  }
  return accepted;
}

/** Строка хода, на которую указывает задача (`null` - в задаче нет id или строки уже нет). */
export async function draftRowOf(db: PrismaService, task: LlmTask): Promise<ContentDraft | null> {
  const { draftId } = runTaskPayload(task);
  return draftId ? db.contentDraft.findUnique({ where: { id: draftId } }) : null;
}

/** Перегенерации - каждая своей отменой со снятием отметки (операция раньше замка хода). */
export async function cancelRegens(
  tasks: Pick<LlmTaskService, 'cancelOperation'>,
  handler: { clearRegenMark(operationId: string, tx: Prisma.TransactionClient): Promise<void> },
  operationIds: readonly string[],
): Promise<void> {
  for (const operationId of operationIds) {
    await tasks.cancelOperation(operationId, (tx) => handler.clearRegenMark(operationId, tx));
  }
}

/** Порция чтения прежних ходов на старте: выборка в память - с пределом строк, ходы - все. */
export const PREVIOUS_BATCH = 100;

/**
 * Ручной старт отбрасывает все прежние `ready`/`failed` ходы версии вида `kind`; операции их
 * перегенераций читаются порциями по `id` (выборка в память - с пределом строк, решение арбитра
 * `T177 | F07-1a`), из jsonb - только идентификаторы, без `data` целиком под замком; отменяются
 * после коммита - отдаются наружу.
 */
export async function discardPrevious(
  tx: Prisma.TransactionClient,
  versionId: string,
  kind: RunKind,
): Promise<string[]> {
  const stale = new Set<string>();
  for (let after: string | null = null; ; ) {
    const page: Array<{ id: string; operationIds: unknown }> = await tx.$queryRaw`
      SELECT "id",
        CASE WHEN jsonb_typeof("data") = 'object'
          THEN jsonb_path_query_array("data", ${REGEN_OPERATION_PATH}::jsonpath)
          ELSE '[]'::jsonb END AS "operationIds"
      FROM "ContentDraft"
      WHERE "bookVersionId" = ${versionId}
        AND "kind" = ${kind}::"ContentDraftKind"
        AND "status" IN ('ready', 'failed')
        ${after === null ? Prisma.empty : Prisma.sql`AND "id" > ${after}`}
      ORDER BY "id"
      LIMIT ${PREVIOUS_BATCH}`;
    for (const row of page) {
      if (!Array.isArray(row.operationIds)) continue;
      for (const id of row.operationIds) if (typeof id === 'string') stale.add(id);
    }
    if (page.length < PREVIOUS_BATCH) break;
    after = page[page.length - 1].id;
  }
  await tx.contentDraft.updateMany({
    where: { bookVersionId: versionId, kind, status: { in: ['ready', 'failed'] } },
    data: { status: 'discarded' },
  });
  return [...stale];
}

/**
 * Что ждёт строящийся ход (`dossier` или `glossary`) и статус перегенераций - два независимых
 * запроса вместе.
 */
export async function waitingAndRegens(
  db: PrismaService,
  row: Pick<ContentDraft, 'waitingFor' | 'status'>,
  regenIds: readonly string[],
): Promise<{
  waitingFor: 'dossier' | 'glossary' | null;
  regenOps: ReadonlyMap<string, RegenOperationState>;
}> {
  const waiting = row.waitingFor && row.status === 'building' ? row.waitingFor : null;
  const [glossary, regenOps] = await Promise.all([
    waiting === null
      ? null
      : db.bookGlossary.findUnique({ where: { id: waiting }, select: { id: true } }),
    regenOperationStates(db, regenIds),
  ]);
  return { waitingFor: waiting === null ? null : glossary ? 'glossary' : 'dossier', regenOps };
}
