import { EMPTY_BOOK_ANALYSIS } from '../../book-analysis/book-analysis-data';
import { ShapedRequest } from '../dossier/dossier.prompts';
import {
  ANSWER_CHARS_PER_TOKEN,
  estimateInputTokens,
  INPUT_CHARS_PER_TOKEN,
} from '../../llm/openrouter.client';
import { indexChapters } from '../draft-quality/quote-check';
import { EXAMPLE_ANALYSES } from './examples';
import { EMPTY_DRAFT } from './analysis-write.data';
import {
  exampleSlice,
  fitStepInput,
  readStepAnswer,
  referencedChapters,
  StepContext,
  stepInput,
  StepInput,
  stepInputFits,
  versionBook,
} from './analysis-write.steps';

/**
 * Запасной вход шага (решение арбитра `F07 | F07-1a`, Р8): текст версии не влез - краткое
 * содержание глав досье плюс главы, на которые ссылаются итоги прошлых шагов, по одной, пока
 * влезает; у шага 1 - одни краткие содержания; не влезли и они - `DRAFT_TOO_LONG` (`null`).
 */

const LONG = 'word '.repeat(2000);
const chapter = (n: number) => ({
  number: n,
  title: `C${n}`,
  content: `<p>Line ${n}. ${LONG}</p>`,
});

const context = (merged: StepContext['merged'] = {}): StepContext => ({
  language: 'en',
  dossier: {
    chapters: [1, 2, 3, 4].map((n) => ({ number: n, title: `C${n}`, summary: `S${n}.` })),
  },
  glossary: null,
  bookTitle: 'Book',
  author: 'Author',
  stored: EMPTY_BOOK_ANALYSIS,
  merged,
  chapters: [1, 2, 3, 4].map(chapter),
  otherKeys: '',
});

const textOf = (r: ShapedRequest) => r.messages.map((m) => m.content).join('\n');
/** Влезает вход не длиннее `max` знаков. */
const fitsUpTo = (max: number) => (input: StepInput) =>
  Promise.resolve(textOf(input.author(null)).length <= max);
const quotes = indexChapters(new Map());

describe('fitStepInput', () => {
  const merged = {
    characters: [
      { key: 'a', name: 'A', role: 'main' as const, quote: { text: 'Line 3.', chapter: 3 } },
      { key: 'b', name: 'B', role: 'secondary' as const, quote: { text: 'Line 3.', chapter: 3 } },
      { key: 'c', name: 'C', role: 'minor' as const, quote: { text: 'Line 1.', chapter: 1 } },
    ],
  };

  it('step 2 on a long version: the chapter summaries plus the chapters of the step 1 quotations, while they fit', async () => {
    const ctx = context(merged);
    const base = textOf((await fitStepInput(2, ctx, quotes, fitsUpTo(15_000)))!.input.author(null));
    expect(base).toContain('[CHAPTER 1] C1');
    // Под предел ровно одной главы: глава первой цитаты (3), а не следующая.
    const one = await fitStepInput(2, ctx, quotes, fitsUpTo(base.length + 1));
    expect(one?.source).toBe('summaries');
    const fit = await fitStepInput(2, ctx, quotes, fitsUpTo(30_000));
    const text = textOf(fit!.input.author(null));
    expect(text).toContain('[READER CHAPTER 3]');
    expect(text).toContain('[READER CHAPTER 1]');
    expect(text).not.toContain('[READER CHAPTER 2]');
    expect(text.indexOf('[READER CHAPTER 3]')).toBeLessThan(text.indexOf('[READER CHAPTER 1]'));
    const limited = textOf(
      (await fitStepInput(2, ctx, quotes, fitsUpTo(22_000)))!.input.author(null),
    );
    expect(limited).toContain('[READER CHAPTER 3]');
    expect(limited).not.toContain('[READER CHAPTER 1]');
  });

  it('step 1: the chapter summaries only, no chapters of the text', async () => {
    const fit = await fitStepInput(1, context(merged), quotes, fitsUpTo(30_000));
    expect(fit?.source).toBe('summaries');
    expect(textOf(fit!.input.author(null))).not.toContain('[READER CHAPTER');
  });

  it('the whole text fits - it is the input; nothing fits - DRAFT_TOO_LONG (null)', async () => {
    expect((await fitStepInput(1, context(), quotes, fitsUpTo(1_000_000)))?.source).toBe('text');
    expect(await fitStepInput(1, context(), quotes, fitsUpTo(100))).toBeNull();
  });

  it('step 3 refers to the chapters of the quotations of steps 1-2 and the chapters numbers, in the order of the first mention', () => {
    const ctx = context({
      ...merged,
      keyQuotes: [
        { text: 'Line 4.', chapter: 4 },
        { text: 'x', chapter: 9 },
      ],
      style: [{ device: 'd', explanation: 'e', example: { text: 'Line 2.', chapter: 2 } }],
    });
    expect(referencedChapters(3, ctx)).toEqual([3, 1, 4, 2]);
    expect(referencedChapters(2, ctx)).toEqual([3, 1]);
    expect(referencedChapters(1, ctx)).toEqual([]);
  });
});

describe('stepInputFits', () => {
  const AUTHOR_MAX = 4_000;
  /** Автор влезает всегда; граница проверяющей - `ceiling` знаков входа. */
  const llmWith = (ceiling: number) =>
    ({
      stageFit: () => Promise.resolve({ fits: true, model: 'm' }),
      stageInputCeiling: () => Promise.resolve({ maxInputChars: ceiling, model: 'r' }),
      getStageSetting: () => Promise.resolve({ maxTokens: AUTHOR_MAX }),
    }) as unknown as Parameters<typeof stepInputFits>[0];
  const reviewChars = (input: StepInput) => estimateInputTokens(input.review(EMPTY_DRAFT));

  it('the review fits with an empty answer but not with the author maxTokens: the summaries input, then DRAFT_TOO_LONG', async () => {
    const ctx = context();
    const whole = stepInput(1, ctx, versionBook(ctx), quotes);
    const margin = AUTHOR_MAX * ANSWER_CHARS_PER_TOKEN;
    // Пустой ответ влезает, с запасом на ответ автора - нет.
    const ceiling = reviewChars(whole) + margin - 1;
    expect(reviewChars(whole)).toBeLessThanOrEqual(ceiling);
    expect(await stepInputFits(llmWith(ceiling), whole)).toBe(false);
    const fit = await fitStepInput(1, ctx, quotes, (input) =>
      stepInputFits(llmWith(ceiling), input),
    );
    expect(fit?.source).toBe('summaries');
    expect(reviewChars(fit!.input) + margin).toBeLessThanOrEqual(ceiling);
    const tight = reviewChars(fit!.input) + margin - 1;
    expect(
      await fitStepInput(1, ctx, quotes, (input) => stepInputFits(llmWith(tight), input)),
    ).toBeNull();
  });

  it('the margin is the upper answer length: a review that fits with 2.5 chars per token but not with 4 does not fit', async () => {
    const ctx = context();
    const whole = stepInput(1, ctx, versionBook(ctx), quotes);
    const ceiling = reviewChars(whole) + AUTHOR_MAX * INPUT_CHARS_PER_TOKEN;
    expect(reviewChars(whole) + AUTHOR_MAX * ANSWER_CHARS_PER_TOKEN).toBeGreaterThan(ceiling);
    expect(await stepInputFits(llmWith(ceiling), whole)).toBe(false);
  });

  it('the ceiling of the review is unknown: it fits, the provider decides', async () => {
    const ctx = context();
    const llm = {
      stageFit: () => Promise.resolve({ fits: true, model: 'm' }),
      stageInputCeiling: () => Promise.resolve({ maxInputChars: null, model: 'r' }),
      getStageSetting: () => Promise.resolve({ maxTokens: AUTHOR_MAX }),
    } as unknown as Parameters<typeof stepInputFits>[0];
    expect(await stepInputFits(llm, stepInput(1, ctx, versionBook(ctx), quotes))).toBe(true);
  });
});

describe('readStepAnswer', () => {
  it('a key quotation without text is not an element: no drop without text, no slot of the limit', () => {
    const answer = {
      keyQuotes: [
        { text: '  ', chapter: 1, speakerKey: '', interpretation: 'i' },
        { text: 'Line 1.', chapter: 1, speakerKey: '', interpretation: 'i' },
      ],
      style: [],
    };
    const chapters = indexChapters(new Map([[1, 'Line 1.']]));
    const draft = readStepAnswer(2, answer, chapters, {
      characterKeys: new Set(),
      quoteIds: new Set(),
      storedThemeKeys: new Set(),
    });
    expect(draft.blocks.keyQuotes).toEqual([{ text: 'Line 1.', chapter: 1, interpretation: 'i' }]);
    expect(draft.droppedQuotes).toEqual([]);
  });
});

describe('the example of the version language (К3)', () => {
  it('the prompt of a step carries the slice of its own blocks only, in the version language', () => {
    const ctx = { ...context(), language: 'ru' as const };
    const prompt = textOf(
      stepInput(2, ctx, { text: 'x', isSummaries: false }, quotes).author(null),
    );
    const slice = JSON.parse(exampleSlice(2, 'ru')) as Record<string, unknown>;
    expect(Object.keys(slice)).toEqual(['keyQuotes', 'style']);
    expect(prompt).toContain(exampleSlice(2, 'ru'));
    const ru = EXAMPLE_ANALYSES.ru as { mainIdea: string; keyQuotes: Array<{ text: string }> };
    expect(prompt).toContain(ru.keyQuotes[0].text);
    expect(prompt).not.toContain(ru.mainIdea);
    expect(JSON.stringify(slice)).not.toContain('themeKeys');
    expect(Object.keys(JSON.parse(exampleSlice(1, 'en')) as object)).toEqual([
      'facts',
      'characters',
    ]);
    expect(Object.keys(JSON.parse(exampleSlice(3, 'ru')) as object)).toEqual([
      'mainIdea',
      'themes',
      'symbols',
      'titleMeaning',
      'endingMeaning',
    ]);
  });

  it('Б1: the step 2 slice has no Bakhtin in any language and still teaches style; the step 1 slice of en/es/fr/pt has no razum etymology, ru keeps the hero', () => {
    for (const language of ['en', 'es', 'fr', 'pt', 'ru'] as const) {
      const two = exampleSlice(2, language);
      expect(two).not.toMatch(/Bakhtin|Bajtín|Bakhtine|Бахтин/);
      expect((JSON.parse(two) as { style: unknown[] }).style.length).toBeGreaterThan(0);
    }
    for (const language of ['en', 'es', 'fr', 'pt'] as const) {
      const one = exampleSlice(1, language);
      expect(one.toLowerCase()).not.toContain('razum');
      expect(one).not.toContain('razumikhin');
    }
    const ru = JSON.parse(exampleSlice(1, 'ru')) as { characters: Array<{ key: string }> };
    expect(ru.characters.map((c) => c.key)).toContain('razumikhin');
  });

  const SLICE_CASES = (['en', 'es', 'fr', 'pt', 'ru'] as const).flatMap((language) =>
    ([1, 2, 3] as const).map((step) => [language, step] as const),
  );
  const OUTSIDE_FACTS = [
    /\b1[89]\d\d\b/,
    /\braskol\b/i,
    /stepping over/i,
    /readers still/i,
    /ancestor/i,
    /топограф/i,
    /surprises many readers|sorprende a muchos lectores|déroute souvent le lecteur|surpreende muitos leitores/i,
  ];

  it.each(SLICE_CASES)(
    'the %s slice of step %d has no fact outside the text (years, raskol, the Russian title, topography, ancestors) and is not empty',
    (language, step) => {
      const slice = exampleSlice(step, language);
      for (const marker of OUTSIDE_FACTS) expect(slice).not.toMatch(marker);
      if (language !== 'ru') expect(slice).not.toMatch(/Russian/);
      const blocks = Object.values(JSON.parse(slice) as Record<string, unknown>);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toBeTruthy();
        if (Array.isArray(block)) expect(block.length).toBeGreaterThan(0);
      }
      if (step === 1) {
        const one = JSON.parse(slice) as { facts: object; characters: Array<{ key: string }> };
        expect(Object.keys(one.facts)).not.toContain('settingTime');
        if (language !== 'ru') expect(slice).not.toContain('porfiry');
      }
      if (step === 2) {
        expect((JSON.parse(slice) as { style: unknown[] }).style.length).toBeGreaterThan(0);
      }
      if (step === 3 && language !== 'ru') {
        expect(slice).not.toContain('alienation');
        expect(slice).not.toContain('"guilt"');
        const themes = (JSON.parse(slice) as { themes: Array<{ key: string }> }).themes;
        expect(themes.map((th) => th.key)).toEqual(
          ['en', 'es'].includes(language)
            ? ['extraordinary-man', 'redemption', 'poverty']
            : ['extraordinary-man', 'redemption'],
        );
      }
    },
  );

  it('ru keeps its own blocks: the alienation and guilt themes, the second key quotation, Porfiry', () => {
    const three = JSON.parse(exampleSlice(3, 'ru')) as { themes: Array<{ key: string }> };
    expect(three.themes.map((th) => th.key)).toContain('alienation');
    expect(three.themes.map((th) => th.key)).toContain('guilt');
    const two = JSON.parse(exampleSlice(2, 'ru')) as { keyQuotes: Array<{ text: string }> };
    const ru = EXAMPLE_ANALYSES.ru as { keyQuotes: Array<{ text: string }> };
    expect(two.keyQuotes.map((q) => q.text)).toContain(ru.keyQuotes[1].text);
    const one = JSON.parse(exampleSlice(1, 'ru')) as { characters: Array<{ key: string }> };
    expect(one.characters.map((c) => c.key)).toContain('porfiry');
  });

  it('А1: step 3 asks no fact outside the text - no play on words of the original, no other titles; the example of en/es/fr/pt has no titleMeaning', () => {
    for (const language of ['en', 'es', 'fr', 'pt'] as const) {
      expect(Object.keys(JSON.parse(exampleSlice(3, language)) as object)).toEqual([
        'mainIdea',
        'themes',
        'symbols',
        'endingMeaning',
      ]);
    }
    const ctx = context();
    const prompt = textOf(stepInput(3, ctx, versionBook(ctx), quotes).author(null));
    expect(prompt).not.toMatch(/play on words|another title|published/i);
    expect(prompt).not.toContain((EXAMPLE_ANALYSES.en as { titleMeaning: string }).titleMeaning);
    expect(prompt).toContain('only from the text of this version');
  });

  it('keyQuotes: the count is a guide, fewer is fine when the text does not give more', () => {
    const ctx = context();
    const prompt = textOf(stepInput(2, ctx, versionBook(ctx), quotes).author(null));
    expect(prompt).toContain('fewer is fine when the text does not give more');
  });
});
