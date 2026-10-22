import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmBudgetService } from './llm-budget.service';

/**
 * Строку потолка создаёт миграция, код её не создаёт (решение арбитра `F05 | F05-1`, В4).
 * Нет строки - отказ закрыто, а не «потолка нет - значит, можно».
 */
describe('LLM budget without the ceiling row', () => {
  it('refuses every reserve at the ceiling level and creates nothing', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      llmCall: { create: jest.fn() },
      llmOperation: { findUnique: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const budget = new LlmBudgetService(prisma);

    await expect(
      budget.reserve({
        operationId: 'op',
        stage: 's',
        requestedModel: 'm',
        attempt: 1,
        estimateUsd: new Prisma.Decimal('0.01'),
      }),
    ).rejects.toMatchObject({ code: 'LLM_BUDGET_EXCEEDED', level: 'ceiling' });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.llmCall.create).not.toHaveBeenCalled();
  });
});

describe('ceilingReached (refusal at the entry, В11)', () => {
  const withBudget = (row: object | null) =>
    new LlmBudgetService({
      llmBudget: { findUnique: jest.fn().mockResolvedValue(row) },
    } as unknown as PrismaService);
  const d = (v: string) => new Prisma.Decimal(v);

  it('no ceiling row or a zero ceiling is reached', async () => {
    expect(await withBudget(null).ceilingReached()).toBe(true);
    expect(
      await withBudget({
        ceilingUsd: d('0'),
        reservedUsd: d('0'),
        spentUsd: d('0'),
      }).ceilingReached(),
    ).toBe(true);
  });

  it('reserved money counts as spent, like the reserve itself', async () => {
    expect(
      await withBudget({
        ceilingUsd: d('10'),
        reservedUsd: d('6'),
        spentUsd: d('4'),
      }).ceilingReached(),
    ).toBe(true);
    expect(
      await withBudget({
        ceilingUsd: d('10'),
        reservedUsd: d('5'),
        spentUsd: d('4'),
      }).ceilingReached(),
    ).toBe(false);
  });
});
