import { Prisma } from '@prisma/client';
import { summaryOf } from './run-summary';

/**
 * Состояние раздела языка запуска (`F06-5`; `product.md` §5, §8 п.11): строка хода главнее
 * операций; отказ старта строкой `failed` без данных хода - «не начат» с причиной; без строки -
 * причина пропуска или выведенная из операции автозапуска; тихих статусов без причины нет.
 */

const op = (patch: Partial<Parameters<typeof summaryOf>[0][number]> = {}) => ({
  id: 'auto1',
  translationRunId: 'r1',
  bookVersionId: 'v-fr',
  status: 'active' as const,
  pauseReason: null,
  skipReason: null,
  spentUsd: new Prisma.Decimal(0),
  ...patch,
});

const item = (target: string, verdict: string, number: number | null = null) => ({
  target,
  number,
  text: verdict === 'failed' ? '' : 'Text.',
  verdict,
  outcome: 'written',
  regen: null,
});

describe('summaryOf', () => {
  it('ни операции, ни строки - null (без «Write Summary» или язык не done)', () => {
    expect(summaryOf([], null)).toBeNull();
  });

  it('операция автозапуска идёт, строки нет - pending без причины', () => {
    expect(summaryOf([op()], null)).toMatchObject({ status: 'pending', reason: null });
  });

  it.each([
    [
      { skipReason: 'AUTOSTART_SKIPPED_EXISTING', status: 'done' as const },
      'skipped',
      'AUTOSTART_SKIPPED_EXISTING',
    ],
    [{ status: 'failed' as const }, 'failed', 'AUTOSTART_FAILED'],
    [{ status: 'cancelled' as const }, 'failed', 'AUTOSTART_CANCELLED'],
    [{ status: 'done' as const }, 'skipped', 'AUTOSTART_NOTHING_TO_START'],
  ])('без строки хода: операция %o - %s с причиной %s', (patch, status, reason) => {
    expect(summaryOf([op(patch)], null)).toMatchObject({ status, reason, draftId: null });
  });

  it('строка failed отказа старта (данных хода нет) - «не начат» с причиной, ссылка на строку', () => {
    const draft = {
      id: 'd1',
      translationRunLanguageId: 'l1',
      status: 'failed' as const,
      failedReason: 'LLM_CEILING_REACHED',
      operationId: 'auto1',
      data: null,
    };
    expect(summaryOf([op({ status: 'done' })], draft)).toMatchObject({
      status: 'skipped',
      reason: 'LLM_CEILING_REACHED',
      draftId: 'd1',
    });
  });

  it('ход: статус строки, пауза его операции, разделы, отметки модели и неудачные тексты, траты обеих операций', () => {
    const draft = {
      id: 'd1',
      translationRunLanguageId: 'l1',
      status: 'ready' as const,
      failedReason: null,
      operationId: 'run1',
      data: {
        plannedSections: 3,
        items: [
          item('section', 'ok', 1),
          item('section', 'flags', 2),
          item('section', 'failed', 3),
          item('full', 'flags'),
        ],
      },
    };
    const summary = summaryOf(
      [
        op({ status: 'done', spentUsd: new Prisma.Decimal('0') }),
        op({
          id: 'run1',
          status: 'paused',
          pauseReason: 'CEILING_REACHED',
          spentUsd: new Prisma.Decimal('0.25'),
        }),
      ],
      draft,
    );
    expect(summary).toMatchObject({
      status: 'ready',
      reason: null,
      draftId: 'd1',
      operationStatus: 'paused',
      pauseReason: 'CEILING_REACHED',
      plannedSections: 3,
      sectionsDone: 2,
      fullDone: true,
      briefDone: false,
      flaggedTexts: 2,
      failedTexts: 1,
    });
    expect(Number(summary?.spentUsd)).toBe(0.25);
  });
});
