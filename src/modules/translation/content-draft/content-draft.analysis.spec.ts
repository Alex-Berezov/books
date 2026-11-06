import { EMPTY_BOOK_ANALYSIS, StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import { analysisImportErrors, quoteCheck } from './content-draft.analysis';
import { indexChapters } from '../draft-quality/quote-check';

/**
 * Общие проверки анализа хода `F07` (вынесены из заготовки `F05-11`, снятой в `F07-3a`):
 * дословность цитат по главе (Р5, Р20, Р21, Р25) и проверки сохранения (Р2).
 */

/** Главы - как их отдаёт `htmlToParagraphs`: абзацы через пустую строку. */
const CHAPTERS = indexChapters(
  new Map([
    [1, 'Anna said: «I will come back.» Then she left.'],
    [2, 'The house was empty and  cold.'],
  ]),
);

const stored = (patch: Partial<StoredBookAnalysis> = {}): StoredBookAnalysis => ({
  ...EMPTY_BOOK_ANALYSIS,
  ...patch,
});

describe('quoteCheck (F05-11, Р5, Р20, Р21)', () => {
  it('finds a quote with other quotes, spaces and NBSP; the text is the chapter fragment', () => {
    expect(quoteCheck('Anna said: "I will come back." Then', 1, CHAPTERS)).toEqual({
      text: 'Anna said: «I will come back.» Then',
    });
    expect(quoteCheck('was empty and cold', 2, CHAPTERS)).toEqual({ text: 'was empty and  cold' });
  });

  it('a changed word, another case or another chapter is not found', () => {
    expect(quoteCheck('Anna said: "I shall come back."', 1, CHAPTERS)).toEqual({
      reason: 'NOT_FOUND',
    });
    expect(quoteCheck('anna said', 1, CHAPTERS)).toEqual({ reason: 'NOT_FOUND' });
    expect(quoteCheck('was empty and cold', 1, CHAPTERS)).toEqual({ reason: 'NOT_FOUND' });
  });

  it('NBSP and curly apostrophes in the quote itself are normalized too', () => {
    const chapters = indexChapters(new Map([[3, 'It’s “fine”, she said.']]));
    expect(quoteCheck('It\'s  "fine", she said', 3, chapters)).toEqual({
      text: 'It’s “fine”, she said',
    });
    expect(quoteCheck('It’s — fine', 3, chapters)).toEqual({ reason: 'NOT_FOUND' });
  });

  it('a quote glued across two paragraphs is not word for word (Р21)', () => {
    const chapters = indexChapters(new Map([[4, 'The end of one.\n\nThe start of two.']]));
    expect(quoteCheck('The start of two.', 4, chapters)).toEqual({ text: 'The start of two.' });
    expect(quoteCheck('of one. The start', 4, chapters)).toEqual({ reason: 'NOT_FOUND' });
  });

  it('a fragment longer than the import limit only because of spaces keeps «» and fits (Р25)', () => {
    const words = Array.from({ length: 120 }, (_, i) => `w${i}`);
    const raw = `«${words.join('  ')}\u00a0end»`;
    const chapters = indexChapters(new Map([[5, raw]]));
    const quote = `"${words.join(' ')} end"`;
    expect(quote.length).toBeLessThanOrEqual(500);
    expect(raw.length).toBeGreaterThan(500);
    const found = quoteCheck(quote, 5, chapters);
    expect(found).toEqual({ text: `«${words.join(' ')} end»` });
    expect('text' in found && found.text.length).toBe(quote.length);
  });

  it('no chapter and a chapter the version has not', () => {
    expect(quoteCheck('was empty', 0, CHAPTERS)).toEqual({ reason: 'NO_CHAPTER' });
    expect(quoteCheck('was empty', 7, CHAPTERS)).toEqual({ reason: 'CHAPTER_MISSING' });
  });
});

describe('analysisImportErrors (F05-11, Р2)', () => {
  it('more characters than the import takes are refused, not cut', () => {
    const characters = Array.from({ length: 21 }, (_, i) => ({
      key: `c${i}`,
      name: `C${i}`,
      role: 'minor' as const,
    }));
    expect(analysisImportErrors(stored(), { language: 'en', characters })).toEqual([
      expect.stringContaining('characters'),
    ]);
  });

  it('a clean draft passes the save checks', () => {
    expect(
      analysisImportErrors(stored(), {
        language: 'en',
        characters: [{ key: 'anna', name: 'Anna', role: 'main' }],
        keyQuotes: [{ text: 'Line', chapter: 1, speakerKey: 'anna' }],
      }),
    ).toEqual([]);
  });

  it('a bad key and a dangling speaker are refused', () => {
    expect(
      analysisImportErrors(stored(), {
        language: 'en',
        characters: [{ key: 'Anna K', name: 'Anna', role: 'main' }],
      }),
    ).toEqual([expect.stringContaining('characters.0.key')]);
    expect(
      analysisImportErrors(stored(), {
        language: 'en',
        keyQuotes: [{ text: 'Line', speakerKey: 'boris' }],
      }),
    ).toEqual(['keyQuotes.0.speakerKey: unknown character key "boris"']);
  });
});
