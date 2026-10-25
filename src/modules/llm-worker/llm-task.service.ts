import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Language, LlmPauseReason, LlmTask, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { utcTimestamp } from '../../shared/prisma/utc-timestamp';
import { LlmConfig } from '../llm/llm.config';
import { LlmWorkerConfig } from './llm-worker.config';
import {
  LlmTaskStepResult,
  RETRY_IN_PROGRESS,
  RUN_ACTIVE,
  TRANSLATION_RETRY_KIND,
} from './llm-task.types';
import { LlmTaskLeaseLostError, llmTaskConflict } from './llm-worker.errors';

/** Переход операции вместе с её задачами - короткие условные UPDATE (`L-020`). */
const TASK_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

export interface EnqueueTaskInput {
  kind: string;
  operationId: string;
  bookVersionId?: string | null;
  language?: Language | null;
  chunkId?: string | null;
  /** Без текста книги. */
  payload?: Prisma.InputJsonObject;
  /**
   * «операция:язык» у задач пары (Р1), «операция:строка» у досье и глоссария (`F05-2`); пусто -
   * задача без пары.
   */
  pairKey?: string | null;
  runAfter?: Date;
}

export type EnqueueResult = { created: true; task: LlmTask } | { created: false; holder: LlmTask };

/**
 * Ключ пары «запуск, язык» (Р1): одна незавершённая задача на пару. `operationId` - операция
 * **запуска** перевода, в том числе у задачи повтора куска (`F05-7v`): ключ от другой
 * операции пару не удержит.
 */
export function pairKeyOf(operationId: string, language: Language): string {
  return `${operationId}:${language}`;
}

/**
 * Замок строки операции до конца транзакции. Порядок замков у вызывающих: сначала замок языка
 * книги (если он есть), потом строка операции - не наоборот, иначе взаимная блокировка.
 */
export async function lockOperationRow(
  tx: Prisma.TransactionClient,
  operationId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "LlmOperation" WHERE id = ${operationId} FOR UPDATE`;
}

/**
 * Задачи исполнителя и переходы операции (`F05-1w`).
 *
 * Каждая запись - одним условным UPDATE (`L-019`): захват - по статусу, сроку и статусу
 * операции; продление и запись результата - по `ownerToken`. 0 строк - задача ушла другому
 * владельцу, результат не пишется.
 *
 * 🔴 Время аренды и `runAfter` - только время JS, без `NOW()` базы в тех же сравнениях
 * (решение арбитра `F05 | F05-1w`): два источника времени расходятся, и аренда считалась бы
 * не по тем часам, по которым её продлевают. В сыром SQL дата - через `utcTimestamp`.
 *
 * 🔴 Порядок замков везде один: строка операции, затем строки задач (`stopOperation`,
 * `resumeOperation`, `finish`, `release`, `cancelOrphanedTasks`). Захват держит только строку
 * задачи и операцию не запирает: обратный порядок против паузы - взаимоблокировка (L-019).
 */
@Injectable()
export class LlmTaskService {
  private readonly logger = new Logger(LlmTaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmConfig: LlmConfig,
    private readonly config: LlmWorkerConfig,
  ) {}

  /** Аренда в два таймаута вызова: одна попытка не длиннее таймаута, продление - перед каждой. */
  leaseMs(): number {
    return 2 * this.llmConfig.callTimeoutMs();
  }

  /**
   * Ставит задачу. Ключ пары уже занят незавершённой задачей - вставки нет, возвращается
   * держатель: `ON CONFLICT DO NOTHING`, а не пойманный P2002, потому что P2002 обрывает
   * транзакцию вызывающего (`resumeOperation`).
   */
  async enqueue(
    input: EnqueueTaskInput,
    tx: Prisma.TransactionClient = this.prisma,
    retries = 2,
  ): Promise<EnqueueResult> {
    const now = new Date();
    const id = randomUUID();
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "LlmTask" ("id", "kind", "operationId", "bookVersionId", "language", "chunkId",
                             "status", "attempt", "runAfter", "payload", "pairKey", "createdAt", "updatedAt")
      VALUES (${id}, ${input.kind}, ${input.operationId}, ${input.bookVersionId ?? null},
              ${input.language ?? null}::"Language", ${input.chunkId ?? null},
              'pending', 0, ${utcTimestamp(input.runAfter ?? now)},
              ${JSON.stringify(input.payload ?? {})}::jsonb,
              ${input.pairKey ?? null}, ${utcTimestamp(now)}, ${utcTimestamp(now)})
      ON CONFLICT ("pairKey") WHERE "status" IN ('pending', 'running') DO NOTHING
      RETURNING "id"`;
    if (inserted.length > 0) {
      return { created: true, task: await tx.llmTask.findUniqueOrThrow({ where: { id } }) };
    }
    const holder = await tx.llmTask.findFirst({
      where: { pairKey: input.pairKey ?? undefined, status: { in: ['pending', 'running'] } },
    });
    if (!holder) {
      // Держатель завершился между вставкой и чтением: ключ свободен, повтор вставит.
      if (retries > 0) return this.enqueue(input, tx, retries - 1);
      throw llmTaskConflict('LLM_TASK_PAIR_BUSY', 'LLM task pair is busy, try again');
    }
    return { created: false, holder };
  }

  /**
   * `active -> paused`; `pending`-задачи операции - `cancelled` в той же транзакции (Р19).
   * Причина `null` - пауза кнопкой (запуск перевода `F05-4`), а не остановка по отказу.
   */
  pauseOperation(
    operationId: string,
    reason: LlmPauseReason | null,
    alongside?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<boolean> {
    // `alongside` - запись, которая идёт вместе с паузой одной транзакцией и пишется, даже
    // если операция уже не `active` (ждущий на паузе узнаёт, что его строка закрыта).
    return this.stopOperation(operationId, 'paused', reason, undefined, alongside);
  }

  /**
   * Причина паузы стоящей операции сменилась (запуск перевода: исходник правили, пока он стоял
   * на другой паузе, `F05-4a`). Операция остаётся `paused`, задач не ставит; не на паузе - `false`.
   */
  async repauseOperation(
    operationId: string,
    reason: LlmPauseReason,
    alongside?: (tx: Prisma.TransactionClient) => Promise<void>,
    keep: readonly LlmPauseReason[] = [],
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // `keep` - причины, которые эта смена не перекрывает (тупик важнее отказа провайдеров).
      const changed = await tx.llmOperation.updateMany({
        where: { id: operationId, status: 'paused', ...notIn(keep) },
        data: { pauseReason: reason },
      });
      if (changed.count === 0) return false;
      await alongside?.(tx);
      return true;
    }, TASK_TX_OPTIONS);
  }

  /**
   * Остановка, которую нашёл шаг (запуск перевода `F05-4a`): `active -> paused` с причиной, а если
   * операция уже стоит (кнопка «пауза» пришла, пока шёл шаг) - смена причины, кроме `keep`.
   * Запись вида - той же транзакцией и только если операция действительно остановлена этой
   * причиной: отменённой или законченной операции шаг ничего не пишет.
   *
   * `gate` - решение вида «останавливать ли» под замком строки операции (`FOR UPDATE`, первым
   * оператором): `false` - паузы нет, что делать вместо неё, `gate` пишет сам через `tx`. Кто
   * пишет в операцию в своей транзакции (черновик перевода, `F05-6`), ждёт этот замок, и решение
   * не расходится с его коммитом (решение арбитра `F05 | F05-6`, гонка `pauseStale`).
   */
  async stopOrRepause(
    operationId: string,
    reason: LlmPauseReason,
    write: (tx: Prisma.TransactionClient) => Promise<void>,
    keep: readonly LlmPauseReason[] = [],
    gate?: (tx: Prisma.TransactionClient) => Promise<boolean>,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (gate) {
        await lockOperationRow(tx, operationId);
        if (!(await gate(tx))) return false;
      }
      const paused = await tx.llmOperation.updateMany({
        where: { id: operationId, status: 'active' },
        data: { status: 'paused', pauseReason: reason },
      });
      if (paused.count > 0) {
        await tx.llmTask.updateMany({
          where: { operationId, status: 'pending' },
          data: { status: 'cancelled' },
        });
      } else {
        const changed = await tx.llmOperation.updateMany({
          where: { id: operationId, status: 'paused', ...notIn(keep) },
          data: { pauseReason: reason },
        });
        if (changed.count === 0) return false;
      }
      await write(tx);
      return true;
    }, TASK_TX_OPTIONS);
  }

  /**
   * `active | paused -> cancelled`; `pending`-задачи - `cancelled` в той же транзакции (Р19).
   * `afterCancel` - запись вида операции (строки, которые она строила) в той же транзакции.
   */
  cancelOperation(
    operationId: string,
    afterCancel?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<boolean> {
    return this.stopOperation(operationId, 'cancelled', null, afterCancel);
  }

  /**
   * `active -> failed` (решение арбитра `F05 | F05-2`, В4): шаг операции отказал не по
   * бюджету - досье с ответом не по форме, исчерпанные захваты. Причина - в `lastError`
   * задачи, `pauseReason` не ставится; `pending`-задачи - `cancelled` в той же транзакции.
   */
  failOperation(
    operationId: string,
    afterFail?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<boolean> {
    return this.stopOperation(operationId, 'failed', null, afterFail);
  }

  /** `active -> done`: последний шаг операции сделан, оставшиеся `pending`-задачи - `cancelled`. */
  completeOperation(
    operationId: string,
    afterComplete?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<boolean> {
    return this.stopOperation(operationId, 'done', null, afterComplete);
  }

  /**
   * «Продолжить» (Р19): операция снова `active`, задачи шага вставляются заново - все в одной
   * транзакции (у запуска перевода - по задаче на язык, решение арбитра `F05 | F05-4`). Ключ
   * пары занят шаговой задачей той же операции (шаг ещё `running`) - успех без второй задачи;
   * задачей повтора куска - 409 `RETRY_IN_PROGRESS`, операция остаётся как была; у самого
   * повтора шагом запуска - 409 `RUN_ACTIVE` (`F05-7v`); иным держателем - нарушение
   * инварианта (решение арбитра `F05 | F05-1w`).
   *
   * `alongside` - запись вида операции (модели этапов запуска, сброс причин), которая идёт
   * той же транзакцией после перевода в `active`: отказ «продолжить» откатывает и её.
   * `refuse` - причины паузы, с которых вид не продолжает (запуск перевода: `DOSSIER_STALE`):
   * условием в той же записи, а не проверкой снимка до неё - причину мог сменить шаг в полёте.
   */
  async resumeOperation(
    operationId: string,
    tasks: readonly EnqueueTaskInput[],
    limitUsd?: Prisma.Decimal,
    alongside?: (tx: Prisma.TransactionClient) => Promise<void>,
    refuse: readonly LlmPauseReason[] = [],
  ): Promise<EnqueueResult[]> {
    return this.prisma.$transaction(async (tx) => {
      // Новый лимит - в той же записи, что и `active`, условием «не ниже потраченного и
      // зарезервированного» (решение арбитра `F05 | F05-2`): проверка до записи - не проверка.
      const resumed = limitUsd
        ? {
            count: await tx.$executeRaw`
              UPDATE "LlmOperation"
              SET "status" = 'active', "pauseReason" = NULL,
                  "limitUsd" = ${limitUsd.toFixed(8)}::numeric,
                  "updatedAt" = ${utcTimestamp(new Date())}
              WHERE "id" = ${operationId} AND "status" IN ('paused', 'active')
                AND "spentUsd" + "reservedUsd" <= ${limitUsd.toFixed(8)}::numeric
                ${refuseSql(refuse)}`,
          }
        : await tx.llmOperation.updateMany({
            where: { id: operationId, status: { in: ['paused', 'active'] }, ...notIn(refuse) },
            data: { status: 'active', pauseReason: null },
          });
      if (resumed.count === 0) {
        const op = limitUsd
          ? await tx.llmOperation.findUnique({
              where: { id: operationId },
              select: { status: true, pauseReason: true },
            })
          : null;
        // Операция продолжаема, а запись не прошла по условию лимита: траты выросли после
        // проверки сервиса - тот же отказ, что у проверки.
        const refused = op?.pauseReason ? refuse.includes(op.pauseReason) : false;
        if (op && !refused && (op.status === 'paused' || op.status === 'active')) {
          throw new BadRequestException('limitUsd must not be below spentUsd + reservedUsd');
        }
        throw llmTaskConflict('LLM_OPERATION_NOT_RESUMABLE', 'LLM operation cannot be resumed');
      }
      await alongside?.(tx);
      const results: EnqueueResult[] = [];
      for (const task of tasks) results.push(await this.resumeOne(tx, operationId, task));
      return results;
    }, TASK_TX_OPTIONS);
  }

  private async resumeOne(
    tx: Prisma.TransactionClient,
    operationId: string,
    task: EnqueueTaskInput,
  ): Promise<EnqueueResult> {
    const result = await this.enqueue({ ...task, operationId }, tx);
    if (result.created) return result;
    // Пару держит повтор куска, а продолжают не его: запуск или повтор другого куска - ждать.
    if (
      result.holder.kind === TRANSLATION_RETRY_KIND &&
      (task.kind !== TRANSLATION_RETRY_KIND || result.holder.operationId !== operationId)
    ) {
      throw llmTaskConflict(RETRY_IN_PROGRESS, 'A chunk retry is in progress for this language');
    }
    // Шаг своей операции ещё `running` (в том числе шаг самого повтора) - успех без второй задачи.
    if (result.holder.operationId === operationId) return result;
    // Повтор куска держит пару запуска своей операцией (`F05-7v`): чужой держатель - шаг запуска,
    // который ещё доделывается, а не нарушение инварианта.
    if (task.kind === TRANSLATION_RETRY_KIND) {
      throw llmTaskConflict(RUN_ACTIVE, 'A step of the translation run is in progress');
    }
    this.logger.error(
      `LLM task pair ${task.pairKey ?? '-'} is held by task ${result.holder.id} ` +
        `of operation ${result.holder.operationId} (kind ${result.holder.kind})`,
    );
    throw new InternalServerErrorException('LLM task pair is held by a task of another operation');
  }

  /**
   * Захват одной задачи: `pending` со сроком или `running` с истёкшей арендой, вид
   * зарегистрирован, операция `active`. Кандидат выбирается `FOR UPDATE SKIP LOCKED`,
   * условие повторяется в самом UPDATE: два исполнителя одну задачу не берут. Операция
   * читается снимком без замка: задача, захваченная в момент паузы, доделывает шаг и
   * закрывается `cancelled` в `finish` (Р19).
   */
  async claim(kinds: string[], ownerToken: string): Promise<LlmTask | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.leaseMs());
    // Prisma.join на пустом списке даёт битый SQL: нет обработчиков - нечего захватывать.
    if (kinds.length === 0) return null;
    const kindsSql = Prisma.join(kinds);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "LlmTask" AS t
      SET "status" = 'running', "ownerToken" = ${ownerToken},
          "leaseUntil" = ${utcTimestamp(leaseUntil)},
          "attempt" = t."attempt" + 1, "updatedAt" = ${utcTimestamp(now)}
      FROM "LlmOperation" AS o
      WHERE t."id" = (
          SELECT c."id" FROM "LlmTask" AS c
          JOIN "LlmOperation" AS co ON co."id" = c."operationId"
          WHERE co."status" = 'active'
            AND c."kind" IN (${kindsSql})
            AND ((c."status" = 'pending' AND c."runAfter" <= ${utcTimestamp(now)})
              OR (c."status" = 'running' AND c."leaseUntil" < ${utcTimestamp(now)}))
          ORDER BY c."runAfter", c."createdAt"
          LIMIT 1
          FOR UPDATE OF c SKIP LOCKED)
        AND o."id" = t."operationId"
        AND o."status" = 'active'
        AND ((t."status" = 'pending' AND t."runAfter" <= ${utcTimestamp(now)})
          OR (t."status" = 'running' AND t."leaseUntil" < ${utcTimestamp(now)}))
      RETURNING t."id"`;
    if (rows.length === 0) return null;
    return this.prisma.llmTask.findUnique({ where: { id: rows[0].id } });
  }

  /** Продление перед каждой попыткой вызова; 0 строк - аренда потеряна, попытки нет. */
  async renewLease(taskId: string, ownerToken: string): Promise<void> {
    const leaseUntil = new Date(Date.now() + this.leaseMs());
    const renewed = await this.prisma.llmTask.updateMany({
      where: { id: taskId, ownerToken, status: 'running' },
      data: { leaseUntil },
    });
    if (renewed.count === 0) throw new LlmTaskLeaseLostError(taskId);
  }

  /**
   * Запись итога шага условием по `ownerToken`. `continue`/`wait` при операции не `active`
   * завершают задачу `cancelled` (Р19): шаг доделан, следующий не ставится. Завершённый шаг
   * обнуляет `attempt`. `false` - задача уже не наша, ничего не записано.
   */
  async finish(task: LlmTask, ownerToken: string, result: LlmTaskStepResult): Promise<boolean> {
    const now = new Date();
    // `lastError` у `wait` - его причина (что ждёт задача), у `continue` - пусто.
    const note = result.kind === 'wait' ? result.reason : null;
    if (result.kind === 'done' || result.kind === 'fail') {
      const done = await this.prisma.llmTask.updateMany({
        where: { id: task.id, ownerToken, status: 'running' },
        data:
          result.kind === 'done'
            ? { status: 'done', attempt: 0, leaseUntil: null, ownerToken: null, lastError: null }
            : { status: 'failed', leaseUntil: null, ownerToken: null, lastError: result.reason },
      });
      return done.count > 0;
    }
    const runAfter =
      result.kind === 'wait'
        ? new Date(now.getTime() + this.config.waitMs())
        : (result.runAfter ?? now);
    // Статус операции читается под `FOR SHARE`: «продолжить» или пауза, идущие в своей
    // транзакции, дожидаются друг друга, а не решаются по снимку. Иначе «продолжить», нашедшее
    // этот шаг держателем пары, и шаг, прочитавший ещё `paused`, оставили бы операцию `active`
    // без единой задачи (L-019, Р19). Порядок замков - операция, затем задача - как у
    // `resumeOperation` и `stopOperation`.
    return this.prisma.$transaction(async (tx) => {
      const active = await this.lockOperationIsActive(tx, task.operationId);
      const updated = await tx.llmTask.updateMany({
        where: { id: task.id, ownerToken, status: 'running' },
        data: {
          status: active ? 'pending' : 'cancelled',
          attempt: 0,
          runAfter,
          leaseUntil: null,
          ownerToken: null,
          lastError: note,
        },
      });
      return updated.count > 0;
    }, TASK_TX_OPTIONS);
  }

  /**
   * Вернуть захваченную задачу без шага (остановка процесса): снова `pending`, захват не
   * засчитан; у операции не `active` - `cancelled`, как закрылся бы шаг (Р19), иначе
   * `pending`-задача остановленной операции держала бы ключ пары. Условием по токену - если
   * аренду уже забрали, ничего не трогает. Операция под `FOR SHARE`, как в `finish`.
   */
  async release(task: LlmTask, ownerToken: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const active = await this.lockOperationIsActive(tx, task.operationId);
      const released = await tx.llmTask.updateMany({
        where: { id: task.id, ownerToken, status: 'running' },
        data: {
          status: active ? 'pending' : 'cancelled',
          attempt: Math.max(0, task.attempt - 1),
          leaseUntil: null,
          ownerToken: null,
        },
      });
      return released.count > 0;
    }, TASK_TX_OPTIONS);
  }

  /** Отказ задачи, не вернувшей `fail` сама (захваты исчерпаны, исключение шага). */
  async fail(task: LlmTask, ownerToken: string, reason: string): Promise<boolean> {
    return this.finish(task, ownerToken, { kind: 'fail', reason });
  }

  /**
   * Задачи `running` с истёкшей арендой у операции не `active`: владелец умер (выкат посреди
   * шага, хуков выключения нет), а захват такую задачу не возьмёт - она держала бы ключ пары
   * вечно. Закрываются `cancelled`, как закрылся бы шаг живого владельца (Р19). Аренда истекла,
   * поэтому живой владелец записать уже не может: запись по токену у него не пройдёт.
   */
  async cancelOrphanedTasks(): Promise<number> {
    const now = new Date();
    // Сначала операции под `FOR SHARE`, потом их задачи - порядок замков общий. Идущее
    // «продолжить» дожидается, и условие «не `active`» перепроверяется по его итогу - иначе
    // чистка закрыла бы задачу, которую оно приняло держателем пары.
    return this.prisma.$transaction(async (tx) => {
      const ops = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT o."id" FROM "LlmOperation" AS o
        WHERE o."status" <> 'active'
          AND EXISTS (
            SELECT 1 FROM "LlmTask" AS c
            WHERE c."operationId" = o."id" AND c."status" = 'running'
              AND c."leaseUntil" < ${utcTimestamp(now)})
        LIMIT 100
        FOR SHARE OF o`;
      // Prisma.join на пустом списке даёт битый SQL: сирот нет - писать нечего.
      if (ops.length === 0) return 0;
      const opIds = Prisma.join(ops.map((op) => op.id));
      return tx.$executeRaw`
        UPDATE "LlmTask"
        SET "status" = 'cancelled', "leaseUntil" = NULL, "ownerToken" = NULL,
            "updatedAt" = ${utcTimestamp(now)}
        WHERE "operationId" IN (${opIds})
          AND "status" = 'running' AND "leaseUntil" < ${utcTimestamp(now)}`;
    }, TASK_TX_OPTIONS);
  }

  /** Число `pending`-задач видов без обработчика - для предупреждения в логе. */
  countUnknownKinds(kinds: string[]): Promise<number> {
    return this.prisma.llmTask.count({
      where: { status: 'pending', ...(kinds.length > 0 ? { kind: { notIn: kinds } } : {}) },
    });
  }

  /** Статус операции под `FOR SHARE`: идущие «продолжить» и пауза дожидаются друг друга. */
  private async lockOperationIsActive(
    tx: Prisma.TransactionClient,
    operationId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status" FROM "LlmOperation"
      WHERE "id" = ${operationId}
      FOR SHARE`;
    return rows[0]?.status === 'active';
  }

  private async stopOperation(
    operationId: string,
    status: 'paused' | 'cancelled' | 'failed' | 'done',
    reason: LlmPauseReason | null,
    after?: (tx: Prisma.TransactionClient) => Promise<void>,
    alongside?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await stopOperationRows(tx, operationId, status, reason))) {
        await alongside?.(tx);
        return false;
      }
      await after?.(tx);
      await alongside?.(tx);
      return true;
    }, TASK_TX_OPTIONS);
  }
}

/**
 * Строки остановки операции в транзакции вызывающего: операция - в `status` (отменить можно и
 * стоящую на паузе; отказ, пауза и завершение - только идущую), её `pending`-задачи - `cancelled`
 * (Р19). Один переход на `stopOperation` и на тех, кто снимает операцию под своими замками
 * (повтор куска, `F05-7v`). `false` - операция уже не в том статусе, задачи не тронуты.
 */
export async function stopOperationRows(
  tx: Prisma.TransactionClient,
  operationId: string,
  status: 'paused' | 'cancelled' | 'failed' | 'done',
  reason: LlmPauseReason | null,
): Promise<boolean> {
  const stopped = await tx.llmOperation.updateMany({
    where: {
      id: operationId,
      status: { in: status === 'cancelled' ? ['active', 'paused'] : ['active'] },
    },
    data: { status, pauseReason: reason },
  });
  if (stopped.count === 0) return false;
  await tx.llmTask.updateMany({
    where: { operationId, status: 'pending' },
    data: { status: 'cancelled' },
  });
  return true;
}

/** Причина паузы не из `reasons` (пустая - тоже); пустой список - без условия. */
function notIn(reasons: readonly LlmPauseReason[]): Prisma.LlmOperationWhereInput {
  return reasons.length > 0
    ? { OR: [{ pauseReason: null }, { pauseReason: { notIn: [...reasons] } }] }
    : {};
}

/** То же условием сырого SQL; `Prisma.join` на пустом списке дал бы битый SQL - тогда пусто. */
function refuseSql(reasons: readonly LlmPauseReason[]): Prisma.Sql {
  if (reasons.length === 0) return Prisma.empty;
  return Prisma.sql`AND ("pauseReason" IS NULL OR "pauseReason"::text NOT IN (${Prisma.join([...reasons])}))`;
}
