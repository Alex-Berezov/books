import { Prisma } from '@prisma/client';
import { indexChapters } from '../draft-quality/quote-check';
import { hasWorldObjectExample } from './examples';
import { readObjectAnswer, readSelectAnswer, objectRemarks } from './world-write.checks';
import {
  emptyWorldData,
  entityKindOf,
  readWorldData,
  stepAt,
  stepsTotalOf,
  worldDataJson,
} from './world-write.data';
import {
  chaptersExcludedForAllForms,
  eventKeyOf,
  eventMentions,
  eventsMode,
  eventStepsUpperBound,
  knownEventsOf,
  latinEventKey,
  knownWorldEvents,
  originalLanguageCode,
  pickEvents,
  selectEvents,
} from './world-write.events';
import { originalLanguageName } from './world-write.steps';
import { BOOK_WORLD_LIMITS } from '../../book-world/dto/book-world-blocks.dto';
import { shapeErrors } from '../dossier/dossier.format';
import { WORLD_STEP_SHAPES } from './world-write.prompts';
import { worldWriteHandler } from './world-write.spec-fixtures';
import type { WorldMentionSource } from '../../book-world/world-mentions';

/**
 * События в ходе «Write World» (`F08-13b-2`; решения арбитра `F08 | F08-13b` Q2, Q3, Q4, Q5, Q7, Q9,
 * R2): ключ, главы, отсев и потолок, шаг выбора, шаг страницы без платного вызова, поля ответа.
 */

const named = (key: string, chapters: number[]) => ({
  key,
  name: key,
  aliases: [key],
  mentions: { chapters, perChapter: {} },
});

describe('event key (Q3): a key of another version first, otherwise latin from the name', () => {
  it('latin from the name: transliteration, 60 characters, no trailing hyphen, the key rule', () => {
    expect(latinEventKey('Дуэль на рассвете')).toBe('duel-na-rassvete');
    expect(latinEventKey('Le duel à l’aube')).toBe('le-duel-a-l-aube');
    expect(latinEventKey('a'.repeat(59) + ' b')).toBe('a'.repeat(59));
    expect(latinEventKey('— ? —')).toBeNull();
  });

  it('a key the model names is taken only when another version has it; an invented key gives latin', () => {
    const known = new Set(['duel-at-dawn']);
    expect(eventKeyOf({ key: 'duel-at-dawn', name: 'Дуэль', originalName: '' }, known, false)).toBe(
      'duel-at-dawn',
    );
    expect(eventKeyOf({ key: 'made-up', name: 'Дуэль', originalName: '' }, known, false)).toBe(
      'duel',
    );
    expect(eventKeyOf({ key: '', name: 'Дуэль', originalName: '' }, known, false)).toBe('duel');
    // Ключ вида пары событием не бывает.
    expect(
      eventKeyOf({ key: 'a--b', name: 'Дуэль', originalName: '' }, new Set(['a--b']), false),
    ).toBe('duel');
  });

  it('Q3-1: latin from the name in the original language on a translation; empty or unusable - from the name', () => {
    const known = new Set<string>();
    const es = { key: '', name: 'La toma del hacha', originalName: 'Taking the axe' };
    expect(eventKeyOf(es, known, true)).toBe('taking-the-axe');
    expect(eventKeyOf({ ...es, originalName: '' }, known, true)).toBe('la-toma-del-hacha');
    expect(eventKeyOf({ ...es, originalName: '— ? —' }, known, true)).toBe('la-toma-del-hacha');
    // На исходнике название оригинала не берётся: название версии и есть оно.
    expect(eventKeyOf(es, known, false)).toBe('la-toma-del-hacha');
    // Ключ мира другой версии - первым и при названии оригинала.
    expect(eventKeyOf({ ...es, key: 'axe-taken' }, new Set(['axe-taken']), true)).toBe('axe-taken');
  });

  it('the events of other versions: the source language first, one event per key', () => {
    const got = knownEventsOf(
      [
        { key: 'b', name: 'B ru', language: 'ru' },
        { key: 'a', name: 'A fr', language: 'fr' },
        { key: 'a', name: 'A en', language: 'en' },
        { key: 'c', name: 'C fr', language: 'fr' },
      ],
      'en',
    );
    expect(got).toEqual([
      { key: 'a', name: 'A en' },
      { key: 'c', name: 'C fr' },
      { key: 'b', name: 'B ru' },
    ]);
  });
});

describe('pickEvents: keys taken before the paid step (Q3, Q4)', () => {
  const pick = (name: string, chapters: number[] = [1], key = '') => ({
    key,
    name,
    originalName: '',
    aliases: [name.toLowerCase()],
    nameInText: true,
    chapters,
  });

  it('a hero, a dossier key, a pair or an entity of another type take the key: EVENT_KEY_TAKEN; the same type does not', () => {
    const got = pickEvents(
      [pick('Anna'), pick('Duel'), pick('Garret'), pick('Feast'), pick('Ball')],
      new Set(),
      new Set(['anna', 'garret']),
      new Map([
        ['feast', { type: 'place' as const }],
        ['ball', { type: 'event' as const }],
      ]),
      false,
    );
    expect(got.free.map((e) => e.key)).toEqual(['duel', 'ball']);
    expect(got.leftOut.map((s) => [s.key, s.reason])).toEqual([
      ['anna', 'EVENT_KEY_TAKEN'],
      ['garret', 'EVENT_KEY_TAKEN'],
      ['feast', 'EVENT_KEY_TAKEN'],
    ]);
  });

  it('the same key twice is one event: forms and chapters add up; a name with no key - EVENT_KEY_INVALID', () => {
    const got = pickEvents(
      [pick('Duel', [2]), pick('Duel', [1, 2]), pick('???')],
      new Set(),
      new Set(),
      new Map(),
      false,
    );
    expect(got.free).toEqual([{ key: 'duel', name: 'Duel', aliases: ['duel'], chapters: [1, 2] }]);
    expect(got.leftOut.map((s) => s.reason)).toEqual(['EVENT_KEY_INVALID']);
  });

  it('two long names with the same first 60 letters are not merged: the second is EVENT_KEY_TAKEN (F08-13b-3)', () => {
    const head = 'a'.repeat(59);
    const got = pickEvents(
      [pick(`${head} first`), pick(`${head} second`)],
      new Set(),
      new Set(),
      new Map(),
      false,
    );
    expect(got.free.map((e) => e.name)).toEqual([`${head} first`]);
    expect(got.leftOut.map((s) => [s.key, s.reason])).toEqual([[head, 'EVENT_KEY_TAKEN']]);
  });

  it('on a translation the overlap check reads the same name the key is built from (F08-13b-3)', () => {
    const head = 'a'.repeat(59);
    const tr = (name: string, originalName: string) => ({ ...pick(name), originalName });
    // Оригинал не даёт ключа - ключ и основа из названия версии: второе отсеяно, а не слито.
    const fromName = pickEvents(
      [tr(`${head} first`, '— ? —'), tr(`${head} second`, '— ? —')],
      new Set(),
      new Set(),
      new Map(),
      true,
    );
    expect(fromName.free).toHaveLength(1);
    expect(fromName.leftOut.map((x) => x.reason)).toEqual(['EVENT_KEY_TAKEN']);
    // Ключ из оригинала: один оригинал - одно событие, хотя названия версии разные.
    const fromOriginal = pickEvents(
      [tr('Le duel', 'Duel'), tr('La duel', 'Duel')],
      new Set(),
      new Set(),
      new Map(),
      true,
    );
    expect([fromOriginal.free.map((e) => e.key), fromOriginal.leftOut]).toEqual([['duel'], []]);
  });

  it('on a cut-key overlap the item with answer chapters keeps the key (F08-13b-3)', () => {
    const head = 'a'.repeat(59);
    const got = pickEvents(
      [pick(`${head} first`, []), pick(`${head} second`, [3])],
      new Set(),
      new Set(),
      new Map(),
      false,
    );
    expect(got.free.map((e) => [e.name, e.chapters])).toEqual([[`${head} second`, [3]]]);
    expect(got.leftOut.map((x) => [x.names[0], x.reason])).toEqual([
      [`${head} first`, 'EVENT_KEY_TAKEN'],
    ]);
  });

  it('a name with no key is left out under a label of at most the key length (F08-13b-3)', () => {
    const got = pickEvents([pick('?'.repeat(100))], new Set(), new Set(), new Map(), false);
    expect(got.leftOut).toHaveLength(1);
    expect(got.leftOut[0].key.length).toBe(60);
  });

  it('a second item on the same key keeps its name as a form of the event', () => {
    const got = pickEvents(
      [
        { ...pick('Бал у Воланда'), key: 'bal' },
        { ...pick('Великий бал', [3]), key: 'bal' },
      ],
      new Set(['bal']),
      new Set(),
      new Map(),
      false,
    );
    expect(got.free).toEqual([
      {
        key: 'bal',
        name: 'Бал у Воланда',
        aliases: ['бал у воланда', 'Великий бал', 'великий бал'],
        chapters: [1, 3],
      },
    ]);
  });

  // /qa круг 2: название второго пункта не в тексте целым словом - не форма (правило `readAliases`).
  it('a second name that is not in the text is not a form of the event', () => {
    const got = pickEvents(
      [
        { ...pick('Бал у Воланда'), key: 'bal' },
        { ...pick('Великий бал', [3]), key: 'bal', nameInText: false },
      ],
      new Set(['bal']),
      new Set(),
      new Map(),
      false,
    );
    expect(got.free[0].aliases).toEqual(['бал у воланда', 'великий бал']);
    expect(got.free[0].chapters).toEqual([1, 3]);
  });
});

describe('event chapters (Q4) and the cap (Q2)', () => {
  it('the chapters of the forms in the text united with the chapters of the choice answer', () => {
    const got = eventMentions({ chapters: [3, 1], perChapter: { '1': 2, '3': 1 } }, [2, 3]);
    expect(got.chapters).toEqual([1, 2, 3]);
    expect(got.perChapter).toEqual({ '1': 2, '3': 1 });
    // Главы ответа выбора - отдельно: книга страницы берёт их первыми (`pageBook`).
    expect(got.named).toEqual([2, 3]);
    expect(eventMentions({ chapters: [1], perChapter: { '1': 1 } }, []).named).toBeUndefined();
  });

  // /qa круг 2: глава, исключённая редактором у формы сохранённого события, ответом не возвращается.
  it('a chapter the editor excluded is not brought back by the choice answer', () => {
    const got = eventMentions({ chapters: [1], perChapter: { '1': 1 } }, [2, 4], [4]);
    expect(got.chapters).toEqual([1, 2]);
    expect(got.named).toEqual([2]);
  });

  // /qa круг 3 (code-review): исключение одной формы-тёзки главу у события не снимает. Формы и
  // исключения - по правилу подсчёта `world-mentions.ts` (круг 4, решение `F08 | F08-13b-2` «Круг 4»).
  const stored = (patch: Partial<WorldMentionSource> = {}): WorldMentionSource => ({
    key: 'duel',
    name: 'Duel',
    aliases: ['the shot'],
    aliasExclusions: [],
    aliasChapterExclusions: [
      { form: 'The shot', chapters: [5, 7] },
      { form: 'duel', chapters: [7] },
    ],
    ...patch,
  });
  it('a chapter is excluded only when every form of the stored event is excluded there', () => {
    expect(chaptersExcludedForAllForms(stored())).toEqual([7]);
    expect(
      chaptersExcludedForAllForms(
        stored({ aliasChapterExclusions: [{ form: 'The shot', chapters: [5, 7] }] }),
      ),
    ).toEqual([]);
    // Форма, исключённая целиком, не считается: остаётся «the shot» с главами 5 и 7.
    expect(chaptersExcludedForAllForms(stored({ aliasExclusions: ['DUEL'] }))).toEqual([5, 7]);
    expect(chaptersExcludedForAllForms(stored({ name: null, aliases: [] }))).toEqual([]);
    // Одна форма исключена в главе 5 - глава из ответа выбора остаётся; обе в главе 7 - уходит.
    const got = eventMentions(
      { chapters: [], perChapter: {} },
      [5, 7],
      chaptersExcludedForAllForms(stored()),
    );
    expect(got.chapters).toEqual([5]);
  });

  // Круг 4 (architecture): короткая форма подсчёт не ведёт, свёртка - `foldMention` (ё = е).
  it('a short form and an exclusion written in another case do not bring the chapter back', () => {
    const entity = stored({
      name: 'Дуэль',
      aliases: ['Ли'],
      aliasChapterExclusions: [{ form: 'ДУЭЛЬ', chapters: [7] }],
    });
    expect(chaptersExcludedForAllForms(entity)).toEqual([7]);
    expect(
      eventMentions({ chapters: [], perChapter: {} }, [7], chaptersExcludedForAllForms(entity))
        .chapters,
    ).toEqual([]);
  });

  it('no chapter - EVENT_NO_CHAPTER; at most 10 by chapters then by key; the rest - EVENTS_MAX', () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      named(`e${String(i).padStart(2, '0')}`, i === 10 ? [1, 2] : [1]),
    );
    const got = selectEvents([...many, named('lost', [])]);
    expect(got.list.map((e) => e.key)).toEqual([
      'e10',
      'e00',
      'e01',
      'e02',
      'e03',
      'e04',
      'e05',
      'e06',
      'e07',
      'e08',
    ]);
    expect(got.skipped.map((s) => [s.key, s.reason])).toEqual([
      ['lost', 'EVENT_NO_CHAPTER'],
      ['e09', 'EVENTS_MAX'],
    ]);
  });

  it('the mode: a run before the type keeps its list; a language without the sample - off; otherwise on', () => {
    expect(eventsMode('en', [])).toBe('old');
    expect(eventsMode('en', null)).toBe('on');
    expect(eventsMode('de', null)).toBe('language');
    expect(hasWorldObjectExample('de', 'event')).toBe(false);
    expect(eventStepsUpperBound('fr')).toBe(10);
    expect(eventStepsUpperBound('de')).toBe(0);
  });
});

describe('run steps and data with events (F08-13b-2, Q6)', () => {
  const counts = { heroes: 1, pairs: 0, places: 0, objects: 1, terms: 1, events: 2 };

  it('the events go after the terms; a step over all of them is no step', () => {
    expect([3, 4, 5, 6].map((s) => stepAt(s, counts))).toEqual([
      { kind: 'object', candidate: 0 },
      { kind: 'term', candidate: 0 },
      { kind: 'event', candidate: 0 },
      { kind: 'event', candidate: 1 },
    ]);
    expect(stepAt(7, counts)).toBeNull();
  });

  it('a run started before the events reads with none and ends on the terms; the lists survive the round trip', () => {
    const old = readWorldData({ candidates: [], pairs: [], places: [], objects: [], terms: [] });
    expect([old.events, old.eventsOff, old.stepsBroken]).toEqual([[], null, false]);
    expect(readWorldData(worldDataJson(emptyWorldData())).events).toBeNull();
    const data = {
      ...emptyWorldData(),
      candidates: [],
      pairs: [],
      places: [],
      objects: [],
      terms: [],
    };
    const chosen = { ...data, events: [named('duel', [1])], eventsOff: null };
    const read = readWorldData(worldDataJson(chosen));
    expect(read.events).toEqual(chosen.events);
    expect(stepsTotalOf(read)).toBe(2);
    expect(entityKindOf(read, 'duel')).toEqual({ type: 'event' });
    expect(
      readWorldData(worldDataJson({ ...data, events: [], eventsOff: 'WORLD_EVENT_LANGUAGE' }))
        .eventsOff,
    ).toBe('WORLD_EVENT_LANGUAGE');
    expect(readWorldData({ ...data, events: [named('duel', [1]), { key: 1 }] }).stepsBroken).toBe(
      true,
    );
  });
});

const ctx = (over: Record<string, unknown> = {}) => ({
  language: 'en',
  dossier: { entities: [{ key: 'garret', name: 'garret', kind: 'place' }] },
  glossary: null,
  bookTitle: 'B',
  author: 'A',
  originalLanguage: 'en',
  entities: new Map<string, { type: string; name?: string }>(),
  chapters: [
    { number: 1, title: 'C1', content: '<p>The duel began at dawn. Anna came.</p>' },
    { number: 2, title: 'C2', content: '<p>Boris spoke of the garret.</p>' },
    { number: 3, title: 'C3', content: '<p>Nothing here.</p>' },
  ],
  analysis: {
    characters: [
      { key: 'anna', name: 'Anna', role: 'main' },
      { key: 'boris', name: 'Boris', role: 'main' },
    ],
    themes: [{ key: 'guilt', title: 'Guilt' }],
  },
  names: { titles: ['B'], authors: ['A'] },
  knownEvents: [] as Array<{ key: string; name: string }>,
  ...over,
});

const answerOf = (events: unknown[]) => ({
  ok: true,
  draft: { characters: [], places: [], objects: [], terms: [], events, fixes: [] },
  attempt: 1,
  verdict: 'ok',
  remarks: [],
  authorModel: 'a',
  review: { kind: 'answered', model: 'r' },
  costUsd: new Prisma.Decimal(0),
});

type SelectRecord = {
  events?: Array<{
    key: string;
    name: string;
    aliases: string[];
    mentions: { chapters: number[]; named?: number[] };
  }>;
  eventsOff?: unknown;
  leftOut?: Array<{ key: string; reason: string }>;
} | null;

const fitsLlm = () => ({
  stageFit: jest.fn().mockResolvedValue({ fits: true }),
  stageInputCeiling: jest.fn().mockResolvedValue({ maxInputChars: null }),
  getStageSetting: jest.fn().mockResolvedValue({}),
});

/** Шаг выбора с ответом `answer`; герои анализа - Anna и Boris (кандидаты хода подставлены). */
const choose = async (
  data: unknown,
  context: ReturnType<typeof ctx>,
  answer: unknown,
  llm: ReturnType<typeof fitsLlm> = fitsLlm(),
) => {
  const prisma = { bookWorldEntity: { findMany: jest.fn().mockResolvedValue([]) } };
  const handler = worldWriteHandler({ llm, prisma });
  const inner = handler as unknown as {
    candidatesOf: jest.Mock;
    loop: jest.Mock;
    produceStep: (...a: unknown[]) => Promise<SelectRecord>;
  };
  inner.candidatesOf = jest.fn().mockResolvedValue({
    candidates: [],
    leftOut: [],
    coPresence: new Map(),
  });
  inner.loop = jest.fn().mockResolvedValue(answer);
  return inner.produceStep(
    { id: 'd1', bookVersionId: 'v1' },
    { kind: 'run', operationId: 'op1' },
    0,
    context,
    readWorldData(data),
    null,
    {},
  );
};

describe('WorldWriteHandler: events at the choice step (F08-13b-2, Q2-Q4, Q7)', () => {
  const fresh = worldDataJson(emptyWorldData());

  it('the chapters of the forms in the text and of the answer are united; the key is latin from the name', async () => {
    const record = await choose(
      fresh,
      ctx(),
      answerOf([{ key: '', name: 'The duel', aliases: ['duel'], chapters: [2] }]),
    );
    expect(record?.events?.map((e) => [e.key, e.mentions.chapters])).toEqual([
      ['the-duel', [1, 2]],
    ]);
    expect(record?.eventsOff).toBeNull();
  });

  it('a key of another version is taken when the model names it, an invented one is not', async () => {
    const context = ctx({ knownEvents: [{ key: 'duel-at-dawn', name: 'Duel' }] });
    const record = await choose(
      fresh,
      context,
      answerOf([
        { key: 'duel-at-dawn', name: 'The duel', aliases: ['duel'], chapters: [1] },
        { key: 'made-up', name: 'Dawn', aliases: [], chapters: [2] },
      ]),
    );
    expect(record?.events?.map((e) => e.key).sort()).toEqual(['dawn', 'duel-at-dawn']);
  });

  it('an event with no known chapter is left out before the paid step; a taken key too', async () => {
    const context = ctx({
      entities: new Map([['storm', { type: 'place' }]]),
    });
    const record = await choose(
      fresh,
      context,
      answerOf([
        { key: '', name: 'Ghost', aliases: ['ghost'], chapters: [9] },
        { key: '', name: 'Storm', aliases: [], chapters: [1] },
        { key: '', name: 'Garret', aliases: [], chapters: [2] },
      ]),
    );
    expect(record?.events).toEqual([]);
    expect(
      record?.leftOut?.filter((s) => s.reason.startsWith('EVENT')).map((s) => [s.key, s.reason]),
    ).toEqual([
      ['storm', 'EVENT_KEY_TAKEN'],
      ['garret', 'EVENT_KEY_TAKEN'],
      ['ghost', 'EVENT_NO_CHAPTER'],
    ]);
  });

  it('a hero of the analysis and a dossier entity of any kind take the key before the paid step', async () => {
    const context = ctx({
      dossier: {
        entities: [
          { key: 'garret', name: 'garret', kind: 'place' },
          { key: 'guild', name: 'guild', kind: 'organization' },
          { key: 'pledge', name: 'pledge', kind: 'term' },
        ],
      },
    });
    const record = await choose(
      fresh,
      context,
      answerOf([
        { key: '', name: 'Anna', aliases: [], chapters: [1] },
        { key: '', name: 'Guild', aliases: [], chapters: [1] },
        { key: '', name: 'Pledge', aliases: [], chapters: [1] },
        { key: '', name: 'The duel', aliases: ['duel'], chapters: [1] },
      ]),
    );
    expect(record?.events?.map((e) => e.key)).toEqual(['the-duel']);
    expect(
      record?.leftOut?.filter((s) => s.reason === 'EVENT_KEY_TAKEN').map((s) => s.key),
    ).toEqual(['anna', 'guild', 'pledge']);
  });

  it('Q3-1: on a translation the latin key comes from the original name; on the source - from the name', async () => {
    const event = {
      key: '',
      name: 'El duelo',
      originalName: 'The duel at dawn',
      aliases: [],
      chapters: [1],
    };
    const translation = await choose(
      fresh,
      ctx({ language: 'es', originalLanguage: 'en' }),
      answerOf([event]),
    );
    expect(translation?.events?.map((e) => e.key)).toEqual(['the-duel-at-dawn']);
    const source = await choose(
      fresh,
      ctx({ language: 'es', originalLanguage: 'es' }),
      answerOf([event]),
    );
    expect(source?.events?.map((e) => e.key)).toEqual(['el-duelo']);
  });

  it('a choice that read a prefix takes no answer chapter past it (F08-13b-3)', async () => {
    // Весь текст не влезает: влезает только префикс без главы 3 («Nothing here.»).
    const llm = fitsLlm();
    llm.stageFit = jest.fn((_stage: unknown, request: unknown) =>
      Promise.resolve({ fits: !JSON.stringify(request).includes('Nothing here.') }),
    );
    const record = await choose(
      fresh,
      ctx(),
      answerOf([{ key: '', name: 'The duel', aliases: ['duel'], chapters: [2, 3] }]),
      llm,
    );
    expect(record?.events?.map((e) => [e.key, e.mentions.chapters, e.mentions.named])).toEqual([
      ['the-duel', [1, 2], [2]],
    ]);
  });

  it('the chapters named only by the choice stay apart from the counted ones (named)', async () => {
    const record = await choose(
      fresh,
      ctx(),
      answerOf([{ key: '', name: 'The duel', aliases: ['duel'], chapters: [3] }]),
    );
    expect(record?.events?.[0]?.mentions).toMatchObject({ chapters: [1, 3], named: [3] });
  });

  it('a language without the sample: no events, WORLD_EVENT_LANGUAGE; a run before the events keeps none', async () => {
    const off = await choose(fresh, ctx({ language: 'de' }), answerOf([]));
    expect([off?.events, off?.eventsOff]).toEqual([[], 'WORLD_EVENT_LANGUAGE']);
    const old = await choose(
      { candidates: null, pairs: null, places: null, objects: [], terms: [], steps: [] },
      ctx(),
      answerOf([{ key: '', name: 'The duel', aliases: ['duel'], chapters: [1] }]),
    );
    expect([old?.events, old?.eventsOff]).toEqual([[], null]);
  });
});

describe('WorldWriteHandler: the event step (F08-13b-2, Q4)', () => {
  const data = {
    ...emptyWorldData(),
    candidates: [
      {
        key: 'anna',
        role: 'main' as const,
        name: 'Anna',
        aliases: [],
        mentions: { chapters: [1], perChapter: {} },
      },
    ],
    pairs: [],
    places: [],
    objects: [],
    terms: [],
    events: [named('duel', [1, 2])],
  };
  const run = (step: number, context: ReturnType<typeof ctx>, loopResult: unknown, d = data) => {
    const handler = worldWriteHandler({ llm: fitsLlm() });
    const inner = handler as unknown as {
      loop: jest.Mock;
      produceStep: (...a: unknown[]) => Promise<{
        step: { kind: string; key: string | null; outcome: string; failedReason: string | null };
        items: Array<{ block: string }>;
      } | null>;
    };
    inner.loop = jest.fn().mockResolvedValue(loopResult);
    const record = inner.produceStep(
      { id: 'd1', bookVersionId: 'v1' },
      { kind: 'run', operationId: 'op1' },
      step,
      context,
      d,
      null,
      {},
    );
    return { record, loop: inner.loop };
  };
  const done = (blocks: Record<string, unknown>) => ({
    ok: true,
    draft: { name: null, blocks, fixes: [], droppedQuotes: [] },
    attempt: 1,
    verdict: 'ok',
    remarks: [],
    authorModel: 'a',
    review: { kind: 'answered', model: 'r' },
    costUsd: new Prisma.Decimal(0),
  });

  it('step 3 is the event: the page stage writes it, one item per block', async () => {
    const got = run(
      3,
      ctx(),
      done({
        short: 'A duel.',
        significance: 'The honour.',
        scenes: [{ chapter: 1, title: 't', text: 'x' }],
      }),
    );
    expect((await got.record)?.step).toMatchObject({ kind: 'event', key: 'duel', outcome: 'done' });
    expect((await got.record)?.items.map((i) => i.block)).toEqual([
      'aliases',
      'short',
      'significance',
      'scenes',
    ]);
    expect(got.loop).toHaveBeenCalledTimes(1);
  });

  it('no chapter - WORLD_EVENT_NOT_FOUND, the key taken after the choice - WORLD_EVENT_KEY_TAKEN, both without a call', async () => {
    const lost = run(3, ctx(), null, { ...data, events: [named('duel', [])] });
    expect((await lost.record)?.step).toMatchObject({ failedReason: 'WORLD_EVENT_NOT_FOUND' });
    expect(lost.loop).toHaveBeenCalledTimes(0);
    const taken = run(3, ctx({ entities: new Map([['duel', { type: 'place' }]]) }), null);
    expect((await taken.record)?.step).toMatchObject({ failedReason: 'WORLD_EVENT_KEY_TAKEN' });
    expect(taken.loop).toHaveBeenCalledTimes(0);
  });
});

describe('the event page answer (F08-13b-2, Q5)', () => {
  const quotes = indexChapters(new Map([[1, 'The duel began at dawn.']]));
  const check = {
    key: 'duel',
    type: 'event' as const,
    language: 'en' as const,
    chapters: quotes,
    heroKeys: new Set(['anna']),
    worldHeroKeys: new Set(['anna']),
    themeKeys: new Set(['guilt']),
    glossary: [],
    core: true,
  };

  it('an event takes short, significance, scenes, quotes and the world characters; description and themes are dropped', () => {
    const draft = readObjectAnswer(
      {
        short: 'A duel.',
        significance: 'The honour.',
        description: 'x',
        themeKeys: ['guilt'],
        scenes: [
          { chapter: 1, title: 't', text: 'x' },
          { chapter: 9, title: 'far', text: 'y' },
        ],
        characterKeys: ['anna', 'nobody'],
      },
      check,
    );
    expect(Object.keys(draft.blocks)).toEqual(['short', 'significance', 'scenes', 'characterKeys']);
    expect(draft.blocks.scenes).toHaveLength(1);
    expect(draft.blocks.characterKeys).toEqual(['anna']);
    expect(draft.fixes.map((f) => f.code)).toEqual(['CHAPTER_UNKNOWN', 'KEY_UNKNOWN']);
    expect(objectRemarks(draft, check, 'Duel').filter((r) => r.code === 'IMPORT_INVALID')).toEqual(
      [],
    );
  });

  it('the core needs a scene: an event without one gets CORE_MISSING on scenes', () => {
    const draft = readObjectAnswer({ short: 'A duel.', significance: 'The honour.' }, check);
    expect(
      objectRemarks(draft, check, 'Duel')
        .filter((r) => r.code === 'CORE_MISSING')
        .map((r) => r.where),
    ).toEqual(['scenes']);
  });

  it('the choice answer: events keep a name, the chapters of the version and the forms standing in the text', () => {
    const chapters = indexChapters(new Map([[1, 'The duel began at dawn.']]));
    const draft = readSelectAnswer(
      {
        events: [
          { key: ' k ', name: 'The duel', aliases: ['duel', 'ghost'], chapters: [1, 1, 7] },
          { key: 'x', name: '', aliases: [], chapters: [1] },
        ],
      },
      [],
      ['the duel began at dawn'],
      [],
      [],
      [],
      { chapters },
    );
    expect(draft.events).toEqual([
      {
        key: 'k',
        name: 'The duel',
        originalName: '',
        aliases: ['duel'],
        nameInText: true,
        chapters: [1],
      },
    ]);
    expect(draft.fixes.map((f) => f.code).sort()).toEqual([
      'ALIAS_NOT_IN_TEXT',
      'CHAPTER_UNKNOWN',
      'IMPORT_INVALID',
    ]);
    // Название оригинала (Q3-1): строка - как есть, иначе пусто без 400; длинное имя - своя заметка.
    const extra = readSelectAnswer(
      {
        events: [
          { key: '', name: 'The duel', originalName: ' Дуэль ', aliases: [], chapters: [1] },
          { key: '', name: 'The duel', originalName: 7, aliases: [], chapters: [1] },
          { key: '', name: 'x'.repeat(500), aliases: [], chapters: [1] },
        ],
      },
      [],
      ['the duel began at dawn'],
      [],
      [],
      [],
      { chapters },
    );
    expect(extra.events?.map((e) => e.originalName)).toEqual(['Дуэль', '']);
    expect(extra.fixes.find((f) => f.path === 'events.2')?.note).toMatch(/^name longer than \d+/);
    // Выбор без событий (выключены) ответа событий не читает.
    expect(readSelectAnswer({ events: [{ name: 'x' }] }, [], [], [], [], [], null).events).toEqual(
      [],
    );
  });
});

describe('knownWorldEvents: the known events for the key hint (Q3, Q3-2, /qa rounds 1-2)', () => {
  const sameBook = { book: { versions: { some: { id: 'v1' } } } };
  const db = (own: object[], original: object[], keys: string[], rows: object[]) => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(own)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(rows);
    const groupBy = jest.fn().mockResolvedValue(keys.map((key) => ({ key })));
    return { findMany, groupBy, prisma: { bookWorldEntity: { findMany, groupBy } } as never };
  };
  const ev = (key: string, name = key) => ({ key, name });
  const row = (key: string, language: string) => ({
    key,
    name: `${key} ${language}`,
    bookVersion: { language },
  });

  it('own version first (Q3-2), then the source version, then the others - one row per key', async () => {
    const { findMany, groupBy, prisma } = db(
      [ev('the-ball', 'The ball')],
      [ev('trial', 'trial en')],
      ['axe'],
      [row('axe', 'fr'), row('axe', 'es')],
    );
    const got = await knownWorldEvents(prisma, 'v1', 'en');
    expect(got).toEqual([
      { key: 'the-ball', name: 'The ball' },
      { key: 'trial', name: 'trial en' },
      { key: 'axe', name: 'axe es' },
    ]);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: { type: 'event', bookVersionId: 'v1' },
      select: { key: true, name: true },
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: {
        type: 'event',
        bookVersionId: { not: 'v1' },
        key: { notIn: ['the-ball'] },
        bookVersion: { ...sameBook, language: 'en' },
      },
      select: { key: true, name: true },
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities - 1,
    });
    const others = {
      type: 'event',
      bookVersionId: { not: 'v1' },
      key: { notIn: ['the-ball', 'trial'] },
      bookVersion: { ...sameBook, language: { not: 'en' } },
    };
    // Отдельные ключи - до среза (`groupBy`): повторы одного ключа по версиям предел не съедают.
    expect(groupBy).toHaveBeenCalledWith({
      by: ['key'],
      where: others,
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities - 2,
    });
    expect(findMany).toHaveBeenNthCalledWith(3, {
      where: { ...others, key: { in: ['axe'] } },
      select: { key: true, name: true, bookVersion: { select: { language: true } } },
      orderBy: { key: 'asc' },
      take: 5,
    });
  });

  it('the cap filled by the own version and the source: no query with take 0', async () => {
    const full = Array.from({ length: BOOK_WORLD_LIMITS.entities }, (_, i) => ev(`e${i}`));
    const { findMany, groupBy, prisma } = db(full, [], [], []);
    const got = await knownWorldEvents(prisma, 'v1', 'en');
    expect(got).toHaveLength(BOOK_WORLD_LIMITS.entities);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('an original language outside the site - no source query, the others over all versions', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row('axe', 'fr')]);
    const groupBy = jest.fn().mockResolvedValue([{ key: 'axe' }]);
    const got = await knownWorldEvents(
      { bookWorldEntity: { findMany, groupBy } } as never,
      'v1',
      'de',
    );
    expect(got).toEqual([{ key: 'axe', name: 'axe fr' }]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(groupBy.mock.calls[0][0].where.bookVersion).toEqual(sameBook);
  });

  it('no keys of other versions - no rows query', async () => {
    const { findMany, prisma } = db([], [], [], []);
    await knownWorldEvents(prisma, 'v1', 'en');
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

describe('the excluded chapters of a stored event at the choice step (/qa rounds 3-4)', () => {
  // Исключения редактора - у сохранённого события, и формы для них - его же: новое название из
  // ответа выбора в тексте не стоит, исключений у него нет (code-review круга 4).
  it('the new title from the answer does not keep a chapter where all stored forms are excluded', async () => {
    const prisma = {
      bookWorldEntity: {
        findMany: jest.fn().mockResolvedValue([
          {
            key: 'trial',
            aliasExclusions: [],
            aliasChapterExclusions: [
              { form: 'The trial', chapters: [2] },
              { form: 'the court', chapters: [2] },
            ],
          },
        ]),
      },
    };
    const handler = worldWriteHandler({ llm: fitsLlm(), prisma });
    const inner = handler as unknown as {
      candidatesOf: jest.Mock;
      loop: jest.Mock;
      produceStep: (...a: unknown[]) => Promise<SelectRecord>;
    };
    inner.candidatesOf = jest
      .fn()
      .mockResolvedValue({ candidates: [], leftOut: [], coPresence: new Map() });
    inner.loop = jest
      .fn()
      .mockResolvedValue(
        answerOf([{ key: 'trial', name: 'The Trial of Dmitri', aliases: [], chapters: [2, 3] }]),
      );
    const record = await inner.produceStep(
      { id: 'd1', bookVersionId: 'v1' },
      { kind: 'run', operationId: 'op1' },
      0,
      ctx({
        entities: new Map([
          ['trial', { type: 'event', name: 'The trial', aliases: ['the court'] }],
        ]),
        knownEvents: [{ key: 'trial', name: 'The trial' }],
      }),
      readWorldData(worldDataJson(emptyWorldData())),
      null,
      {},
    );
    expect(record?.events?.find((e) => e.key === 'trial')?.mentions.chapters).toEqual([3]);
  });
});

describe('a second run on the version keeps the saved event key (Q3-2)', () => {
  const pick = (key: string, name: string) => ({
    key,
    name,
    originalName: '',
    aliases: [],
    nameInText: true,
    chapters: [1],
  });

  it('the model names the saved key: one event, nothing left out', () => {
    const got = pickEvents(
      [pick('the-ball', 'The great ball'), pick('the-ball', 'The ball')],
      new Set(['the-ball']),
      new Set(),
      new Map([['the-ball', { type: 'event' as const }]]),
      false,
    );
    expect(got.free.map((e) => e.key)).toEqual(['the-ball']);
    expect(got.free[0].aliases).toEqual(['The ball']);
    expect(got.leftOut).toEqual([]);
  });

  it('a key known neither here nor in other versions - the Latin of the name', () => {
    const got = pickEvents(
      [pick('made-up', 'The duel')],
      new Set(['the-ball']),
      new Set(),
      new Map(),
      false,
    );
    expect(got.free.map((e) => e.key)).toEqual(['the-duel']);
  });
});

describe('the choice answer shape: originalName is optional (Q3-1, /qa round 1)', () => {
  it('an answer without originalName passes the shape check, so the events are not lost', () => {
    const answer = {
      characters: [],
      places: [],
      objects: [],
      terms: [],
      events: [{ key: '', name: 'The duel', aliases: [], chapters: [1] }],
    };
    expect(shapeErrors(answer, WORLD_STEP_SHAPES.select)).toEqual([]);
  });

  // /qa круг 2 (code-review): `events` в форме обязателен не был бы ни на ходе до 13b-2, ни при
  // EVENTS_ON = no - ответ без списка не уходит в платную переделку.
  it('an answer without events or with a broken list passes the shape check', () => {
    const base = { characters: [], places: [], objects: [], terms: [] };
    expect(shapeErrors(base, WORLD_STEP_SHAPES.select)).toEqual([]);
    expect(shapeErrors({ ...base, events: 'none' }, WORLD_STEP_SHAPES.select)).toEqual([]);
    const chapters = indexChapters(new Map([[1, 'the duel']]));
    expect(readSelectAnswer(base, [], ['the duel'], [], [], [], { chapters }).events).toEqual([]);
    expect(
      readSelectAnswer({ ...base, events: 'none' }, [], ['the duel'], [], [], [], { chapters })
        .events,
    ).toEqual([]);
  });
});

// Повтор круга 4 (books-tests, books-correctness): поле «язык оригинала» версии - свободный текст.
describe('the original language of the version is free text (Q3-1, /qa round 4)', () => {
  it('originalLanguageCode: a name or a code of a site language - its code, unknown - empty', () => {
    expect(originalLanguageCode('Russian')).toBe('ru');
    expect(originalLanguageCode('русский')).toBe('ru');
    expect(originalLanguageCode('pt-BR')).toBe('pt');
    expect(originalLanguageCode('es')).toBe('es');
    expect(originalLanguageCode('Rusian')).toBe('');
    expect(originalLanguageCode('')).toBe('');
    expect(originalLanguageCode(null)).toBe('');
  });

  it('the label of ORIGINAL_LANGUAGE: a site language by name, anything else as written', () => {
    expect(originalLanguageName('Russian')).toBe('Russian');
    expect(originalLanguageName('ru')).toBe('Russian');
    expect(originalLanguageName('Ancient Greek')).toBe('Ancient Greek');
    expect(originalLanguageName('Rusian')).toBe('Rusian');
    expect(originalLanguageName(' ')).toBe('unknown');
  });

  it('a version on the language of the original (written as a name) builds the key from its name', () => {
    const pick = {
      key: '',
      name: 'Дуэль',
      originalName: 'The duel',
      aliases: [],
      nameInText: true,
      chapters: [1],
    };
    const original = pickEvents(
      [pick],
      new Set(),
      new Set(),
      new Map(),
      'ru' !== originalLanguageCode('Russian'),
    );
    expect(original.free.map((e) => e.key)).toEqual(['duel']);
    const translation = pickEvents(
      [pick],
      new Set(),
      new Set(),
      new Map(),
      'es' !== originalLanguageCode('Russian'),
    );
    expect(translation.free.map((e) => e.key)).toEqual(['the-duel']);
  });

  it('chapter exclusions fold ё as е, as the presence count does', () => {
    const entity = {
      key: 'dead',
      name: 'Мёртвый дом',
      aliases: [],
      aliasExclusions: [],
      aliasChapterExclusions: [{ form: 'мертвый дом', chapters: [4] }],
    };
    expect(chaptersExcludedForAllForms(entity)).toEqual([4]);
  });
});
