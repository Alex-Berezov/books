import { EMPTY_BOOK_ANALYSIS, StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import { analysisDraftMessages } from './content-draft.prompts';
import {
  AnalysisDraftAnswer,
  analysisImportErrors,
  analysisRemarks,
  buildAnalysisDraft,
  indexChapters,
  quoteCheck,
} from './content-draft.analysis';

/**
 * Заготовка Analysis (F05-11): дословность цитат по главе (Р5-Р7, Р20, Р21), слияние с сохранённым
 * анализом кодом (Р3), предел цитат вместе с сохранёнными (Р1, Р19), проверки сохранения (Р2).
 */

/** Главы - как их отдаёт `htmlToParagraphs`: абзацы через пустую строку. */
const CHAPTERS = indexChapters(
  new Map([
    [1, 'Anna said: «I will come back.» Then she left.'],
    [2, 'The house was empty and  cold.'],
  ]),
);

const emptyAnswer = (): AnalysisDraftAnswer => ({
  facts: { settingPlace: '', settingTime: '', narrator: '', structure: '' },
  characters: [],
  keyQuotes: [],
  style: [],
});

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

describe('buildAnalysisDraft (F05-11)', () => {
  it('a made-up quote is thrown away with a mark, a real one stays', () => {
    const answer = emptyAnswer();
    answer.keyQuotes = [
      { text: 'The house was empty', chapter: 2, speakerKey: '' },
      { text: 'Nobody ever came here', chapter: 2, speakerKey: '' },
      { text: 'Then she left.', chapter: 0, speakerKey: '' },
    ];
    const { analysis, droppedQuotes } = buildAnalysisDraft({
      language: 'en',
      stored: stored(),
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis.keyQuotes).toEqual([{ text: 'The house was empty', chapter: 2 }]);
    expect(droppedQuotes).toEqual([
      { path: 'keyQuotes', text: 'Nobody ever came here', chapter: 2, reason: 'NOT_FOUND' },
      { path: 'keyQuotes', text: 'Then she left.', chapter: null, reason: 'NO_CHAPTER' },
    ]);
  });

  it('saved fields and elements are carried as they are; only empty ones are filled', () => {
    const answer = emptyAnswer();
    answer.facts = { settingPlace: 'Paris', settingTime: '1890s', narrator: 'Anna', structure: '' };
    answer.characters = [
      {
        key: 'other-key',
        name: 'ANNA',
        role: 'main',
        arcFrom: 'shy',
        arcTo: 'free',
        quote: 'I will come back.',
        quoteChapter: 1,
        relations: [],
      },
      {
        key: 'boris',
        name: 'Boris',
        role: 'episodic',
        arcFrom: '',
        arcTo: '',
        quote: '',
        quoteChapter: 0,
        relations: [{ to: 'anna', label: 'neighbour' }],
      },
    ];
    answer.keyQuotes = [{ text: 'Saved line', chapter: 1, speakerKey: 'anna' }];
    const saved = stored({
      facts: { settingPlace: 'Moscow', genre: 'novel' },
      characters: [
        {
          key: 'anna',
          name: 'Anna',
          role: 'main',
          description: 'Editor text',
          themeKeys: ['love'],
          quote: { text: 'Not word for word', chapter: 3 },
        },
      ],
      keyQuotes: [{ text: 'Saved line', interpretation: 'Editor meaning' }],
    });
    const { analysis, droppedQuotes } = buildAnalysisDraft({
      language: 'en',
      stored: saved,
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis.facts).toEqual({
      settingPlace: 'Moscow',
      genre: 'novel',
      settingTime: '1890s',
      narrator: 'Anna',
    });
    expect(analysis.characters).toEqual([
      {
        key: 'anna',
        name: 'Anna',
        role: 'main',
        description: 'Editor text',
        themeKeys: ['love'],
        // Сохранённая цитата не проверяется и не меняется (Р7).
        quote: { text: 'Not word for word', chapter: 3 },
        arc: { from: 'shy', to: 'free' },
      },
      {
        key: 'boris',
        name: 'Boris',
        role: 'minor',
        relations: [{ to: 'anna', label: 'neighbour' }],
      },
    ]);
    expect(analysis.keyQuotes).toEqual([
      { text: 'Saved line', interpretation: 'Editor meaning', speakerKey: 'anna' },
    ]);
    expect(droppedQuotes).toEqual([]);
    expect(Object.keys(analysis).sort()).toEqual(['characters', 'facts', 'keyQuotes', 'language']);
  });

  it('quotes stay within the import limit together with the saved ones', () => {
    const answer = emptyAnswer();
    answer.keyQuotes = [1, 2, 3].map(() => ({ text: 'The house', chapter: 2, speakerKey: '' }));
    answer.keyQuotes[1] = { text: 'was empty', chapter: 2, speakerKey: '' };
    answer.keyQuotes[2] = { text: 'and cold', chapter: 2, speakerKey: '' };
    const saved = stored({
      keyQuotes: Array.from({ length: 11 }, (_, i) => ({ text: `Saved ${i}` })),
    });
    answer.keyQuotes.push({ text: 'Not in the book', chapter: 2, speakerKey: '' });
    const { analysis, droppedQuotes } = buildAnalysisDraft({
      language: 'en',
      stored: saved,
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis.keyQuotes).toHaveLength(12);
    expect(analysis.keyQuotes?.[11]).toEqual({ text: 'The house', chapter: 2 });
    // Сначала проверка, потом предел (Р19): верные лишние - OVER_LIMIT с текстом главы,
    // непроверенная - своя причина.
    expect(droppedQuotes).toEqual([
      { path: 'keyQuotes', text: 'was empty', chapter: 2, reason: 'OVER_LIMIT' },
      { path: 'keyQuotes', text: 'and  cold', chapter: 2, reason: 'OVER_LIMIT' },
      { path: 'keyQuotes', text: 'Not in the book', chapter: 2, reason: 'NOT_FOUND' },
    ]);
  });

  it('heroes over the import limit after the merge are refused by the save checks, not cut (Р2)', () => {
    const answer = emptyAnswer();
    answer.characters = ['x', 'y', 'z'].map((k) => ({
      key: k,
      name: k.toUpperCase(),
      role: 'minor' as const,
      arcFrom: '',
      arcTo: '',
      quote: '',
      quoteChapter: 0,
      relations: [],
    }));
    const saved = stored({
      characters: Array.from({ length: 19 }, (_, i) => ({
        key: `s${i}`,
        name: `S${i}`,
        role: 'minor' as const,
      })),
    });
    const { analysis } = buildAnalysisDraft({
      language: 'en',
      stored: saved,
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis.characters).toHaveLength(22);
    expect(analysisImportErrors(saved, analysis)).toEqual([expect.stringContaining('characters')]);
  });

  it('a repeated quote and one that differs from a saved quote only by case and quotes are not added twice', () => {
    const answer = emptyAnswer();
    answer.keyQuotes = [
      { text: 'The house was empty', chapter: 2, speakerKey: '' },
      { text: 'The house was empty', chapter: 2, speakerKey: '' },
      { text: 'ANNA SAID: "I will come back."', chapter: 1, speakerKey: '' },
    ];
    const { analysis } = buildAnalysisDraft({
      language: 'en',
      stored: stored({ keyQuotes: [{ text: 'Anna said: «I will come back.»' }] }),
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis.keyQuotes).toEqual([
      { text: 'Anna said: «I will come back.»' },
      { text: 'The house was empty', chapter: 2 },
    ]);
  });

  it('a style example not in its chapter is dropped, the device stays', () => {
    const answer = emptyAnswer();
    answer.style = [
      { device: 'Ellipsis', explanation: 'Short lines', example: 'Invented', exampleChapter: 1 },
    ];
    const { analysis, droppedQuotes } = buildAnalysisDraft({
      language: 'fr',
      stored: stored(),
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis).toEqual({
      language: 'fr',
      style: [{ device: 'Ellipsis', explanation: 'Short lines' }],
    });
    expect(droppedQuotes).toEqual([
      { path: 'style.0.example', text: 'Invented', chapter: 1, reason: 'NOT_FOUND' },
    ]);
  });
});

describe('buildAnalysisDraft: characters and style (F05-11, Р3, Р6)', () => {
  const char = (patch: Partial<AnalysisDraftAnswer['characters'][number]>) => ({
    key: 'k',
    name: 'N',
    role: 'secondary' as const,
    arcFrom: '',
    arcTo: '',
    quote: '',
    quoteChapter: 0,
    relations: [],
    ...patch,
  });

  it('a character matched by name keeps the saved key; relations and speakers follow it', () => {
    const answer = emptyAnswer();
    answer.characters = [
      char({ key: 'anna-k', name: 'Anna' }),
      char({ key: 'boris', name: 'Boris', relations: [{ to: 'anna-k', label: 'friend' }] }),
    ];
    answer.keyQuotes = [{ text: 'The house was empty', chapter: 2, speakerKey: 'anna-k' }];
    const { analysis } = buildAnalysisDraft({
      language: 'en',
      stored: stored({ characters: [{ key: 'anna', name: 'Anna', role: 'main' }] }),
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis.characters?.map((c) => c.key)).toEqual(['anna', 'boris']);
    expect(analysis.characters?.[1].relations).toEqual([{ to: 'anna', label: 'friend' }]);
    expect(analysis.keyQuotes?.[0].speakerKey).toBe('anna');
    expect(analysisImportErrors(stored(), analysis)).toEqual([]);
  });

  it('a made-up line of a character is dropped with its path, the character stays', () => {
    const answer = emptyAnswer();
    answer.characters = [char({ key: 'boris', name: 'Boris', quote: 'Invented', quoteChapter: 1 })];
    const { analysis, droppedQuotes } = buildAnalysisDraft({
      language: 'en',
      stored: stored(),
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis.characters).toEqual([{ key: 'boris', name: 'Boris', role: 'secondary' }]);
    expect(droppedQuotes).toEqual([
      { path: 'characters.boris.quote', text: 'Invented', chapter: 1, reason: 'NOT_FOUND' },
    ]);
  });

  it('a saved device gets only its empty example; the mark points at its position', () => {
    const answer = emptyAnswer();
    answer.style = [
      { device: 'irony', explanation: 'Other words', example: 'Invented', exampleChapter: 2 },
    ];
    const { analysis, droppedQuotes } = buildAnalysisDraft({
      language: 'en',
      stored: stored({
        style: [
          { device: 'Repetition', explanation: 'Saved', example: { text: 'Saved', chapter: 1 } },
          { device: 'Irony', explanation: 'Saved irony' },
        ],
      }),
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis.style?.[1]).toEqual({ device: 'Irony', explanation: 'Saved irony' });
    expect(droppedQuotes).toEqual([
      { path: 'style.1.example', text: 'Invented', chapter: 2, reason: 'NOT_FOUND' },
    ]);
  });

  it('a half-filled arc is not taken: both ends or nothing', () => {
    const answer = emptyAnswer();
    answer.characters = [char({ key: 'ivan', name: 'Ivan', arcFrom: 'shy', arcTo: '' })];
    const { analysis } = buildAnalysisDraft({
      language: 'en',
      stored: stored(),
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis.characters).toEqual([{ key: 'ivan', name: 'Ivan', role: 'secondary' }]);
  });

  it('empty keys, names and relations are skipped', () => {
    const answer = emptyAnswer();
    answer.characters = [
      char({ key: ' ', name: 'Nobody' }),
      char({ key: 'eva', name: '' }),
      char({
        key: 'ivan',
        name: 'Ivan',
        relations: [
          { to: '', label: 'x' },
          { to: 'a', label: ' ' },
        ],
      }),
    ];
    const { analysis } = buildAnalysisDraft({
      language: 'en',
      stored: stored(),
      answer,
      chapters: CHAPTERS,
    });
    expect(analysis.characters).toEqual([{ key: 'ivan', name: 'Ivan', role: 'secondary' }]);
  });
});

describe('analysisDraftMessages (F05-11)', () => {
  it('the prompt names the import limits the code does not cut (Р2)', () => {
    const [system] = analysisDraftMessages({
      bookTitle: 'B',
      language: 'en',
      dossier: {},
      glossary: null,
      stored: {},
      chaptersText: '',
    });
    for (const part of [
      'at most 20 in all',
      'At most 6 relations',
      'at most 10 devices',
      'never empty',
    ]) {
      expect(system.content).toContain(part);
    }
  });
});

describe('analysisRemarks (F05-11, Р27)', () => {
  it('a broken item of the merged record is named by its key, not by an index the answer has not', () => {
    const saved = stored({
      characters: Array.from({ length: 15 }, (_, i) => ({
        key: `s${i}`,
        name: `S${i}`,
        role: 'main' as const,
      })),
    });
    const analysis = {
      language: 'en' as const,
      characters: [
        ...(saved.characters ?? []),
        { key: 'boris', name: 'Boris', role: 'minor' as const },
        {
          key: 'eva',
          name: 'Eva',
          role: 'main' as const,
          relations: [{ to: 'boris', label: 'x' }],
        },
      ],
    };
    const remarks = analysisRemarks(saved, analysis);
    expect(remarks.join('\n')).not.toMatch(/^characters\.16/m);
    expect(remarks.some((r) => r.startsWith('characters[key=eva].relations.0.to'))).toBe(true);
    const styled = analysisRemarks(saved, {
      language: 'en',
      style: [{ device: 'Irony', explanation: '' }],
    });
    expect(styled.some((r) => r.startsWith('style[device=Irony].explanation'))).toBe(true);
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
