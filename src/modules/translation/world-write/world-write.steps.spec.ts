import { Prisma } from '@prisma/client';
import type { StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import {
  mainCharacters,
  pairBook,
  pairChapters,
  pairFallbackName,
  pairFormCharacters,
  pairInput,
  pairStepsUpperBound,
  worldCharacters,
  WorldContext,
  worldPipelineUsd,
} from './world-write.steps';

describe('world run candidates: who goes into the run (F08-8b)', () => {
  it('main heroes first, then secondary ones; minor heroes are never candidates', () => {
    const analysis = {
      characters: [
        { key: 'boris', name: 'Boris', role: 'secondary' },
        { key: 'vera', name: 'Vera', role: 'minor' },
        { key: 'anna', name: 'Anna', role: 'main' },
      ],
    } as unknown as StoredBookAnalysis;
    expect(worldCharacters(analysis)).toEqual([
      { key: 'anna', name: 'Anna', role: 'main' },
      { key: 'boris', name: 'Boris', role: 'secondary' },
    ]);
    expect(mainCharacters(analysis).map((c) => c.key)).toEqual(['anna']);
  });
});

describe('world run candidates: a pair-form key (F08-8e-1 Q7, LEGACY-507)', () => {
  const analysis = {
    characters: [
      { key: 'anna--tom', name: 'Anna', role: 'main' },
      { key: 'boris', name: 'Boris', role: 'secondary' },
      { key: 'vera--old', name: 'Vera', role: 'secondary' },
    ],
  } as unknown as StoredBookAnalysis;

  it('a hero with "--" in the key is never a candidate, nor a main hero that lets the run start; it is listed as pair-form', () => {
    expect(worldCharacters(analysis).map((c) => c.key)).toEqual(['boris']);
    expect(mainCharacters(analysis)).toEqual([]);
    expect(pairFormCharacters(analysis).map((c) => c.key)).toEqual(['anna--tom', 'vera--old']);
  });
});

describe('world run estimate: pair steps (F08-8e-1 Q6, Q8)', () => {
  it('pair steps on top: min(WORLD_PAIRS_MAX, C(N,2)); none on a language without a pair sample', () => {
    expect([0, 1, 2, 3, 5, 8].map((n) => pairStepsUpperBound(n, true))).toEqual([
      0, 0, 1, 3, 10, 10,
    ]);
    expect(pairStepsUpperBound(5, false)).toBe(0);
  });

  it('every pair step adds its author and reviewer cost to the run estimate', () => {
    const call = (usd: number) => ({
      maxTokens: 1000,
      enabled: true,
      contextLength: null,
      estimate: () => new Prisma.Decimal(usd),
    });
    const calls = {
      select: call(1),
      page: call(1),
      external: call(1),
      pair: call(100),
      review: call(0),
    };
    const context = {
      language: 'en',
      dossier: null,
      glossary: null,
      bookTitle: 'B',
      author: 'A',
      originalLanguage: '',
      chapters: [{ number: 1, title: 'C1', content: 'Anna and Boris.' }],
      analysis: {
        characters: [
          { key: 'anna', name: 'Anna', role: 'main' },
          { key: 'boris', name: 'Boris', role: 'main' },
        ],
      },
      entities: new Map(),
      names: { titles: ['B'], authors: ['A'] },
    } as unknown as WorldContext;
    const none = worldPipelineUsd(calls, context, 0, 0);
    // Шаг - (автор + проверяющая) × 2 прохода: 200 на пару.
    expect(worldPipelineUsd(calls, context, 0, 3).sub(none).toNumber()).toBe(600);
  });
});

describe('pair step input (F08-8e-1, review round 1)', () => {
  const member = (key: string, name: string, chapters: number[]) => ({
    key,
    role: 'main' as const,
    name,
    aliases: [],
    mentions: { chapters, perChapter: {} },
  });
  const members = { a: member('anna', 'Anna', [1, 7]), b: member('boris', 'Boris', [1]) };
  const pair = { key: 'anna--boris', a: 'anna', b: 'boris', linked: true, chapters: [1] };
  const context = {
    language: 'en',
    dossier: null,
    glossary: null,
    bookTitle: 'B',
    author: 'A',
    originalLanguage: '',
    chapters: [
      { number: 1, title: 'C1', content: 'Anna and Boris by the river.' },
      { number: 7, title: 'C7', content: 'Anna alone.' },
    ],
    analysis: { characters: [] },
    entities: new Map(),
    names: { titles: ['B'], authors: ['A'] },
  } as unknown as WorldContext;
  const row = (chapterA: number) => ({
    feature: 'Place',
    a: 'Anna walks.',
    chapterA,
    b: 'Boris rings.',
    chapterB: 1,
  });
  const quotes = new Map([
    [1, [{ raw: 'Anna and Boris by the river.' }]],
    [7, [{ raw: 'Anna alone.' }]],
  ]) as never;

  it('a side in a chapter of its hero whose text the step did not get - SCENE_OUTSIDE_MENTIONS', () => {
    const input = pairInput(context, pair, members, quotes, pairBook(context, [1], null));
    const draft = input.read({ compare: [row(7), row(1)] });
    const outside = input
      .codeCheck(draft)
      .filter((r) => r.code === 'SCENE_OUTSIDE_MENTIONS')
      .map((r) => r.where);
    expect(outside).toEqual(['compare.0.chapterA']);
  });

  it('regenerating one block of the pair: no CORE_MISSING; the whole step: CORE_MISSING', () => {
    const book = pairBook(context, [1], null);
    const spec = { block: 'bonds' as const, current: null, remark: null };
    const regen = pairInput(context, pair, members, quotes, book, spec);
    const whole = pairInput(context, pair, members, quotes, book);
    const answer = { bonds: 'Both grew up by the river.' };
    expect(regen.codeCheck(regen.read(answer)).map((r) => r.code)).not.toContain('CORE_MISSING');
    expect(whole.codeCheck(whole.read(answer)).map((r) => r.code)).toContain('CORE_MISSING');
  });

  it('pair chapters: shared ones; without shared - both heroes, linked or not (regeneration needs text, F08-8e-4 Q1-bis)', () => {
    expect(pairChapters({ ...pair, chapters: [3, 1] }, members)).toEqual([1, 3]);
    expect(pairChapters({ ...pair, chapters: [] }, members)).toEqual([1, 7]);
    expect(pairChapters({ ...pair, linked: false, chapters: [] }, members)).toEqual([1, 7]);
  });

  it('the fallback name of a pair: the names joined by "and" of the language, as in the sample', () => {
    expect(pairFallbackName('en', members)).toBe('Anna and Boris');
    expect(pairFallbackName('ru', members)).toBe('Anna и Boris');
  });
});

describe('world run candidates: a stored hero with a pair-form key stays in the run (F08-8e-1 Q7)', () => {
  const analysis = {
    characters: [
      { key: 'anna--tom', name: 'Anna', role: 'main' },
      { key: 'vera--old', name: 'Vera', role: 'secondary' },
    ],
  } as unknown as StoredBookAnalysis;

  it('the write takes a stored character with "--": it is a candidate and lets the run start; a new one is left out', () => {
    const stored = new Set(['anna--tom']);
    expect(worldCharacters(analysis, stored).map((c) => c.key)).toEqual(['anna--tom']);
    expect(mainCharacters(analysis, stored).map((c) => c.key)).toEqual(['anna--tom']);
    expect(pairFormCharacters(analysis, stored).map((c) => c.key)).toEqual(['vera--old']);
  });

  it('the fallback pair name over the import limit - the keys joined by "and"', () => {
    const long = (key: string) => ({
      key,
      role: 'main' as const,
      name: 'N'.repeat(200),
      aliases: [],
      mentions: { chapters: [1], perChapter: {} },
    });
    expect(pairFallbackName('en', { a: long('anna'), b: long('boris') })).toBe('anna and boris');
  });
});
