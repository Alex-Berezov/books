import { appearancePrint } from '../../book-world/book-world-data';
import { Prisma } from '@prisma/client';
import type { StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import {
  fittingInput,
  mainCharacters,
  pairBook,
  pairChapters,
  pairFallbackName,
  pairFormCharacters,
  pageInput,
  pairInput,
  pairStepsUpperBound,
  placeInput,
  keysOfOtherTypes,
  refKeys,
  runCharacters,
  runMainCharacters,
  storedCharacterKeys,
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
    expect(worldCharacters(analysis, new Set(), new Set())).toEqual([
      { key: 'anna', name: 'Anna', role: 'main' },
      { key: 'boris', name: 'Boris', role: 'secondary' },
    ]);
    expect(mainCharacters(analysis, new Set(), new Set()).map((c) => c.key)).toEqual(['anna']);
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
    expect(worldCharacters(analysis, new Set(), new Set()).map((c) => c.key)).toEqual(['boris']);
    expect(mainCharacters(analysis, new Set(), new Set())).toEqual([]);
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
    // F08-12a (ревью кругов 4-5): герой на ключе места в оценку не входит — оценка ровно та же,
    // что у анализа без этого героя.
    const boris = new Map([['boris', { type: 'place' as const }]]);
    const withoutBoris = worldPipelineUsd(calls, context, 0, 0, {
      analysis: context.analysis,
      entities: boris,
    });
    const onlyAnna = {
      ...context,
      analysis: { characters: [{ key: 'anna', name: 'Anna', role: 'main' }] },
    } as unknown as WorldContext;
    expect(withoutBoris.toString()).toBe(worldPipelineUsd(calls, onlyAnna, 0, 0).toString());
    expect(withoutBoris.lessThan(none)).toBe(true);
    // F08-12b: шаг места - этапом страницы (автор 1 + проверяющая 0) × 2 прохода: 2 на место.
    expect(worldPipelineUsd(calls, context, 0, 0, context, 4).sub(none).toNumber()).toBe(8);
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

describe('world run candidates: a key taken by a place is not a hero candidate (F08-12a, code-review round 3)', () => {
  const analysis = {
    characters: [
      { key: 'pemberley', name: 'Pemberley', role: 'main' },
      { key: 'darcy', name: 'Darcy', role: 'main' },
    ],
  } as unknown as StoredBookAnalysis;

  it('runCharacters / runMainCharacters — one rule for the select step, step 0, start and estimate', () => {
    const entities = new Map([['pemberley', { type: 'place' as const }]]);
    expect(runCharacters({ analysis, entities }).map((c) => c.key)).toEqual(['darcy']);
    expect(runMainCharacters({ analysis, entities }).map((c) => c.key)).toEqual(['darcy']);
    const onlyPlace = {
      characters: [{ key: 'pemberley', name: 'Pemberley', role: 'main' }],
    } as unknown as StoredBookAnalysis;
    // Единственный main на ключе места: кандидатов нет — ход не стартует (WORLD_ANALYSIS_MISSING).
    expect(runMainCharacters({ analysis: onlyPlace, entities })).toEqual([]);
    expect(mainCharacters(onlyPlace, new Set(), new Set(['pemberley']))).toEqual([]);
  });

  it('the stored place key is left out before the paid step; heroes stay', () => {
    const entities = new Map([
      ['pemberley', { type: 'place' as const }],
      ['darcy', { type: 'character' as const }],
    ]);
    expect(keysOfOtherTypes(entities)).toEqual(new Set(['pemberley']));
    expect(keysOfOtherTypes(new Map([['anna--darcy', { type: 'pair' as const }]]))).toEqual(
      new Set(['anna--darcy']),
    );
    expect(
      worldCharacters(analysis, storedCharacterKeys(entities), keysOfOtherTypes(entities)).map(
        (c) => c.key,
      ),
    ).toEqual(['darcy']);
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
    expect(worldCharacters(analysis, stored, new Set()).map((c) => c.key)).toEqual(['anna--tom']);
    expect(mainCharacters(analysis, stored, new Set()).map((c) => c.key)).toEqual(['anna--tom']);
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

// F08-11d-2, решения `F08 | F08-11d` Q3–Q5, Q10 и `F08 | F08-11d-2`: ТЗ на иллюстрацию в шаге страницы.
describe('page step: the illustration brief (F08-11d-2)', () => {
  const candidate = {
    key: 'anna',
    role: 'main' as const,
    name: 'Anna',
    aliases: [],
    mentions: { chapters: [1], perChapter: { '1': 1 } },
  };
  const context = (appearance: string | null, role = 'main') =>
    ({
      language: 'ru',
      dossier: null,
      glossary: null,
      bookTitle: 'Река',
      author: 'Иван Петров',
      originalLanguage: '',
      chapters: [{ number: 1, title: 'C1', content: 'Анна у реки.' }],
      analysis: { characters: [] },
      entities: new Map(appearance === null ? [] : [['anna', { appearance, role }]]),
      names: { titles: ['Река'], authors: ['Иван Петров'] },
    }) as unknown as WorldContext;
  const quotes = new Map([[1, [{ raw: 'Анна у реки.' }]]]) as never;
  const book = { text: 'Анна у реки.', partial: false };
  // Длиной с настоящее ТЗ: проверка языка смотрит абзацы от 40 слов (`FOREIGN_WINDOW_WORDS`).
  const BRIEF =
    'Square 1:1 portrait, at least 1200x1200 px, of Anna from the novel The River by Ivan Petrov. ' +
    'A tall young woman in an old shawl standing on the bank of a cold river at dawn, her face turned ' +
    'to the water and her hands folded. Setting: a small provincial town, the end of the nineteenth ' +
    'century. No text, lettering or watermarks; no faces of real actors, no style of a recognisable artist.';
  const text = (messages: ReadonlyArray<{ content: unknown }>) =>
    messages.map((m) => String(m.content)).join('\n');

  it('the prompt asks for an English brief with the book and the author, without actors and artists; the check knows the exception', () => {
    const input = pageInput(context(null), candidate, quotes, book);
    const author = text(input.author(null).messages);
    expect(author).toContain('The only exception: imageBrief is a brief for the editors');
    expect(author).toContain('the brief for an image-generation service');
    expect(author).not.toContain('by hand');
    expect(author).toContain('a square 1:1 portrait, at least 1200x1200 px');
    expect(author).toContain('the title of the book and the name of its author');
    expect(author).toContain('no faces of real actors');
    expect(author).toContain('no style of a recognisable artist');
    expect(author).toContain('Empty appearance - imageBrief ""');
    expect(author).toContain('Река');
    expect(author).toContain('Иван Петров');
    const review = text(
      input.review({ name: 'Анна', blocks: {}, fixes: [], droppedQuotes: [] }).messages,
    );
    expect(review).toContain('The only exception: imageBrief is a brief for the editors');
  });

  it('a brief without appearance is removed by the code, with the reason; with appearance it stays', () => {
    const input = pageInput(context(null), candidate, quotes, book);
    const bare = input.read({ imageBrief: BRIEF });
    expect(bare.blocks.imageBrief).toBeUndefined();
    expect(bare.fixes).toEqual([
      {
        code: 'BRIEF_WITHOUT_APPEARANCE',
        path: 'imageBrief',
        note: 'no appearance: the brief is removed',
      },
    ]);
    const full = input.read({ appearance: 'Высокая, в старом платке.', imageBrief: BRIEF });
    expect(full.blocks.imageBrief).toBe(BRIEF);
    expect(full.fixes).toEqual([]);
  });

  it('regenerating only the brief: the appearance of the stored hero counts, the answer holds the brief alone', () => {
    const spec = { block: 'imageBrief' as const, current: null, remark: null };
    const stored = pageInput(context('Высокая.'), candidate, quotes, book, spec);
    expect(stored.read({ imageBrief: BRIEF }).blocks).toEqual({ imageBrief: BRIEF });
    const none = pageInput(context(null), candidate, quotes, book, spec);
    expect(none.read({ imageBrief: BRIEF }).blocks).toEqual({});
    // Ответ обязан нести «Внешность» (строгая форма), но при перегенерации ТЗ она не в счёт.
    const answered = none.read({ appearance: 'Высокая.', imageBrief: BRIEF });
    expect(answered.blocks).toEqual({});
    expect(answered.fixes.map((f) => f.code)).toEqual(['BRIEF_WITHOUT_APPEARANCE']);
  });

  it('a brief over the import limit is IMPORT_INVALID on its path; a brief of spaces is no brief', () => {
    const input = pageInput(context(null), candidate, quotes, book);
    const long = input.read({ appearance: 'Высокая.', imageBrief: 'x'.repeat(1501) });
    expect(
      input
        .codeCheck(long)
        .filter((r) => r.code === 'IMPORT_INVALID')
        .map((r) => r.where),
    ).toEqual(['imageBrief']);
    const blank = input.read({ appearance: 'Высокая.', imageBrief: '   ' });
    expect(blank.blocks).not.toHaveProperty('imageBrief');
    expect(blank.fixes).toEqual([]);
  });

  it('the brief carries the print of the appearance it was written for', () => {
    const input = pageInput(context(null), candidate, quotes, book);
    expect(input.read({ appearance: 'Высокая.', imageBrief: BRIEF }).briefFor).toBe(
      appearancePrint('Высокая.'),
    );
    expect(input.read({ appearance: 'Высокая.' })).not.toHaveProperty('briefFor');
  });

  it('regenerating the brief: the print is of the stored appearance, not of an appearance in the answer', () => {
    const spec = { block: 'imageBrief' as const, current: BRIEF, remark: null };
    const input = pageInput(context('Высокая.'), candidate, quotes, book, spec);
    const draft = input.read({ appearance: 'Другая.', imageBrief: BRIEF });
    expect(draft.blocks).toEqual({ imageBrief: BRIEF });
    expect(draft.briefFor).toBe(appearancePrint('Высокая.'));
  });

  it('a whole page step: the stored appearance does not save a brief the answer wrote without one', () => {
    const input = pageInput(context('Высокая.'), candidate, quotes, book);
    const draft = input.read({ imageBrief: BRIEF });
    expect(draft.blocks.imageBrief).toBeUndefined();
    expect(draft.fixes.map((f) => f.code)).toEqual(['BRIEF_WITHOUT_APPEARANCE']);
  });

  it('a stored hero demoted to minor: the brief is removed with its reason (Q2)', () => {
    const input = pageInput(context('Высокая.', 'minor'), candidate, quotes, book);
    const draft = input.read({ appearance: 'Высокая.', imageBrief: BRIEF });
    expect(draft.blocks.imageBrief).toBeUndefined();
    expect(draft.fixes.map((f) => f.code)).toEqual(['BRIEF_NOT_ALLOWED']);
  });

  it('regenerating the brief: the model gets the stored appearance as the only source of the look', () => {
    const spec = { block: 'imageBrief' as const, current: BRIEF, remark: null };
    const regen = text(
      pageInput(context('Высокая, в старом платке.'), candidate, quotes, book, spec).author(null)
        .messages,
    );
    expect(regen).toContain('the stored appearance of the character');
    expect(regen).toContain('Высокая, в старом платке.');
    const other = { block: 'short' as const, current: 'x', remark: null };
    expect(
      text(
        pageInput(context('Высокая, в старом платке.'), candidate, quotes, book, other).author(null)
          .messages,
      ),
    ).not.toContain('the stored appearance of the character');
  });

  it('an English brief on a Russian page is not a language remark', () => {
    const input = pageInput(context(null), candidate, quotes, book);
    const draft = input.read({ appearance: 'Высокая, в старом платке.', imageBrief: BRIEF });
    const paths = input.codeCheck(draft).map((r) => r.where.split(':')[0]);
    expect(paths).not.toContain('imageBrief');
  });
});

// /qa круги 2-3 F08-12b: ссылки и ключи промпта - только герои (`checkWorldRefs`), вход по объёму.
describe('refKeys and the KEYS of a prompt: characters only (F08-12b)', () => {
  const ctx = {
    language: 'en',
    dossier: null,
    glossary: null,
    bookTitle: 'B',
    author: 'A',
    originalLanguage: '',
    chapters: [{ number: 1, title: 'C1', content: '<p>Anna sat in the garret.</p>' }],
    analysis: { characters: [{ key: 'anna', name: 'Anna', role: 'main' }] },
    entities: new Map<string, { key: string; type: string; name: string }>([
      ['garret', { key: 'garret', type: 'place', name: 'The garret' }],
      ['anna--boris', { key: 'anna--boris', type: 'pair', name: 'Anna and Boris' }],
      ['boris', { key: 'boris', type: 'character', name: 'Boris' }],
    ]),
    names: { titles: ['B'], authors: ['A'] },
  } as unknown as WorldContext;

  it('refKeys: analysis heroes and stored characters, no place or pair key', () => {
    expect([...refKeys(ctx)].sort()).toEqual(['anna', 'boris']);
  });

  it('the KEYS block of the place prompt lists only characters', () => {
    const place = {
      key: 'garret',
      name: 'The garret',
      aliases: [],
      mentions: { chapters: [1], perChapter: {} },
    };
    const request = placeInput(ctx, place, new Map(), { text: 'x', partial: false }).author(null);
    const text = JSON.stringify(request);
    // Стоит только в блоке KEYS: сохранённый герой не из анализа; ключ пары - нигде; место - только
    // своим блоком PLACE, не вторым разом в KEYS.
    expect(text).toContain('boris - Boris');
    expect(text).not.toContain('anna--boris');
    expect(text.split('garret - The garret').length - 1).toBe(1);
  });
});

describe('fittingInput: the whole text, else the largest fitting part (F08-12b R4)', () => {
  const input = (n: number | null) => ({ n }) as never;
  const fitsUpTo = (max: number) => (i: { n: number | null }) =>
    Promise.resolve(i.n === null ? false : i.n <= max);
  it('the whole fits - it; else the largest count that fits; nothing fits - null', async () => {
    expect(await fittingInput(5, input, () => Promise.resolve(true))).toEqual({ n: null });
    expect(await fittingInput(5, input, fitsUpTo(3) as never)).toEqual({ n: 3 });
    expect(await fittingInput(5, input, () => Promise.resolve(false))).toBeNull();
  });
  it('the bounds: only make(0) fits - it; max 0 - make(0) or null', async () => {
    expect(await fittingInput(5, input, fitsUpTo(0) as never)).toEqual({ n: 0 });
    expect(await fittingInput(0, input, fitsUpTo(0) as never)).toEqual({ n: 0 });
    expect(await fittingInput(0, input, fitsUpTo(-1) as never)).toBeNull();
    // Влезает ровно max (но не весь текст) - max, а не на главу меньше (/qa круг 4).
    expect(await fittingInput(5, input, fitsUpTo(5) as never)).toEqual({ n: 5 });
  });
});

// /qa круг 3 F08-12b (code-review): оценка шага выбора несёт места-кандидаты (досье или заглушки).
describe('worldPipelineUsd: the choice step carries the place candidates (F08-12b, /qa round 3)', () => {
  it('the select request of the estimate lists the dossier places; no dossier - as many stubs as places', () => {
    const seen: string[] = [];
    const call = (usd: number, keep = false) => ({
      maxTokens: 0,
      enabled: true,
      contextLength: null,
      estimate: (request: unknown) => {
        if (keep) seen.push(JSON.stringify(request));
        return new Prisma.Decimal(usd);
      },
    });
    const calls = {
      select: call(1, true),
      page: call(0),
      external: call(0),
      pair: call(0),
      review: call(0),
    };
    const base = {
      language: 'en',
      glossary: null,
      bookTitle: 'B',
      author: 'A',
      originalLanguage: '',
      chapters: [{ number: 1, title: 'C1', content: 'Anna.' }],
      analysis: { characters: [{ key: 'anna', name: 'Anna', role: 'main' }] },
      entities: new Map(),
      names: { titles: ['B'], authors: ['A'] },
    };
    const withDossier = {
      ...base,
      dossier: { entities: [{ key: 'garret', name: 'The garret', kind: 'place' }] },
    } as unknown as WorldContext;
    worldPipelineUsd(calls, withDossier, 0, 0, withDossier, 1);
    expect(seen.at(-1)).toContain('garret - The garret');
    const noDossier = { ...base, dossier: null } as unknown as WorldContext;
    worldPipelineUsd(calls, noDossier, 0, 0, noDossier, 2);
    expect(seen.at(-1)).toContain('place-2 - Place 2');
    worldPipelineUsd(calls, withDossier, 0, 0, withDossier, 0);
    expect(seen.at(-1)).not.toContain('garret - The garret');
    // Все места досье, как сам шаг выбора: потолок 10 - только после подсчёта присутствия (/qa круг 4).
    const eleven = {
      ...base,
      dossier: {
        entities: Array.from({ length: 11 }, (_, i) => ({
          key: `p${i + 1}`,
          name: `Spot ${i + 1}`,
          kind: 'place',
        })),
      },
    } as unknown as WorldContext;
    worldPipelineUsd(calls, eleven, 0, 0, eleven, 10);
    expect(seen.at(-1)).toContain('p11 - Spot 11');
  });
});
