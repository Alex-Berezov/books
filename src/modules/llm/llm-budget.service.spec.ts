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
