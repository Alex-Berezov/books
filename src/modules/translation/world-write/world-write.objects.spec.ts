import { Prisma } from '@prisma/client';
import { indexChapters } from '../draft-quality/quote-check';
import { readObjectAnswer } from './world-write.checks';
import {
  emptyWorldData,
  entityKindOf,
  readWorldData,
  stepAt,
  stepsTotalOf,
  worldDataJson,
  type WorldStepCounts,
} from './world-write.data';
import { chooseDossierEntities, dossierStepsUpperBound } from './world-write.dossier-entities';
import { worldWriteHandler } from './world-write.spec-fixtures';
import { objectInput, selectInput, WorldContext, worldPipelineUsd } from './world-write.steps';

/**
 * Предметы и понятия в ходе «Write World» (`F08-13b-1`; решения арбитра `F08 | F08-13b` Q1, Q5, Q6, Q7,
 * Q9 и `F08 | F08-13` Q5): нумерация шагов, данные хода, выбор на шаге 0, шаг без платного вызова,
 * связи с героями мира и темами анализа, оценка.
 */

const counts = (c: Partial<WorldStepCounts>): WorldStepCounts => ({
  heroes: 0,
  pairs: 0,
  places: 0,
  objects: 0,
  terms: 0,
  events: 0,
  ...c,
});

const hero = (key: string, chapters: number[] = [1, 2]) => ({
  key,
  role: 'main' as const,
  name: key.charAt(0).toUpperCase() + key.slice(1),
  aliases: [] as string[],
  mentions: { chapters, perChapter: {} },
});

const named = (key: string, chapters: number[]) => ({
  key,
  name: key,
  aliases: [key],
  mentions: { chapters, perChapter: {} },
});

describe('world run steps with objects and terms (F08-13b, Q6)', () => {
  it('a run without the new types keeps its step numbers', () => {
    const old = counts({ heroes: 2, pairs: 1, places: 1 });
    expect([0, 1, 2, 3, 4, 5, 6].map((s) => stepAt(s, old)?.kind)).toEqual([
      'select',
      'page',
      'external',
      'page',
      'external',
      'pair',
      'place',
    ]);
    expect(stepAt(6, { ...old, objects: 2, terms: 1 })).toEqual({ kind: 'place', candidate: 0 });
  });

  it('after the places - the objects, after the objects - the terms; a step over all types is no step (not a place)', () => {
    const run = counts({ heroes: 1, places: 1, objects: 2, terms: 1 });
    expect([3, 4, 5, 6].map((s) => stepAt(s, run))).toEqual([
      { kind: 'place', candidate: 0 },
      { kind: 'object', candidate: 0 },
      { kind: 'object', candidate: 1 },
      { kind: 'term', candidate: 0 },
    ]);
    expect(stepAt(7, run)).toBeNull();
    expect(stepAt(4, counts({ heroes: 1, places: 1 }))).toBeNull();
    // Без мест предмет идёт сразу после героев.
    expect(stepAt(3, counts({ heroes: 1, objects: 1 }))).toEqual({ kind: 'object', candidate: 0 });
  });

  it('stepsTotalOf counts one step per object and per term', () => {
    const data = {
      candidates: [hero('anna')],
      pairs: [],
      places: [named('garret', [1])],
      objects: [named('axe', [1]), named('watch', [2])],
      terms: [named('pledge', [1])],
    };
    expect(stepsTotalOf(data)).toBe(1 + 2 + 1 + 2 + 1);
    expect(stepsTotalOf({ ...data, objects: [], terms: [] })).toBe(4);
  });
});

describe('world run data: objects and terms (F08-13b, Q6)', () => {
  it('a run started before F08-13b (no fields) reads with no objects and terms: it ends on the places', () => {
    const data = readWorldData({ candidates: [hero('anna')], pairs: [], places: [] });
    expect([data.objects, data.terms, data.objectsOff, data.termsOff]).toEqual([
      [],
      [],
      null,
      null,
    ]);
    expect(data.stepsBroken).toBe(false);
    expect(stepsTotalOf(data)).toBe(3);
  });

  it('a new run writes null (not chosen yet); chosen lists and off reasons survive the round trip', () => {
    const fresh = readWorldData(worldDataJson(emptyWorldData()));
    expect([fresh.objects, fresh.terms]).toEqual([null, null]);
    const chosen = {
      ...emptyWorldData(),
      candidates: [hero('anna')],
      pairs: [],
      places: [],
      objects: [named('axe', [1])],
      terms: [],
      termsOff: 'WORLD_TERM_LANGUAGE' as const,
    };
    const read = readWorldData(worldDataJson(chosen));
    expect(read.objects).toEqual(chosen.objects);
    expect(read.termsOff).toBe('WORLD_TERM_LANGUAGE');
    expect(entityKindOf(read, 'axe')).toEqual({ type: 'object' });
    expect(entityKindOf({ ...read, terms: [named('pledge', [1])] }, 'pledge')).toEqual({
      type: 'term',
    });
  });

  it('a broken object or term entry breaks the steps: a step takes its entity by index', () => {
    const base = { candidates: [hero('anna')], pairs: [], places: [] };
    expect(readWorldData({ ...base, objects: [named('axe', [1]), { key: 1 }] }).stepsBroken).toBe(
      true,
    );
    expect(readWorldData({ ...base, terms: 'x' }).stepsBroken).toBe(true);
  });
});

/** Контекст хода: Анна и Борис в главах 1-2; в досье - место, предметы, понятия и организация. */
const context = (entities = new Map<string, { type: string; name?: string }>()) => ({
  language: 'en',
  dossier: {
    entities: [
      { key: 'garret', name: 'garret', kind: 'place', whatIs: '', firstChapter: 1 },
      { key: 'axe', name: 'axe', kind: 'object', whatIs: '', firstChapter: 1 },
      { key: 'watch', name: 'watch', kind: 'object', whatIs: '', firstChapter: 1 },
      // Ключ героя анализа и ключ места досье: предмет на них не пишется.
      { key: 'anna', name: 'Anna’s ring', kind: 'object', whatIs: '', firstChapter: 1 },
      { key: 'garret', name: 'garret lamp', kind: 'object', whatIs: '', firstChapter: 1 },
      { key: 'pledge', name: 'pledge', kind: 'term', whatIs: '', firstChapter: 2 },
      // Ключ предмета досье, пары хода и сохранённой сущности другого типа: понятие на них не пишется.
      { key: 'axe', name: 'axe', kind: 'term', whatIs: '', firstChapter: 1 },
      { key: 'anna--boris', name: 'bridge', kind: 'term', whatIs: '', firstChapter: 1 },
      { key: 'tower', name: 'tower', kind: 'term', whatIs: '', firstChapter: 1 },
      { key: 'police', name: 'police', kind: 'organization', whatIs: '', firstChapter: 1 },
    ],
  },
  glossary: null,
  bookTitle: 'B',
  author: 'A',
  originalLanguage: '',
  entities,
  chapters: [
    { number: 1, title: 'C1', content: '<p>Anna took the axe in the garret near the tower.</p>' },
    { number: 2, title: 'C2', content: '<p>Boris left a pledge in the garret.</p>' },
  ],
  analysis: {
    characters: [
      { key: 'anna', name: 'Anna', role: 'main' },
      { key: 'boris', name: 'Boris', role: 'main' },
    ],
    themes: [{ key: 'guilt', title: 'Guilt' }],
  },
  names: { titles: ['B'], authors: ['A'] },
  knownEvents: [],
});

const fitsLlm = () => ({
  stageFit: jest.fn().mockResolvedValue({ fits: true }),
  stageInputCeiling: jest.fn().mockResolvedValue({ maxInputChars: null }),
  getStageSetting: jest.fn().mockResolvedValue({}),
});

type SelectRecord = {
  objects?: Array<{ key: string; aliases: string[]; mentions: { chapters: number[] } }>;
  terms?: Array<{ key: string; mentions: { chapters: number[] } }>;
  objectsOff?: unknown;
  termsOff?: unknown;
  leftOut?: Array<{ key: string; reason: string }>;
  step: { outcome: string; failedReason: string | null };
} | null;

/** Шаг выбора: ответ выбора - `answer` (`null` - текст не влез, без вызова). */
const choose = async (
  data: unknown,
  ctx: ReturnType<typeof context> = context(new Map([['tower', { type: 'place' }]])),
  answer: unknown = null,
) => {
  const llm =
    answer === null ? { stageFit: jest.fn().mockResolvedValue({ fits: false }) } : fitsLlm();
  const prisma = { bookWorldEntity: { findMany: jest.fn().mockResolvedValue([]) } };
  const handler = worldWriteHandler({ llm, prisma });
  const inner = handler as unknown as {
    candidatesOf: jest.Mock;
    loop: jest.Mock;
    produceStep: (...a: unknown[]) => Promise<SelectRecord>;
  };
  // Пара Анна - Борис заводится по общим главам 1-2 (`choosePairs`).
  inner.candidatesOf = jest.fn().mockResolvedValue({
    candidates: [hero('anna'), hero('boris')],
    leftOut: [],
    coPresence: new Map([
      ['anna', { boris: [1, 2] }],
      ['boris', { anna: [1, 2] }],
    ]),
  });
  inner.loop = jest.fn().mockResolvedValue(answer);
  return inner.produceStep(
    { id: 'd1', bookVersionId: 'v1' },
    { kind: 'run', operationId: 'op1' },
    0,
    ctx,
    readWorldData(data),
    null,
    {},
  );
};

describe('WorldWriteHandler: objects and terms at the choice step (F08-13b, Q1)', () => {
  it('a dossier object in a chapter is an object of the run; no chapter - below the threshold; a hero or a place key - taken', async () => {
    const record = await choose(worldDataJson(emptyWorldData()));
    expect(record?.objects?.map((o) => [o.key, o.mentions.chapters])).toEqual([['axe', [1]]]);
    expect(record?.terms?.map((t) => [t.key, t.mentions.chapters])).toEqual([['pledge', [2]]]);
    expect([record?.objectsOff, record?.termsOff]).toEqual([null, null]);
    // Весь отсев по порядку: пары, места (место досье «garret» прошло), предметы, понятия, организации.
    expect(record?.leftOut?.map((s) => [s.key, s.reason])).toEqual([
      ['anna', 'OBJECT_KEY_TAKEN'],
      ['garret', 'OBJECT_KEY_TAKEN'],
      ['watch', 'OBJECT_BELOW_MIN_CHAPTERS'],
      ['axe', 'TERM_KEY_TAKEN'],
      ['tower', 'TERM_KEY_TAKEN'],
      ['anna--boris', 'TERM_KEY_TAKEN'],
      ['police', 'ORGANIZATION_SKIPPED'],
    ]);
  });

  it('a run started before F08-13b gets no objects, no terms and no organization entries', async () => {
    const record = await choose({ candidates: null, pairs: null, places: null, steps: [] });
    expect([record?.objects, record?.terms]).toEqual([[], []]);
    expect(record?.leftOut?.some((s) => /OBJECT|TERM|ORGANIZATION/.test(s.reason))).toBe(false);
  });

  it('a language without the samples: no objects and no terms, WORLD_OBJECT_LANGUAGE and WORLD_TERM_LANGUAGE', async () => {
    const record = await choose(worldDataJson(emptyWorldData()), { ...context(), language: 'de' });
    expect([record?.objects, record?.terms]).toEqual([[], []]);
    expect([record?.objectsOff, record?.termsOff]).toEqual([
      'WORLD_OBJECT_LANGUAGE',
      'WORLD_TERM_LANGUAGE',
    ]);
  });

  it('a paid choice draft of the old form (no objects and terms) is read without DRAFT_INVALID_RESPONSE', async () => {
    const oldDraft = {
      ok: true,
      draft: { characters: [], places: [], fixes: [] },
      attempt: 1,
      verdict: 'ok',
      remarks: [],
      authorModel: 'a',
      review: { kind: 'answered', model: 'r' },
      costUsd: new Prisma.Decimal(0),
    };
    const record = await choose(worldDataJson(emptyWorldData()), context(), oldDraft);
    expect(record?.step).toMatchObject({ outcome: 'done', failedReason: null });
    // Формы - из досье: предмет считается и без ответа выбора.
    expect(record?.objects?.map((o) => [o.key, o.aliases])).toEqual([['axe', ['axe']]]);
  });
});

describe('chooseObjects: the threshold and the cap of a type (F08-13b, Q1)', () => {
  it('at most 10 per type by chapters, then by key; the rest - OBJECTS_MAX', () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      named(`o${String(i).padStart(2, '0')}`, i === 10 ? [1, 2] : [1]),
    );
    const got = chooseDossierEntities('object', 'en', many, [], null);
    expect(got.list.map((o) => o.key)).toEqual([
      'o10',
      'o00',
      'o01',
      'o02',
      'o03',
      'o04',
      'o05',
      'o06',
      'o07',
      'o08',
    ]);
    expect(got.leftOut.map((s) => [s.key, s.reason])).toEqual([['o09', 'OBJECTS_MAX']]);
    expect(chooseDossierEntities('term', 'en', many, [], null).leftOut[0].reason).toBe('TERMS_MAX');
  });
});

describe('WorldWriteHandler: the object and the term step (F08-13b, Q1)', () => {
  const axe = named('axe', [1]);
  const pledge = named('pledge', [2]);
  const data = {
    ...emptyWorldData(),
    candidates: [hero('anna')],
    pairs: [],
    places: [],
    objects: [axe],
    terms: [pledge],
  };
  const run = (step: number, ctx: ReturnType<typeof context>, loopResult: unknown, d = data) => {
    const handler = worldWriteHandler({ llm: fitsLlm() });
    const inner = handler as unknown as {
      loop: jest.Mock;
      produceStep: (...a: unknown[]) => Promise<{
        step: { kind: string; key: string | null; outcome: string; failedReason: string | null };
        items: Array<{ block: string; value: unknown }>;
      } | null>;
    };
    inner.loop = jest.fn().mockResolvedValue(loopResult);
    const record = inner.produceStep(
      { id: 'd1', bookVersionId: 'v1' },
      { kind: 'run', operationId: 'op1' },
      step,
      ctx,
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

  it('step 3 is the object, step 4 the term: each is written by the page stage, items per block', async () => {
    const object = run(3, context(), done({ short: 'An axe.', significance: 'The deed.' }));
    expect((await object.record)?.step).toMatchObject({
      kind: 'object',
      key: 'axe',
      outcome: 'done',
    });
    expect((await object.record)?.items.map((i) => i.block)).toEqual([
      'aliases',
      'short',
      'significance',
    ]);
    const term = run(4, context(), done({ short: 'A thing left as security.' }));
    expect((await term.record)?.step).toMatchObject({
      kind: 'term',
      key: 'pledge',
      outcome: 'done',
    });
    expect(term.loop).toHaveBeenCalledTimes(1);
  });

  it('the key got an entity of another type after the choice - WORLD_OBJECT_KEY_TAKEN / WORLD_TERM_KEY_TAKEN, no call', async () => {
    const taken = context(
      new Map([
        ['axe', { type: 'place' }],
        ['pledge', { type: 'object' }],
      ]),
    );
    const object = run(3, taken, null);
    expect((await object.record)?.step).toMatchObject({
      outcome: 'failed',
      failedReason: 'WORLD_OBJECT_KEY_TAKEN',
    });
    expect(object.loop).toHaveBeenCalledTimes(0);
    const term = run(4, taken, null);
    expect((await term.record)?.step).toMatchObject({ failedReason: 'WORLD_TERM_KEY_TAKEN' });
    expect(term.loop).toHaveBeenCalledTimes(0);
  });

  it('found in no chapter - WORLD_OBJECT_NOT_FOUND / WORLD_TERM_NOT_FOUND, no call', async () => {
    const lost = { ...data, objects: [named('axe', [])], terms: [named('pledge', [])] };
    const object = run(3, context(), null, lost);
    expect((await object.record)?.step).toMatchObject({ failedReason: 'WORLD_OBJECT_NOT_FOUND' });
    expect(object.loop).toHaveBeenCalledTimes(0);
    const term = run(4, context(), null, lost);
    expect((await term.record)?.step).toMatchObject({ failedReason: 'WORLD_TERM_NOT_FOUND' });
    expect(term.loop).toHaveBeenCalledTimes(0);
  });
});

describe('the object step input: world characters and analysis themes with keys (F08-13b, Q5)', () => {
  const ctx = context(
    new Map([
      ['anna', { type: 'character', name: 'Anna' }],
      ['garret', { type: 'place', name: 'Garret' }],
    ]),
  ) as unknown as WorldContext;
  const quotes = indexChapters(new Map([[1, 'Anna took the axe in the garret near the tower.']]));
  const input = objectInput(ctx, 'object', named('axe', [1]), quotes, {
    text: 'x',
    partial: false,
  });

  it('the author gets the stored world characters and the themes of the analysis with their keys', () => {
    const sent = JSON.stringify(input.author(null));
    expect(sent).toContain('anna - Anna');
    expect(sent).toContain('guilt - Guilt');
    expect(sent).not.toContain('garret - Garret');
  });

  it('keys not of the world characters or the themes of the analysis are removed by the code (KEY_UNKNOWN)', () => {
    const draft = input.read({
      short: 'An axe.',
      significance: 'The deed.',
      characterKeys: ['anna', 'garret', 'nobody', 'anna'],
      themeKeys: ['guilt', 'pride'],
    });
    expect(draft.blocks.characterKeys).toEqual(['anna']);
    expect(draft.blocks.themeKeys).toEqual(['guilt']);
    expect(draft.fixes.map((f) => [f.code, f.path])).toEqual([
      ['KEY_UNKNOWN', 'characterKeys.1'],
      ['KEY_UNKNOWN', 'characterKeys.2'],
      ['KEY_UNKNOWN', 'themeKeys.1'],
    ]);
    // Что осталось, импорт мира принимает: замечаний импорта нет.
    expect(input.codeCheck(draft).filter((r) => r.code === 'IMPORT_INVALID')).toEqual([]);
  });

  it('a term takes only its fields: short, significance, quotes', () => {
    const check = {
      key: 'pledge',
      type: 'term' as const,
      language: 'en' as const,
      chapters: quotes,
      heroKeys: new Set<string>(),
      worldHeroKeys: new Set(['anna']),
      themeKeys: new Set(['guilt']),
      glossary: [],
      core: true,
    };
    const draft = readObjectAnswer(
      {
        short: 'A thing left as security.',
        description: 'x',
        faq: [{ question: 'q', answer: 'a' }],
        characterKeys: ['anna'],
        themeKeys: ['guilt'],
      },
      check,
    );
    expect(Object.keys(draft.blocks)).toEqual(['short']);
  });
});

describe('world run estimate: object and term steps (F08-13b, Q9)', () => {
  it('upper bound: the dossier entities of the type up to 10; no dossier - 10; a language without a sample - 0', () => {
    const dossier = {
      entities: [
        ...Array.from({ length: 12 }, (_, i) => ({ key: `o${i}`, name: `o${i}`, kind: 'object' })),
        { key: 't1', name: 't1', kind: 'term' },
        { key: 'org', name: 'org', kind: 'organization' },
      ],
    };
    expect(dossierStepsUpperBound(dossier, 'en', 'object')).toBe(10);
    expect(dossierStepsUpperBound(dossier, 'en', 'term')).toBe(1);
    expect(dossierStepsUpperBound(null, 'ru', 'term')).toBe(10);
    expect(dossierStepsUpperBound(dossier, 'de', 'object')).toBe(0);
  });

  it('every object and term step adds its author and reviewer cost to the run estimate', () => {
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
      pair: call(1),
      review: call(0),
    };
    const ctx = context() as unknown as WorldContext;
    const none = worldPipelineUsd(calls, ctx, 0, {});
    // Шаг - (автор 1 + проверяющая 0) × 2 прохода: 2 на сущность, 5 сущностей.
    expect(worldPipelineUsd(calls, ctx, 0, { objects: 2, terms: 3 }).sub(none).toNumber()).toBe(10);
  });
});

/** Ответ цикла качества с блоками `blocks` (оплаченный шаг прошёл). */
const loopDone = (blocks: Record<string, unknown>) => ({
  ok: true,
  draft: { name: null, blocks, fixes: [], droppedQuotes: [] },
  attempt: 1,
  verdict: 'ok',
  remarks: [],
  authorModel: 'a',
  review: { kind: 'answered', model: 'r' },
  costUsd: new Prisma.Decimal(0),
});

// /qa круг 1 F08-13b (books-tests): ядро предмета и понятия в замечаниях кода.
describe('the core of an object and a term in the code remarks (F08-13b, Q1)', () => {
  const ctx = context() as unknown as WorldContext;
  const quotes = indexChapters(new Map([[1, 'Anna took the axe in the garret near the tower.']]));
  const book = { text: 'x', partial: false };
  const core = (type: 'object' | 'term', answer: Record<string, unknown>, regen = false) => {
    const input = objectInput(
      ctx,
      type,
      named(type === 'object' ? 'axe' : 'pledge', [1]),
      quotes,
      book,
      regen ? { block: 'significance', current: null, remark: null } : null,
    );
    return input
      .codeCheck(input.read(answer))
      .filter((r) => r.code === 'CORE_MISSING')
      .map((r) => r.where);
  };

  it('an object without significance and a term without short - CORE_MISSING; a term needs only short', () => {
    expect(core('object', { short: 'An axe.' })).toEqual(['significance']);
    expect(core('term', { significance: 'Why the book needs it.' })).toEqual(['short']);
    expect(core('term', { short: 'A thing left as security.' })).toEqual([]);
  });

  it('a regeneration of one block: only that block is read, the core is not checked', () => {
    const input = objectInput(ctx, 'object', named('axe', [1]), quotes, book, {
      block: 'significance',
      current: null,
      remark: null,
    });
    const draft = input.read({
      short: 'Dropped.',
      significance: 'The deed.',
      themeKeys: ['guilt'],
    });
    expect(draft.blocks).toEqual({ significance: 'The deed.' });
    expect(core('object', { significance: 'The deed.' }, true)).toEqual([]);
  });
});

describe('WorldWriteHandler: the dossier page step of an object or a term - the paid branches (F08-13b)', () => {
  const data = {
    ...emptyWorldData(),
    candidates: [hero('anna')],
    pairs: [],
    places: [],
    objects: [named('axe', [1])],
    terms: [named('pledge', [2])],
  };
  const run = (
    step: number,
    loopResult: unknown,
    llm: object = fitsLlm(),
    regen: unknown = null,
  ) => {
    const handler = worldWriteHandler({ llm });
    const inner = handler as unknown as {
      loop: jest.Mock;
      produceStep: (...a: unknown[]) => Promise<{
        step: { kind: string; outcome: string; failedReason: string | null; source: string | null };
        items: Array<{ block: string }>;
      } | null>;
    };
    inner.loop = jest.fn().mockResolvedValue(loopResult);
    const record = inner.produceStep(
      { id: 'd1', bookVersionId: 'v1' },
      { kind: 'run', operationId: 'op1' },
      step,
      context(),
      data,
      null,
      {},
      regen,
    );
    return { record, loop: inner.loop };
  };

  it('the input does not fit - DRAFT_TOO_LONG without a call', async () => {
    const { record, loop } = run(3, null, {
      stageFit: jest.fn().mockResolvedValue({ fits: false }),
    });
    expect((await record)?.step).toMatchObject({ kind: 'object', failedReason: 'DRAFT_TOO_LONG' });
    expect(loop).toHaveBeenCalledTimes(0);
  });

  it('no answer by the form - DRAFT_INVALID_RESPONSE with the source of the text', async () => {
    const { record } = run(4, { ok: false, costUsd: new Prisma.Decimal(0) });
    expect((await record)?.step).toMatchObject({
      kind: 'term',
      outcome: 'failed',
      failedReason: 'DRAFT_INVALID_RESPONSE',
      source: 'text',
    });
  });

  it('the run is gone during the call (the loop gives null) - the step gives null, not a failure', async () => {
    const { record } = run(3, null);
    expect(await record).toBeNull();
  });

  it('a regeneration of an object block: the name forms are not written again', async () => {
    const regen = { spec: { block: 'significance', current: null, remark: null }, index: 0 };
    const { record } = run(3, loopDone({ significance: 'The deed.' }), fitsLlm(), regen);
    expect((await record)?.items.map((i) => i.block)).toEqual(['significance']);
  });
});

// /qa круг 1 F08-13b (books-tests): вход выбора несёт предметы и понятия - и в оценке, и проверяющей.
describe('the choice step carries the objects and the terms (F08-13b, Q9)', () => {
  const seen: string[] = [];
  const call = (usd: number, keep = false) => ({
    maxTokens: 1000,
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
    ...context(),
    analysis: { characters: [{ key: 'anna', name: 'Anna', role: 'main' }] },
  };

  it('the select request of the estimate lists the dossier objects and terms; no dossier - stubs; all of them, the cap is after the count', () => {
    const withDossier = base as unknown as WorldContext;
    worldPipelineUsd(calls, withDossier, 0, { objects: 1, terms: 1 }, withDossier);
    expect(seen.at(-1)).toContain('watch - watch');
    expect(seen.at(-1)).toContain('pledge - pledge');
    const noDossier = { ...base, dossier: null } as unknown as WorldContext;
    worldPipelineUsd(calls, noDossier, 0, { objects: 2, terms: 0 }, noDossier);
    expect(seen.at(-1)).toContain('object-2 - Object 2');
    expect(seen.at(-1)).not.toContain('term-1');
    const eleven = {
      ...base,
      dossier: {
        entities: Array.from({ length: 11 }, (_, i) => ({
          key: `t${i + 1}`,
          name: `Word ${i + 1}`,
          kind: 'term',
        })),
      },
    } as unknown as WorldContext;
    worldPipelineUsd(calls, eleven, 0, { terms: 10 }, eleven);
    expect(seen.at(-1)).toContain('t11 - Word 11');
  });

  it('the reviewer of the choice gets the forms of the objects and the terms; without other entities - the heroes as a list', () => {
    const ctx = base as unknown as WorldContext;
    const book = { text: 'x', partial: false };
    const draft = {
      characters: [{ key: 'anna', name: 'Anna', aliases: ['Anna'] }],
      places: [],
      objects: [{ key: 'axe', name: 'axe', aliases: ['axe'] }],
      terms: [{ key: 'pledge', name: 'pledge', aliases: ['pledge'] }],
      fixes: [],
    };
    const heroes = [{ key: 'anna', name: 'Anna' }];
    const withObjects = selectInput(ctx, heroes, new Map(), book, {
      objects: [{ key: 'axe', name: 'axe' }],
      terms: [{ key: 'pledge', name: 'pledge' }],
    });
    const sent = (request: unknown): string => JSON.stringify(request);
    expect(sent(withObjects.review(draft))).toContain(
      JSON.stringify(
        JSON.stringify({
          characters: draft.characters,
          objects: draft.objects,
          terms: draft.terms,
        }),
      ).slice(1, -1),
    );
    expect(sent(selectInput(ctx, heroes, new Map(), book).review(draft))).toContain(
      JSON.stringify(JSON.stringify(draft.characters)).slice(1, -1),
    );
  });
});

// /qa круг 2 F08-13b (tech-lead): номер шага вне всех списков - не шаг события, свой код.
describe('WorldWriteHandler: a step number out of the run (F08-13b, /qa round 2)', () => {
  it('a step over all the lists fails WORLD_STEP_OUT_OF_RUN without a call', async () => {
    const handler = worldWriteHandler({ llm: fitsLlm() });
    const inner = handler as unknown as {
      loop: jest.Mock;
      produceStep: (...a: unknown[]) => Promise<{
        step: { kind: string; failedReason: string | null };
      } | null>;
    };
    inner.loop = jest.fn();
    const data = {
      ...emptyWorldData(),
      candidates: [hero('anna')],
      pairs: [],
      places: [],
      objects: [named('axe', [1])],
      terms: [],
    };
    const record = await inner.produceStep(
      { id: 'd1', bookVersionId: 'v1' },
      { kind: 'run', operationId: 'op1' },
      4,
      context(),
      data,
      null,
      {},
    );
    expect(record?.step).toMatchObject({ kind: 'event', failedReason: 'WORLD_STEP_OUT_OF_RUN' });
    expect(inner.loop).toHaveBeenCalledTimes(0);
  });
});

// /qa круг 2 F08-13b (code-review): оценка шага предмета видит героев хода (их запишут шаги страниц).
describe('world run estimate: the object step sees the heroes of the run (F08-13b, Q5, Q9)', () => {
  /** Блок `WORLD_CHARACTERS` каждого запроса автора шага предмета (не `KEYS`: там и герои анализа). */
  const worldCharacters: string[] = [];
  const call = (record = false) => ({
    maxTokens: 1000,
    enabled: true,
    contextLength: null,
    estimate: (request: unknown) => {
      const text = (request as { messages: Array<{ content: string }> }).messages
        .map((m) => m.content)
        .join('\n');
      const block = /<<<WORLD_CHARACTERS(?:_\d+)?\n([\s\S]*?)\nWORLD_CHARACTERS(?:_\d+)?>>>/.exec(
        text,
      );
      if (record && block) worldCharacters.push(block[1]);
      return new Prisma.Decimal(JSON.stringify(request).length);
    },
  });
  const calls = {
    select: call(),
    page: call(true),
    external: call(),
    pair: call(),
    review: call(),
  };
  const withHeroes = (keys: string[]) =>
    ({
      ...context(),
      analysis: {
        characters: keys.map((key) => ({ key, name: key.toUpperCase(), role: 'main' })),
      },
    }) as unknown as WorldContext;
  const objectCost = (ctx: WorldContext) =>
    worldPipelineUsd(calls, ctx, 0, { objects: 1 }).sub(worldPipelineUsd(calls, ctx, 0, {}));

  it('no stored world characters: the heroes of the run are on the object input, and the estimate grows with them', () => {
    worldCharacters.length = 0;
    const one = objectCost(withHeroes(['anna']));
    expect(worldCharacters.at(-1)).toBe('anna - ANNA');
    const three = objectCost(withHeroes(['anna', 'boris', 'vera']));
    expect(worldCharacters.at(-1)).toBe('anna - ANNA\nboris - BORIS\nvera - VERA');
    expect(three.greaterThan(one)).toBe(true);
  });
});
