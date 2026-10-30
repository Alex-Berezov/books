import { Injectable } from '@nestjs/common';
import {
  BookDossier,
  BookGlossary,
  Language,
  LlmOperation,
  LlmPauseReason,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import {
  DOSSIER_LIMIT_FACTOR,
  DOSSIER_SOURCE_CHANGED,
  DOSSIER_TOO_LONG,
} from './dossier.constants';
import { Demand, DemandOptions, DossierFailure, DossierWaiter } from './dossier-demand.types';
import { DossierEstimatesService } from './dossier-estimates.service';
import { dossierTaskInput, glossaryTaskInput } from './dossier-task-input';

/** Заводка строителя: операция, строка и первая задача - короткими INSERT (`L-020`). */
const BUILD_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Строку перехватил другой ждущий, пока шла заводка: транзакция откатывается. */
class TakeoverLostError extends Error {}

/**
 * Строители строк досье и глоссария (`F05-2`, шаг 7, Р20): заводка строки с операцией и первой
 * задачей одной транзакцией, перехват, ответ ждущему по состоянию строителя (`builderVerdict`)
 * и закрытие `failed` вместе с его паузой. Когда звать строителя и что делать со строкой
 * `failed` или `ready`, решает `DossierDemandService`.
 */
@Injectable()
export class DossierBuilderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly budget: LlmBudgetService,
    private readonly tasks: LlmTaskService,
    private readonly estimates: DossierEstimatesService,
  ) {}

  async startDossier(input: {
    bookId: string;
    sourceVersionId: string;
    generation: number;
    fingerprint: string;
    options: DemandOptions;
  }): Promise<BookDossier | 'waiter-limit' | null> {
    // Кнопка при исчерпанном потолке отказывает, а не заводит операцию на паузе (В11).
    // Ждущему из запуска - пауза по ходу, как по Р20.
    this.llm.assertEnabled();
    if (!input.options.waiter) await this.assertCeilingRoom();
    // Текст читается один раз на старте: план хранится в строке, шаг читает свою главу.
    // Оценка нужна и при лимите редактора: модель без цены - 409 `LLM_NO_PRICE` до операции.
    const {
      estimateUsd: estimate,
      entries,
      titles,
    } = await this.estimates.estimateSource(input.sourceVersionId);
    // Сводка заведомо откажет `DOSSIER_TOO_LONG`: куски не ставятся и не оплачиваются (`LEGACY-477`).
    const refusing = await this.estimates.findRefusingModel(titles, entries.length);
    if (refusing) return this.failAtStart(input, refusing);
    const limitUsd = input.options.limitUsd ?? estimate.mul(DOSSIER_LIMIT_FACTOR);
    if (!(await this.waiterFits(input.options, limitUsd))) return 'waiter-limit';
    const opData = await this.llm.operationData({
      kind: 'dossier',
      bookVersionId: input.sourceVersionId,
      limitUsd,
      createdById: input.options.createdById ?? null,
      translationRunId: input.options.waiter?.translationRunId ?? null,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        const row = await tx.bookDossier.create({
          data: {
            bookId: input.bookId,
            sourceVersionId: input.sourceVersionId,
            generation: input.generation,
            fingerprint: input.fingerprint,
            plan: entries as unknown as Prisma.InputJsonValue,
            operationId: op.id,
          },
        });
        await this.tasks.enqueue(dossierTaskInput(row.id, row.sourceVersionId, op.id), tx);
        return row;
      }, BUILD_TX_OPTIONS);
    } catch (error) {
      // Строку того же поколения вставил другой: транзакция откатилась вместе с операцией.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /**
   * Строка `building`, которой перехват заведомо откажет: `failed` с `DOSSIER_TOO_LONG` и моделью
   * этапа условием по прежнему строителю, пауза ждущего - той же транзакцией (Р20). Строитель
   * уходит в `previousOperationId`, `operationId` - `null`: строка закрыта тем же правилом, что и
   * на старте, и `tooLongAgain` перепроверяет её текущими настройками (решение арбитра `T147`,
   * (ж)). Строку уже перехватил другой - `null`, вызывающий перечитывает её.
   */
  async failTakeover(
    row: BookDossier,
    model: string,
    options: DemandOptions,
  ): Promise<Demand<BookDossier> | null> {
    const data = {
      status: 'failed' as const,
      failedReason: DOSSIER_TOO_LONG,
      model,
      operationId: null,
      previousOperationId: row.operationId,
    };
    const closed = await this.closeForWaiter(options, async (tx) => {
      const taken = await tx.bookDossier.updateMany({
        where: { id: row.id, status: 'building', operationId: row.operationId, takeovers: 0 },
        data,
      });
      return taken.count;
    });
    return closed ? { status: 'failed', row: { ...row, ...data } } : null;
  }

  async startGlossary(
    dossier: BookDossier,
    language: Language,
    failed: BookGlossary | null,
    options: DemandOptions,
  ): Promise<BookGlossary | 'waiter-limit' | null> {
    const estimate = await this.estimates.estimateGlossary(dossier, language);
    const limitUsd = options.limitUsd ?? estimate.mul(DOSSIER_LIMIT_FACTOR);
    if (!(await this.waiterFits(options, limitUsd))) return 'waiter-limit';
    const opData = await this.llm.operationData({
      kind: 'dossier',
      bookVersionId: dossier.sourceVersionId,
      limitUsd,
      createdById: options.createdById ?? null,
      translationRunId: options.waiter?.translationRunId ?? null,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        let row: BookGlossary;
        if (failed) {
          // `failed -> building` условием: заново строит один (Р20), перехват снова разрешён.
          const reopened = await tx.bookGlossary.updateMany({
            where: { id: failed.id, status: 'failed' },
            data: {
              status: 'building',
              operationId: op.id,
              previousOperationId: null,
              takeovers: 0,
            },
          });
          if (reopened.count === 0) throw new TakeoverLostError();
          row = await tx.bookGlossary.findUniqueOrThrow({ where: { id: failed.id } });
        } else {
          row = await tx.bookGlossary.create({
            data: { dossierId: dossier.id, language, operationId: op.id },
          });
        }
        await this.tasks.enqueue(
          glossaryTaskInput(row.id, row.language, dossier.sourceVersionId, op.id),
          tx,
        );
        return row;
      }, BUILD_TX_OPTIONS);
    } catch (error) {
      if (isUniqueViolation(error) || error instanceof TakeoverLostError) return null;
      throw error;
    }
  }

  /**
   * Что делать ждущему со строкой `building` по состоянию её строителя. `takeover` - строитель
   * `failed`, строку ещё не перехватывали и текст исходника тот же (`fresh`): перехват
   * устаревшей строки достроил бы досье по старым кускам. Строитель `done` при строке
   * `building` - строку уже никто не достроит, это тот же отказ.
   */
  async builderVerdict<Row extends BookDossier | BookGlossary>(
    row: Row,
    op: LlmOperation | null,
    options: DemandOptions,
    model: 'bookDossier' | 'bookGlossary',
    fresh = true,
  ): Promise<Demand<Row> | 'takeover' | null> {
    switch (op?.status) {
      case 'active':
        return { status: 'wait', row };
      case 'paused':
        // Строитель на паузе (бюджет, поставщик): редактор продолжает досье, затем запуск.
        await this.pauseWaiter(options.waiter, 'DOSSIER_PAUSED');
        return { status: 'paused', row, reason: 'DOSSIER_PAUSED', builderOperationId: op.id };
      case 'failed':
        if (row.takeovers === 0 && fresh) return 'takeover';
        // Текст правили после отказа строителя: это не отказ ждущего. Строка закрывается
        // причиной, вызывающий перечитывает её и строит новое поколение по новому тексту.
        if (!fresh && model === 'bookDossier') {
          await this.failRow(model, row.id, row.operationId, this.prisma, {
            failedReason: DOSSIER_SOURCE_CHANGED,
          });
          return null;
        }
        break;
      default:
        // Отменён или операции нет: перехвата нет, отмена останавливает траты.
        break;
    }
    // Строку прочитали до её строителя: если она уже не `building` под ним (стала `ready`, её
    // перехватили), отказа нет - пауза откатывается, вызывающий перечитывает строку.
    const closed = await this.closeForWaiter(options, (tx) =>
      this.failRow(model, row.id, row.operationId, tx),
    );
    return closed ? { status: 'failed', row: { ...row, status: 'failed' } } : null;
  }

  /**
   * Перехват строки новой операцией на остаток оценки: условный UPDATE по прежнему строителю
   * и `takeovers = 0`. Задачи прежнего строителя уже `cancelled`: `failOperation` закрыл
   * `pending`, а `running` закроется сам, найдя операцию не `active`. Частичные досье остаются
   * у строки - повтор их не оплачивает.
   */
  async takeOver<Row extends BookDossier | BookGlossary>(
    row: Row,
    model: 'bookDossier' | 'bookGlossary',
    estimate: Prisma.Decimal,
    options: DemandOptions,
    bookVersionId: string,
    taskOf: (row: Row, operationId: string) => EnqueueTaskInput,
  ): Promise<Row | 'waiter-limit' | null> {
    const limitUsd = options.limitUsd ?? estimate.mul(DOSSIER_LIMIT_FACTOR);
    // Кнопка перехватывает с лимитом редактора и не при исчерпанном потолке - как новое поколение.
    this.llm.assertEnabled();
    if (!options.waiter) await this.assertCeilingRoom();
    if (!(await this.waiterFits(options, limitUsd))) return 'waiter-limit';
    const opData = await this.llm.operationData({
      kind: 'dossier',
      bookVersionId,
      limitUsd,
      createdById: options.createdById ?? null,
      translationRunId: options.waiter?.translationRunId ?? null,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        const where = {
          id: row.id,
          status: 'building' as const,
          operationId: row.operationId,
          takeovers: 0,
        };
        const data = { operationId: op.id, previousOperationId: row.operationId, takeovers: 1 };
        const taken =
          model === 'bookDossier'
            ? await tx.bookDossier.updateMany({ where, data })
            : await tx.bookGlossary.updateMany({ where, data });
        if (taken.count === 0) throw new TakeoverLostError();
        const updated = { ...row, ...data };
        await this.tasks.enqueue(taskOf(updated, op.id), tx);
        return updated;
      }, BUILD_TX_OPTIONS);
    } catch (error) {
      if (error instanceof TakeoverLostError) return null;
      throw error;
    }
  }

  /**
   * `building -> failed` условием по строителю: строку уже мог перехватить другой. Причина
   * пишется только досье: у глоссария колонки `failedReason` нет, и сигнатура её не примет.
   */
  async failRow(
    model: 'bookDossier',
    id: string,
    operationId: string | null,
    db?: Prisma.TransactionClient,
    reason?: DossierFailure,
  ): Promise<number>;
  async failRow(
    model: 'bookDossier' | 'bookGlossary',
    id: string,
    operationId: string | null,
    db?: Prisma.TransactionClient,
  ): Promise<number>;
  async failRow(
    model: 'bookDossier' | 'bookGlossary',
    id: string,
    operationId: string | null,
    db: Prisma.TransactionClient = this.prisma,
    reason?: DossierFailure,
  ): Promise<number> {
    const where = { id, status: 'building' as const, operationId };
    const closed =
      model === 'bookDossier'
        ? await db.bookDossier.updateMany({ where, data: { status: 'failed', ...reason } })
        : await db.bookGlossary.updateMany({ where, data: { status: 'failed' } });
    return closed.count;
  }

  async pauseWaiter(waiter: DossierWaiter | undefined, reason: LlmPauseReason): Promise<void> {
    if (waiter) await this.tasks.pauseOperation(waiter.operationId, reason);
  }

  /**
   * Строка `failed` сразу, без операции и задач: ни один платный вызов не ушёл. Модель - чтобы
   * ждущий не строил ту же строку той же моделью заново (`tooLongAgain`). Строка и пауза ждущего -
   * одной транзакцией, как в `builderVerdict` (Р20): обрыв между ними оставил бы ждущего `active`.
   */
  private async failAtStart(
    input: {
      bookId: string;
      sourceVersionId: string;
      generation: number;
      fingerprint: string;
      options: DemandOptions;
    },
    model: string,
  ): Promise<BookDossier | null> {
    const made: { row?: BookDossier } = {};
    const create = async (db: Prisma.TransactionClient) => {
      made.row = await db.bookDossier.create({
        data: {
          bookId: input.bookId,
          sourceVersionId: input.sourceVersionId,
          generation: input.generation,
          fingerprint: input.fingerprint,
          status: 'failed',
          failedReason: DOSSIER_TOO_LONG,
          model,
        },
      });
    };
    const { waiter } = input.options;
    try {
      if (waiter) await this.tasks.pauseOperation(waiter.operationId, 'STEP_FAILED', create);
      else await create(this.prisma);
    } catch (error) {
      // Строку того же поколения вставил другой: пауза откатилась вместе со вставкой.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
    return made.row ?? null;
  }

  /**
   * Строка `failed` и пауза ждущего `STEP_FAILED` - одной транзакцией: обрыв между ними оставил бы
   * ждущего `active`, и его повтор завёл бы новое поколение с повторной оплатой (Р20). Без ждущего
   * (кнопка) - только строка. `close` закрыл ноль строк - строку уже перехватили или достроили:
   * пауза откатывается, `false`.
   */
  private async closeForWaiter(
    options: DemandOptions,
    close: (tx: Prisma.TransactionClient) => Promise<number>,
  ): Promise<boolean> {
    const fail = async (tx: Prisma.TransactionClient) => {
      if ((await close(tx)) === 0) throw new TakeoverLostError();
    };
    try {
      if (options.waiter) {
        await this.tasks.pauseOperation(options.waiter.operationId, 'STEP_FAILED', fail);
      } else {
        await fail(this.prisma);
      }
    } catch (error) {
      if (error instanceof TakeoverLostError) return false;
      throw error;
    }
    return true;
  }

  /**
   * Ждущий заводит операцию досье (новое поколение, перехват) только в пределах своего лимита
   * (карточка, шаг 7; Р20): иначе она обходила бы его LIMIT_REACHED. Не влезло - ждущий на паузе.
   * Без ждущего (кнопка) лимит - у новой операции.
   */
  private async waiterFits(options: DemandOptions, limitUsd: Prisma.Decimal): Promise<boolean> {
    if (!options.waiter) return true;
    const op = await this.prisma.llmOperation.findUnique({
      where: { id: options.waiter.operationId },
      select: { limitUsd: true, spentUsd: true, reservedUsd: true },
    });
    // Операции ждущего нет - не помещается ни с каким лимитом: пауза без суммы.
    const minLimit = op ? waiterMinLimit(op, limitUsd) : null;
    if (op && minLimit === null) return true;
    const { onLimit } = options.waiter;
    await this.tasks.pauseOperation(
      options.waiter.operationId,
      'LIMIT_REACHED',
      onLimit && minLimit ? (tx) => onLimit(tx, minLimit) : undefined,
    );
    return false;
  }

  private async assertCeilingRoom(): Promise<void> {
    if (await this.budget.ceilingReached()) {
      throw llmTaskConflict('LLM_CEILING_REACHED', 'LLM spending ceiling is reached');
    }
  }
}

/**
 * Лимит ждущего, с которым операция досье или глоссария поместится: потрачено + в резерве + её
 * лимит, вверх до восьми знаков - деньги хранятся `Decimal(14,8)`, и округлённый вниз минимум
 * не пропустил бы «продолжить» с показанной суммой (`F05-7`). `null` - помещается и так.
 */
export function waiterMinLimit(
  op: { limitUsd: Prisma.Decimal; spentUsd: Prisma.Decimal; reservedUsd: Prisma.Decimal },
  needed: Prisma.Decimal,
): Prisma.Decimal | null {
  const min = op.spentUsd
    .add(op.reservedUsd)
    .add(needed)
    .toDecimalPlaces(8, Prisma.Decimal.ROUND_UP);
  return op.limitUsd.gte(min) ? null : min;
}
