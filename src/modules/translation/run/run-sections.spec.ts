import { ContentDraftKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { analysisOf, runSections, summaryOf } from './run-sections';

/**
 * Состояние раздела языка запуска (`F06-5`; `product.md` §5, §8 п.11): строка хода главнее
 * операций; отказ старта строкой `failed` без данных хода - «не начат» с причиной; без строки -
 * причина пропуска или выведенная из операции автозапуска; тихих статусов без причины нет.
 */

const op = (
  patch: Partial<Parameters<typeof summaryOf>[0][number]> & {
    contentKind?: ContentDraftKind | null;
  } = {},
) => ({
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

describe('analysisOf (F07-3b; решение арбитра F07 | F07-3b, В2)', () => {
  it('нет ни операции, ни хода - null', () => {
    expect(analysisOf([], null, false)).toBeNull();
  });

  it('автозапуск ждёт - pending, шагов ещё нет', () => {
    expect(analysisOf([op()], null, false)).toMatchObject({
      status: 'pending',
      stepsDone: 0,
      stepsTotal: null,
      coreReady: false,
    });
  });

  it('ход - шаги, блоки с флагами и упавшие, ядро - как передано', () => {
    const block = (verdict: string, codes: string[] = [], outcome = 'written') => ({
      target: 'mainIdea',
      step: 3,
      verdict,
      outcome,
      remarks: codes.map((code) => ({ code, where: 'w', note: 'n', by: 'code' })),
    });
    const step = (n: number) => ({ step: n, verdict: 'ok', outcome: 'done', attempt: 1 });
    const draft = {
      id: 'd2',
      translationRunLanguageId: 'l1',
      status: 'ready' as const,
      failedReason: null,
      operationId: 'run1',
      data: {
        steps: [step(1), step(2), step(3)],
        // Битый элемент (не той формы) в счёт не идёт, даже с вердиктом `flags`.
        items: [
          block('ok'),
          block('flags', ['NOT_IN_TEXT']),
          block('flags', ['EXTERNAL_CHECK', 'NOT_IN_TEXT']),
          // Только метки человеку: флагом модели не считаются (T189, LEGACY-497).
          block('flags', ['EXTERNAL_CHECK']),
          block('flags', ['CORE_MISSING']),
          // Проверяющая не ответила: замечаний нет - вкладка «Model flags» не показывает.
          block('flags'),
          // Код пересказа в ответ хода анализа не идёт (remarksDto) - вкладка его не показывает.
          block('flags', ['LENGTH_OUT']),
          // «Nothing to add»: вкладка отметки проверки не показывает.
          block('flags', ['NOT_IN_TEXT'], 'none'),
          block('failed', ['NOT_IN_TEXT']),
          block('ok', ['NOT_IN_TEXT']),
          { broken: true, verdict: 'flags' },
        ],
        stepsTotal: 5,
      },
    };
    const analysis = analysisOf(
      [op({ id: 'run1', status: 'done', spentUsd: new Prisma.Decimal('0.4') })],
      draft,
      true,
    );
    expect(analysis).toMatchObject({
      status: 'ready',
      draftId: 'd2',
      operationStatus: 'done',
      stepsDone: 3,
      stepsTotal: 5,
      flaggedItems: 2,
      failedItems: 1,
      coreReady: true,
    });
    expect(Number(analysis?.spentUsd)).toBe(0.4);
  });
});

describe('runSections: траты разделов не смешиваются (хвост ревью F06-5a)', () => {
  it('операция анализа запуска - в строке Analysis, не в Summary; null-вид не толкуется', async () => {
    const operations = [
      op({ id: 's1', contentKind: 'summary_write', spentUsd: new Prisma.Decimal('0.1') }),
      op({ id: 'a1', contentKind: 'analysis_write', spentUsd: new Prisma.Decimal('0.7') }),
      op({ id: 'n1', contentKind: null, spentUsd: new Prisma.Decimal('5') }),
    ];
    const llmFind = jest.fn((args: { where: { contentKind: { in: string[] } } }) =>
      Promise.resolve(
        operations.filter((o) => args.where.contentKind.in.includes(o.contentKind as string)),
      ),
    );
    const db = {
      llmOperation: { findMany: llmFind },
      contentDraft: { findMany: jest.fn().mockResolvedValue([]) },
      bookAnalysis: {
        findMany: jest.fn().mockResolvedValue([{ bookVersionId: 'v-fr', hasCore: true }]),
      },
    } as unknown as PrismaService;
    const sections = await runSections(db, [{ id: 'l1', runId: 'r1', bookVersionId: 'v-fr' }]);
    const line = sections.get('l1');
    expect(Number(line?.summary?.spentUsd)).toBe(0.1);
    expect(Number(line?.analysis?.spentUsd)).toBe(0.7);
    expect(line?.analysis?.coreReady).toBe(true);
    expect(llmFind).toHaveBeenCalledTimes(1);
    expect(llmFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contentKind: { in: ['summary_write', 'analysis_write'] },
        }),
      }),
    );
  });

  it.each([
    ['строка анализа без ядра', [{ bookVersionId: 'v-fr', hasCore: false }]],
    ['строки анализа нет', []],
    ['ядро у другой версии', [{ bookVersionId: 'v-es', hasCore: true }]],
  ])('coreReady - только живой hasCore версии языка: %s - false', async (_, cores) => {
    const db = {
      llmOperation: {
        findMany: jest.fn().mockResolvedValue([op({ contentKind: 'analysis_write' })]),
      },
      contentDraft: { findMany: jest.fn().mockResolvedValue([]) },
      bookAnalysis: { findMany: jest.fn().mockResolvedValue(cores) },
    } as unknown as PrismaService;
    const sections = await runSections(db, [{ id: 'l1', runId: 'r1', bookVersionId: 'v-fr' }]);
    expect(sections.get('l1')?.analysis?.coreReady).toBe(false);
  });

  it('без операций и ходов анализа - ядро не читается, строки Analysis нет', async () => {
    const cores = jest.fn();
    const db = {
      llmOperation: {
        findMany: jest.fn().mockResolvedValue([op({ contentKind: 'summary_write' })]),
      },
      contentDraft: { findMany: jest.fn().mockResolvedValue([]) },
      bookAnalysis: { findMany: cores },
    } as unknown as PrismaService;
    const sections = await runSections(db, [{ id: 'l1', runId: 'r1', bookVersionId: 'v-fr' }]);
    expect(sections.get('l1')?.analysis).toBeNull();
    expect(cores).toHaveBeenCalledTimes(0);
  });
});
