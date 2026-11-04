import { EMPTY_BOOK_ANALYSIS } from '../../book-analysis/book-analysis-data';
import {
  analysisDataJson,
  blockPrint,
  emptyAnalysisData,
  readAnalysisData,
  stableJson,
  targetValue,
} from './analysis-write.data';

/**
 * Данные хода анализа (`tech.md` §5): отпечаток блока не зависит от порядка ключей jsonb (Л2),
 * чтение проверяет форму, элемент не той формы пишется назад как был.
 */
describe('analysis run data', () => {
  it('the print of a block does not depend on the key order (jsonb reorders keys, Л2)', () => {
    const a = [{ key: 'anna', name: 'Anna', arc: { from: 'x', to: 'y' } }];
    const b = [{ arc: { to: 'y', from: 'x' }, name: 'Anna', key: 'anna' }];
    expect(stableJson(a)).toBe(stableJson(b));
    expect(blockPrint(a)).toBe(blockPrint(b));
    expect(blockPrint(a)).not.toBe(blockPrint([{ ...a[0], name: 'Anne' }]));
    expect(blockPrint(null)).toBe(blockPrint(undefined));
  });

  it('a facts subfield is its own unit: the value of the subfield, not of the block', () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, facts: { settingPlace: 'Town', genre: 'novel' } };
    expect(targetValue(stored, 'facts.settingPlace')).toBe('Town');
    expect(targetValue(stored, 'facts.narrator')).toBeNull();
    expect(targetValue(stored, 'characters')).toBeNull();
  });

  it('reads its own form back; a broken item stays in place and goes back as it was', () => {
    const data = emptyAnalysisData({ characters: true }, { characters: blockPrint(null) });
    const json = analysisDataJson({
      ...data,
      steps: [
        {
          step: 1,
          verdict: 'ok',
          remarks: [{ code: 'NOT_IN_TEXT', where: 'characters.anna', note: 'n', by: 'model' }],
          attempt: 1,
          outcome: 'done',
          failedReason: null,
          authorModel: 'z-ai/glm-5.3',
          review: { kind: 'answered', model: 'openai/gpt-6-luna' },
          source: 'text',
          dropped: [{ code: 'LIMIT_OUT', path: 'characters', note: 'cut' }],
        },
      ],
      items: [
        {
          target: 'characters',
          step: 1,
          verdict: 'ok',
          remarks: [],
          review: null,
          outcome: 'written',
          hash: null,
          value: [{ key: 'anna' }],
          failedReason: null,
          links: false,
        },
      ],
      themeLinks: { characters: { anna: ['loss'] }, keyQuotes: {} },
      droppedQuotes: [{ step: 2, path: 'keyQuotes.0', text: 't', chapter: 1, reason: 'NOT_FOUND' }],
    });
    const raw = JSON.parse(JSON.stringify(json)) as { items: unknown[] };
    raw.items.push({ target: 'nope' });
    const read = readAnalysisData(raw);
    expect(read.steps[0]).toMatchObject({
      step: 1,
      source: 'text',
      dropped: [{ code: 'LIMIT_OUT' }],
    });
    expect(read.items[0]).toMatchObject({ target: 'characters', outcome: 'written' });
    expect(read.items[1]).toMatchObject({ outcome: 'none', failedReason: 'DRAFT_DATA_INVALID' });
    expect(read.owns).toEqual({ characters: true });
    expect(read.themeLinks).toEqual({ characters: { anna: ['loss'] }, keyQuotes: {} });
    expect(read.droppedQuotes).toHaveLength(1);
    expect((analysisDataJson(read) as { items: unknown[] }).items[1]).toEqual({ target: 'nope' });
  });

  it('a broken step record is not dropped silently: stepsBroken, the next step number is not guessed', () => {
    const good = {
      step: 1,
      verdict: 'ok',
      remarks: [],
      attempt: 1,
      outcome: 'done',
      dropped: [],
    };
    expect(readAnalysisData({ steps: [good] }).stepsBroken).toBe(false);
    expect(readAnalysisData({ steps: [good, { step: 2 }] }).stepsBroken).toBe(true);
    expect(readAnalysisData({ steps: [{ ...good, step: 2 }] }).stepsBroken).toBe(true);
    expect(readAnalysisData({ steps: 'x' }).stepsBroken).toBe(true);
    expect('stepsBroken' in (analysisDataJson(readAnalysisData({})) as object)).toBe(false);
  });

  it('not its form at all - an empty run without rights on blocks', () => {
    expect(readAnalysisData('x')).toEqual(emptyAnalysisData({}, {}));
  });
});
