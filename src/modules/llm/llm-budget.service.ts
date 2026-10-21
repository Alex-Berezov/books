import { Injectable } from '@nestjs/common';
import { LlmBudget, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmBudgetExceededError, LlmError } from './llm.errors';

/** Единственная строка общего потолка; создаёт её миграция `f05_llm_core` (В4). */
export const LLM_BUDGET_ID = 1;

/**
 * Резерв и факт - короткие условные UPDATE и одна вставка; бюджет как у регистрации
 * (`auth.service.ts`), чтобы зависший замок строки потолка не держал соединение пула (`L-020`).
 */
const BUDGET_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

export interface ReserveInput {
  operationId: string;
  stage: string;
  requestedModel: string;
  attempt: number;
  estimateUsd: Prisma.Decimal;
}

export interface SettleInput {
  costUsd: Prisma.Decimal;
  costEstimated: boolean;
  actualModel?: string | null;
  provider?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs: number;
  errorClass?: string | null;
}

/**
 * Деньги модуля LLM (Р4, Р15, Р21). Вся арифметика - в SQL над `numeric`, без float (В2).
 *
 * Резерв: в одной транзакции условный UPDATE потолка, затем операции, затем строка `LlmCall`.
 * Условие стоит в самом UPDATE (`L-019`): «прочитал, потом записал» пропускает два параллельных
 * резерва на один остаток.
 *
 * Факт: условие `reserveReleasedAt IS NULL` на строке вызова. Факт пишется ровно один раз -
 * живым процессом или чисткой зависших (`F05-1w`); проигравший не пишет ничего (Р21).
 */
@Injectable()
export class LlmBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  getBudget(): Promise<LlmBudget | null> {
    return this.prisma.llmBudget.findUnique({ where: { id: LLM_BUDGET_ID } });
  }

  async updateBudget(
    patch: { ceilingUsd?: Prisma.Decimal; defaultRunLimitUsd?: Prisma.Decimal },
    userId: string | null,
  ): Promise<LlmBudget | null> {
    // updateMany, а не update: нет строки - ноль затронутых, а не создание (В4).
    await this.prisma.llmBudget.updateMany({
      where: { id: LLM_BUDGET_ID },
      data: { ...patch, updatedById: userId },
    });
    return this.getBudget();
  }

  async reserve(input: ReserveInput): Promise<{ callId: string }> {
    // Вверх до восьми знаков: оценка - верхняя граница, округление вниз дало бы резерв 0
    // у копеечной цены, и потолок такой вызов бы не держал.
    const estimate = input.estimateUsd.toDecimalPlaces(8, Prisma.Decimal.ROUND_UP).toFixed(8);
    return this.prisma.$transaction(async (tx) => {
      // Потолок раньше операции (Р4): отказ по потолку - уровень `ceiling`, даже если лимит
      // операции тоже исчерпан. Нет строки потолка - тот же отказ, закрыто (В4). Потолок 0 -
      // стоп-кран (Р25): отказ и бесплатной модели, у которой оценка 0 прошла бы `<= 0`.
      const ceiling = await tx.$executeRaw`
        UPDATE "LlmBudget"
        SET "reservedUsd" = "reservedUsd" + ${estimate}::numeric
        WHERE "id" = ${LLM_BUDGET_ID}
          AND "ceilingUsd" > 0
          AND "reservedUsd" + "spentUsd" + ${estimate}::numeric <= "ceilingUsd"`;
      if (ceiling === 0) throw new LlmBudgetExceededError('ceiling');

      const operation = await tx.$executeRaw`
        UPDATE "LlmOperation"
        SET "reservedUsd" = "reservedUsd" + ${estimate}::numeric, "updatedAt" = NOW()
        WHERE "id" = ${input.operationId}
          AND "status" = 'active'
          AND "reservedUsd" + "spentUsd" + ${estimate}::numeric <= "limitUsd"`;
      if (operation === 0) {
        const op = await tx.llmOperation.findUnique({
          where: { id: input.operationId },
          select: { status: true },
        });
        if (op?.status !== 'active') {
          throw new LlmError('LLM_OPERATION_NOT_ACTIVE', 'LLM operation is not active');
        }
        throw new LlmBudgetExceededError('operation');
      }

      const call = await tx.llmCall.create({
        data: {
          operationId: input.operationId,
          stage: input.stage,
          requestedModel: input.requestedModel,
          attempt: input.attempt,
          reservedUsd: estimate,
        },
        select: { id: true },
      });
      return { callId: call.id };
    }, BUDGET_TX_OPTIONS);
  }

  /**
   * Заменяет резерв вызова фактом. `false` - факт уже записан (чисткой или раньше): ничего
   * не тронуто, поправки на разницу нет (Р21).
   */
  async settle(callId: string, outcome: SettleInput): Promise<boolean> {
    const cost = outcome.costUsd.toFixed(8);
    return this.prisma.$transaction(async (tx) => {
      const released = await tx.$queryRaw<Array<{ reservedUsd: string; operationId: string }>>`
        UPDATE "LlmCall"
        SET "costUsd" = ${cost}::numeric,
            "costEstimated" = ${outcome.costEstimated},
            "actualModel" = ${outcome.actualModel ?? null},
            "provider" = ${outcome.provider ?? null},
            "inputTokens" = ${outcome.inputTokens ?? null}::int,
            "outputTokens" = ${outcome.outputTokens ?? null}::int,
            "durationMs" = ${Math.max(0, Math.round(outcome.durationMs))}::int,
            "errorClass" = ${outcome.errorClass ?? null},
            "reserveReleasedAt" = NOW()
        WHERE "id" = ${callId} AND "reserveReleasedAt" IS NULL
        RETURNING "reservedUsd"::text AS "reservedUsd", "operationId"`;
      const row = released[0];
      if (!row) return false;

      await tx.$executeRaw`
        UPDATE "LlmBudget"
        SET "reservedUsd" = GREATEST("reservedUsd" - ${row.reservedUsd}::numeric, 0),
            "spentUsd" = "spentUsd" + ${cost}::numeric
        WHERE "id" = ${LLM_BUDGET_ID}`;
      await tx.$executeRaw`
        UPDATE "LlmOperation"
        SET "reservedUsd" = GREATEST("reservedUsd" - ${row.reservedUsd}::numeric, 0),
            "spentUsd" = "spentUsd" + ${cost}::numeric,
            "updatedAt" = NOW()
        WHERE "id" = ${row.operationId}`;
      return true;
    }, BUDGET_TX_OPTIONS);
  }
}
