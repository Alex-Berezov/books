import { EMPTY_BOOK_ANALYSIS, StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import {
  ANALYSIS_TARGETS,
  AnalysisWriteData,
  blockPrint,
  emptyAnalysisData,
  targetValue,
} from './analysis-write.data';
import type { BookAnalysisService } from '../../book-analysis/book-analysis.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import { AnalysisWriteFields, applyPlan, planStep } from './analysis-write.fields';
import { remarksOfTarget, StepRecord, withStep } from './analysis-write.handler';
import { quotePrint } from './analysis-write.steps';

/**
 * Владение блоками и запись после шага (`features/F07-analysis-autofill/tech.md` §5): блок,
 * пустой на старте неопубликованной версии, ход пишет и переписывает, пока его никто не менял;
 * изменённый редактором и блоки опубликованной версии - предложения; `themeKeys` шага 3
 * вливаются только ключами записанных тем.
 */

/** Право хода на старте по сохранённому анализу - как `AnalysisWriteFields.ownership`. */
function startData(stored: StoredBookAnalysis, published = false): AnalysisWriteData {
  const owns: AnalysisWriteData['owns'] = {};
  const written: AnalysisWriteData['written'] = {};
  for (const target of ANALYSIS_TARGETS) {
    const value = targetValue(stored, target);
    owns[target] = !published && (value === null || (Array.isArray(value) && value.length === 0));
    written[target] = blockPrint(value);
  }
  return emptyAnalysisData(owns, written);
}

const record = (
  step: 1 | 2 | 3,
  blocks: StepRecord['draft'] extends infer D ? (D extends { blocks: infer B } ? B : never) : never,
  extra: Partial<StepRecord> = {},
): StepRecord => ({
  step: {
    step,
    verdict: 'ok',
    remarks: [],
    attempt: 1,
    outcome: 'done',
    failedReason: null,
    authorModel: 'z-ai/glm-5.3',
    review: { kind: 'answered', model: 'openai/gpt-6-luna' },
    source: 'text',
    dropped: [],
  },
  draft: { blocks, themeLinks: null, droppedQuotes: [], fixes: [] },
  invalid: new Set(),
  review: { kind: 'answered', model: 'openai/gpt-6-luna' },
  ...extra,
});

const ANNA = { key: 'anna', name: 'Anna', role: 'main' as const, description: 'd' };
const QUOTE = { text: 'The bell rang.', chapter: 1, interpretation: 'i' };

/** Решение и его итог, как в транзакции записи: сохранённое после записи - тело импорта поверх. */
function settle(
  data: AnalysisWriteData,
  step: 1 | 2 | 3,
  stored: StoredBookAnalysis,
  published = false,
) {
  const plan = planStep(data, step, { stored, published }, 'en');
  const saved = plan.dto ? ({ ...stored, ...plan.dto } as StoredBookAnalysis) : null;
  return { plan, data: applyPlan(data, step, plan, stored, saved), saved: saved ?? stored };
}

describe('AnalysisWriteFields.ownership', () => {
  /** Строка анализа как есть в базе - в том числе не сжатая (`readStoredAnalysis` не сжимает). */
  const ownsOf = async (row: Record<string, unknown>, status = 'draft') => {
    const tx = {
      bookVersion: { findUnique: () => Promise.resolve({ status }) },
      bookAnalysis: { findUnique: () => Promise.resolve(row) },
    };
    const fields = new AnalysisWriteFields(
      tx as unknown as PrismaService,
      {} as unknown as BookAnalysisService,
    );
    return (await fields.ownership(tx as never, 'v1')).owns;
  };

  it('a block is empty as the import sees it (compactBlock): strings, lists, facts subfields', async () => {
    const owns = await ownsOf({
      facts: { settingPlace: 'Town', narrator: '  ' },
      mainIdea: '   ',
      characters: [],
      keyQuotes: [{}],
      style: [{ device: 'd', explanation: 'e' }],
      themes: ['', null],
      titleMeaning: 'Meaning.',
    });
    expect(owns).toMatchObject({
      'facts.settingPlace': false,
      'facts.settingTime': true,
      'facts.narrator': true,
      'facts.structure': true,
      mainIdea: true,
      characters: true,
      // Не сжатый список без значений - пуст, как у импорта (`isEmptyValue` считал его блоком).
      keyQuotes: true,
      themes: true,
      style: false,
      symbols: true,
      titleMeaning: false,
      endingMeaning: true,
    });
    expect(Object.values(await ownsOf({}, 'published')).every((o) => o === false)).toBe(true);
  });
});

describe('planStep', () => {
  it('step 1 on an empty unpublished version: facts subfields and characters are written', () => {
    const data = withStep(
      startData(EMPTY_BOOK_ANALYSIS),
      record(1, { facts: { settingPlace: 'Town' }, characters: [ANNA] }),
    );
    const { plan, data: next } = settle(data, 1, EMPTY_BOOK_ANALYSIS);
    expect(plan.dto).toEqual({
      language: 'en',
      facts: { settingPlace: 'Town' },
      characters: [ANNA],
    });
    expect(next.items.map((i) => [i.target, i.outcome])).toEqual([
      ['facts.settingPlace', 'written'],
      ['characters', 'written'],
    ]);
  });

  it('facts are assembled whole: the saved subfields stay, only the run subfield it owns is written', () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, facts: { genre: 'novel', narrator: 'first person' } };
    const data = withStep(
      startData(stored),
      record(1, { facts: { settingPlace: 'Town', narrator: 'third person' } }),
    );
    const { plan, data: next } = settle(data, 1, stored);
    expect(plan.dto?.facts).toEqual({
      genre: 'novel',
      narrator: 'first person',
      settingPlace: 'Town',
    });
    expect(next.items.map((i) => [i.target, i.outcome])).toEqual([
      ['facts.settingPlace', 'written'],
      ['facts.narrator', 'proposed'],
    ]);
    expect(next.items[1].hash).toBe(blockPrint('first person'));
  });

  it('a published version: every block is a proposal, nothing is written', () => {
    const data = withStep(startData(EMPTY_BOOK_ANALYSIS, true), record(2, { keyQuotes: [QUOTE] }));
    const { plan, data: next } = settle(data, 2, EMPTY_BOOK_ANALYSIS, true);
    expect(plan.dto).toBeNull();
    expect(next.items[0]).toMatchObject({ outcome: 'proposed', hash: blockPrint(null) });
  });

  it('published mid-run: the blocks the run owns from the start become proposals too', () => {
    const data = withStep(startData(EMPTY_BOOK_ANALYSIS), record(2, { keyQuotes: [QUOTE] }));
    expect(data.owns.keyQuotes).toBe(true);
    const { plan, data: next } = settle(data, 2, EMPTY_BOOK_ANALYSIS, true);
    expect(plan.dto).toBeNull();
    expect(next.items[0]).toMatchObject({ outcome: 'proposed' });
  });

  it('step 3 writes themeKeys into the characters and key quotations of steps 1-2 without proposals', () => {
    let data = withStep(startData(EMPTY_BOOK_ANALYSIS), record(1, { characters: [ANNA] }));
    let stored: StoredBookAnalysis = EMPTY_BOOK_ANALYSIS;
    ({ data, saved: stored } = settle(data, 1, stored));
    data = withStep(data, record(2, { keyQuotes: [QUOTE] }));
    ({ data, saved: stored } = settle(data, 2, stored));
    const themes = [{ key: 'loss', title: 'Loss', interpretation: 'i' }];
    data = withStep(data, {
      ...record(3, { themes, mainIdea: 'Idea.' }),
      draft: {
        blocks: { themes, mainIdea: 'Idea.' },
        themeLinks: {
          characters: { anna: ['loss'] },
          keyQuotes: { [quotePrint(QUOTE.text)]: ['loss'] },
        },
        droppedQuotes: [],
        fixes: [],
      },
    });
    const { plan, data: next } = settle(data, 3, stored);
    expect(plan.dto).toMatchObject({
      themes,
      characters: [{ ...ANNA, themeKeys: ['loss'] }],
      keyQuotes: [{ ...QUOTE, themeKeys: ['loss'] }],
    });
    expect(next.items.filter((i) => i.outcome === 'proposed')).toEqual([]);
  });

  it('the editor changed the characters mid-run: their themeKeys come as a proposal, the quotations are written', () => {
    let data = withStep(startData(EMPTY_BOOK_ANALYSIS), record(1, { characters: [ANNA] }));
    let stored: StoredBookAnalysis = EMPTY_BOOK_ANALYSIS;
    ({ data, saved: stored } = settle(data, 1, stored));
    data = withStep(data, record(2, { keyQuotes: [QUOTE] }));
    ({ data, saved: stored } = settle(data, 2, stored));
    stored = { ...stored, characters: [{ ...ANNA, description: 'edited' }] };
    const themes = [{ key: 'loss', title: 'Loss', interpretation: 'i' }];
    data = withStep(data, {
      ...record(3, { themes }),
      draft: {
        blocks: { themes },
        themeLinks: {
          characters: { anna: ['loss'] },
          keyQuotes: { [quotePrint(QUOTE.text)]: ['loss'] },
        },
        droppedQuotes: [],
        fixes: [],
      },
    });
    const { plan, data: next } = settle(data, 3, stored);
    expect(plan.dto?.characters).toBeUndefined();
    const links = next.items.filter((i) => i.links);
    expect(links.map((i) => [i.target, i.outcome])).toEqual([
      ['characters', 'proposed'],
      ['keyQuotes', 'written'],
    ]);
    expect(links[0].value).toEqual([{ ...ANNA, description: 'edited', themeKeys: ['loss'] }]);
    expect(links[0].hash).toBe(blockPrint(stored.characters));
  });

  it('themes went to a proposal: their keys are not linked (checkAnalysisRefs would refuse the write)', () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, themes: [{ key: 'old', title: 'Old' }] };
    let data = withStep(startData(stored), record(1, { characters: [ANNA] }));
    let current: StoredBookAnalysis = stored;
    ({ data, saved: current } = settle(data, 1, current));
    const themes = [{ key: 'loss', title: 'Loss', interpretation: 'i' }];
    data = withStep(data, {
      ...record(3, { themes }),
      draft: {
        blocks: { themes },
        themeLinks: { characters: { anna: ['loss', 'old'] }, keyQuotes: {} },
        droppedQuotes: [],
        fixes: [],
      },
    });
    const { plan } = settle(data, 3, current);
    expect(plan.dto?.themes).toBeUndefined();
    expect(plan.dto?.characters).toEqual([{ ...ANNA, themeKeys: ['old'] }]);
  });
});

describe('withStep', () => {
  it('a block left with IMPORT_INVALID after the redo is not written: outcome none with the reason', () => {
    const data = withStep(startData(EMPTY_BOOK_ANALYSIS), {
      ...record(2, { style: [{ device: 'd', explanation: 'e' }] }),
      invalid: new Set(['keyQuotes']),
    });
    expect(data.items.map((i) => [i.target, i.outcome, i.failedReason])).toEqual([
      ['keyQuotes', 'none', 'IMPORT_INVALID'],
      ['style', 'waiting', null],
    ]);
  });

  it('remarks go to the block of their path; a remark without a path to every block; CORE_MISSING to none', () => {
    const remarks = [
      {
        code: 'NOT_IN_TEXT' as const,
        where: 'themes.loss.interpretation: x',
        note: 'n',
        by: 'model' as const,
      },
      { code: 'GENERIC' as const, where: 'whole answer', note: 'n', by: 'model' as const },
      { code: 'CORE_MISSING' as const, where: 'core', note: 'n', by: 'code' as const },
    ];
    expect(remarksOfTarget(remarks, 'themes').map((r) => r.code)).toEqual([
      'NOT_IN_TEXT',
      'GENERIC',
    ]);
    expect(remarksOfTarget(remarks, 'mainIdea').map((r) => r.code)).toEqual(['GENERIC']);
  });
});
