import { splitChapter } from '../chapter-blocks';
import { shapeErrors } from '../dossier/dossier.format';
import { divergentEntries, finalCodeCheck, fragmentOf } from './final-check-code';
import {
  FINAL_CHECK_STAGE,
  FINAL_CHECK_STAGE_DEFINITIONS,
  FINAL_FINDING_CODES,
} from './final-check.constants';
import {
  anchoredIssues,
  FINAL_CHECK_SHAPE,
  finalCheckAnswerOf,
  finalCheckFailed,
  finalCheckInputOf,
} from './final-check.prompts';

const ANNA = { key: 'anna', source: 'Anna', target: 'Ana' };

describe('final check stage default', () => {
  it('leaves room for the reasoning of its model: 8000 tokens (Р4 F05-R)', () => {
    const final = FINAL_CHECK_STAGE_DEFINITIONS.find((d) => d.stage === FINAL_CHECK_STAGE);
    expect(final?.maxTokens).toBe(8_000);
  });
});

describe('final check by code', () => {
  it('the source spelling of a name the glossary renders otherwise is a finding with its chapter and fragment', () => {
    const { findings, missing } = finalCodeCheck(
      [
        { number: 1, text: 'Ana llega al pueblo.', sourceBlocks: 2, inTranslation: true },
        { number: 2, text: 'Luego Anna se va del pueblo.', sourceBlocks: 2, inTranslation: true },
      ],
      [ANNA],
      'es',
    );
    expect(missing).toEqual([]);
    expect(findings.has(1)).toBe(false);
    expect(findings.get(2)).toEqual([
      {
        code: FINAL_FINDING_CODES.GLOSSARY_SOURCE_FORM,
        key: 'anna',
        form: 'Anna',
        target: 'Ana',
        fragment: 'Luego Anna se va del pueblo.',
      },
    ]);
  });

  it('a whole word, not a part: «Anna» is not found in «Annabel»', () => {
    const { findings } = finalCodeCheck(
      [{ number: 1, text: 'Annabel llega.', sourceBlocks: 1, inTranslation: true }],
      [ANNA],
      'es',
    );
    expect(findings.size).toBe(0);
  });

  it('keepOriginal, a target equal to the source and a source that is the target of another entry are skipped', () => {
    const entries = [
      { ...ANNA, keepOriginal: true },
      { key: 'madrid', source: 'Madrid', target: 'Madrid' },
      { key: 'town', source: 'Town', target: 'Town-es' },
      { key: 'john', source: 'John', target: 'Juan' },
      // «Juan» в переводе - законная форма записи `john`, а не второе написание `juan`.
      { key: 'juan', source: 'Juan', target: 'Juanito' },
    ];
    expect(divergentEntries(entries, 'es').map((e) => e.key)).toEqual(['john']);
  });

  it('chapters not in the translation are listed, a flagged one is not; an empty assembled chapter is a finding, an empty source chapter is skipped', () => {
    const { findings, missing } = finalCodeCheck(
      [
        { number: 1, text: null, sourceBlocks: 3, inTranslation: false },
        { number: 2, text: '  ', sourceBlocks: 1, inTranslation: true },
        { number: 3, text: null, sourceBlocks: 0, inTranslation: false },
        // Глава с флагом сборки (Р8): её причина уже в отчёте, пропавшей она не считается.
        { number: 4, text: null, sourceBlocks: 2, inTranslation: true },
      ],
      [],
      'es',
    );
    expect(missing).toEqual([1]);
    expect(findings.get(2)).toEqual([{ code: FINAL_FINDING_CODES.CHAPTER_EMPTY }]);
    expect(findings.has(3)).toBe(false);
    expect(findings.has(4)).toBe(false);
  });

  it('a fragment around the first word; no match - the form itself', () => {
    const text = `${'x'.repeat(100)} Anna ${'y'.repeat(100)}`;
    expect(fragmentOf(text, 'Anna')).toBe(`${'x'.repeat(39)} Anna ${'y'.repeat(39)}`);
    expect(fragmentOf('Nadie', 'Anna')).toBe('Anna');
    // Целым словом, как находка: «Anna» не ищется внутри «Annabel» раньше настоящей «Anna».
    const later = `Annabel llega. ${'z'.repeat(60)} Luego Anna se va.`;
    expect(fragmentOf(later, 'Anna')).toContain('Luego Anna se va.');
    expect(fragmentOf(later, 'Anna')).not.toContain('Annabel');
  });
});

describe('final check by the model', () => {
  const layout = splitChapter(
    Array.from({ length: 10 }, (_, i) => `<p>Block ${i + 1}.</p>`).join(''),
  );
  const translated = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, text: `ES ${i + 1}` }));

  it('the model reads three blocks at the start and three at the end, by block number', () => {
    const input = finalCheckInputOf({
      layout,
      translated,
      sourceLanguage: 'en',
      targetLanguage: 'es',
      chapterNumber: 4,
      context: {
        glossary: { entries: [{ ...ANNA, kind: 'character', keepOriginal: false, note: '' }] },
        dossier: null,
      },
    });
    expect(input.blocks).toEqual([1, 2, 3, 8, 9, 10]);
    expect(input.translatedText).toBe(
      '[1] ES 1\n[2] ES 2\n[3] ES 3\n[8] ES 8\n[9] ES 9\n[10] ES 10',
    );
    expect(input.sourceText.split('\n')[3]).toBe('[8] Block 8.');
  });

  it('a remark about a block the model was not shown is dropped; fail without anchored remarks still fails', () => {
    const blocks = [1, 2, 3, 8, 9, 10];
    const answer = finalCheckAnswerOf({
      verdict: 'pass',
      issues: [
        { block: 5, problem: 'made up' },
        { block: 9, problem: ' Lost a sentence ' },
      ],
    });
    expect(anchoredIssues(answer, blocks)).toEqual([{ block: 9, problem: 'Lost a sentence' }]);
    expect(finalCheckFailed(answer, blocks)).toBe(true);
    const unanchored = finalCheckAnswerOf({
      verdict: 'pass',
      issues: [{ block: 5, problem: 'x' }],
    });
    expect(finalCheckFailed(unanchored, blocks)).toBe(false);
    expect(finalCheckFailed(finalCheckAnswerOf({ verdict: 'fail', issues: [] }), blocks)).toBe(
      true,
    );
  });

  it('the block number is an integer of the form', () => {
    expect(
      shapeErrors({ verdict: 'pass', issues: [{ block: 'x', problem: '' }] }, FINAL_CHECK_SHAPE),
    ).not.toEqual([]);
    expect(shapeErrors({ verdict: 'pass', issues: [] }, FINAL_CHECK_SHAPE)).toEqual([]);
  });
});
