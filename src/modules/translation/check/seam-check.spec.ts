import { shapeErrors } from '../dossier/dossier.format';
import { splitChapter } from '../chapter-blocks';
import {
  nextSeam,
  SEAM_FINDING_CODES,
  SEAM_PROBLEMS_MAX,
  SEAM_SHAPE,
  seamAnswerOf,
  seamFailed,
  seamFindingsOf,
  seamInputOf,
  seamMessages,
  seamProblems,
} from './seam-check';

const CHAPTER = Array.from({ length: 6 }, (_, i) => `<p>Block ${i + 1}.</p>`).join('');
const piece = (firstBlock: number, lastBlock: number) => ({
  firstBlock,
  lastBlock,
  blocks: Array.from({ length: lastBlock - firstBlock + 1 }, (_, i) => ({
    n: firstBlock + i,
    text: `ES ${firstBlock + i}`,
  })),
});
const LANGUAGES = { sourceLanguage: 'en', targetLanguage: 'es' } as const;

describe('seam check', () => {
  it('the window is two blocks before and two after the joint, source and translation', () => {
    const input = seamInputOf(splitChapter(CHAPTER), piece(1, 3), piece(4, 6), LANGUAGES);
    expect(input).toMatchObject({
      sourceBefore: 'Block 2.\nBlock 3.',
      sourceAfter: 'Block 4.\nBlock 5.',
      translatedBefore: 'ES 2\nES 3',
      translatedAfter: 'ES 4\nES 5',
    });
    const user = seamMessages(input)[1].content;
    expect(user).toContain('<<<TRANSLATION_BEFORE\nES 2\nES 3\nTRANSLATION_BEFORE>>>');
    expect(user).not.toContain('Block 1.');
  });

  it('fail or a named problem fails the joint; unsure without problems does not', () => {
    expect(seamFailed(seamAnswerOf({ verdict: 'fail', problems: [] }))).toBe(true);
    expect(seamFailed(seamAnswerOf({ verdict: 'pass', problems: ['Block 4 repeats 3'] }))).toBe(
      true,
    );
    expect(seamFailed(seamAnswerOf({ verdict: 'unsure', problems: [' '] }))).toBe(false);
    expect(seamFailed(seamAnswerOf({ verdict: 'pass', problems: [] }))).toBe(false);
  });

  it('problems are trimmed, capped in number and length', () => {
    const many = Array.from({ length: 9 }, () => 'x'.repeat(1_000));
    const problems = seamProblems(seamAnswerOf({ verdict: 'fail', problems: ['', ...many] }));
    expect(problems).toHaveLength(SEAM_PROBLEMS_MAX);
    expect(problems.every((p) => p.length === 300)).toBe(true);
  });

  it('the next joint is the first without an answer of the model; other findings do not count', () => {
    expect(nextSeam(1, [])).toBeNull();
    expect(nextSeam(3, [{ code: 'SEAM_REPEAT', seam: 1 }])).toBe(1);
    expect(
      nextSeam(3, [
        { code: SEAM_FINDING_CODES.SEAM_CHECKED, seam: 1 },
        { code: SEAM_FINDING_CODES.SEAM_NOT_INDEPENDENT, seam: 2 },
      ]),
    ).toBeNull();
    expect(nextSeam(3, [{ code: SEAM_FINDING_CODES.SEAM_BROKEN, seam: 2 }])).toBe(1);
  });

  it('an unknown verdict is a form error', () => {
    expect(shapeErrors({ verdict: 'maybe', problems: [] }, SEAM_SHAPE)).not.toEqual([]);
    expect(shapeErrors({ verdict: 'pass', problems: [] }, SEAM_SHAPE)).toEqual([]);
  });
});

describe('seamFindingsOf', () => {
  it('keeps only object findings with a seam code and a numeric seam', () => {
    const ok = { code: SEAM_FINDING_CODES.SEAM_CHECKED, seam: 2 };
    const found = seamFindingsOf([
      ok,
      null,
      'SEAM_CHECKED',
      [SEAM_FINDING_CODES.SEAM_CHECKED, 3],
      { code: 'OTHER', seam: 1 },
      { code: SEAM_FINDING_CODES.SEAM_BROKEN, seam: '1' },
    ]);
    expect(found).toEqual([ok]);
    expect(seamFindingsOf({ code: SEAM_FINDING_CODES.SEAM_CHECKED, seam: 1 })).toEqual([]);
  });
});
