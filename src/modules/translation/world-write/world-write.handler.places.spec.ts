import { Prisma } from '@prisma/client';
import type { DraftRemark } from '../draft-quality/text-checks';
import { placeRecord, regenCurrent } from './world-write.handler';
import { emptyWorldData, readWorldData, worldDataJson } from './world-write.data';
import { worldWriteHandler } from './world-write.spec-fixtures';
import { placeInput } from './world-write.steps';
import { entityBlock } from './world-write.data';
import { indexChapters } from '../draft-quality/quote-check';

/**
 * Места в ходе «Write World» (`F08-12b`, решения арбитра `F08 | F08-12b` Q1, Q2): выбор мест на шаге 0,
 * шаг места после пар, отказ до платного вызова, пункты записанного шага места.
 */

const anna = {
  key: 'anna',
  role: 'main' as const,
  name: 'Anna',
  aliases: [],
  mentions: { chapters: [1, 2], perChapter: {} },
};

const context = (entities = new Map<string, { type: string; description?: string | null }>()) => ({
  language: 'en',
  dossier: {
    entities: [
      { key: 'garret', name: 'garret', kind: 'place', whatIs: 'a room', firstChapter: 1 },
      { key: 'square', name: 'square', kind: 'place', whatIs: 'a square', firstChapter: 2 },
      // Ключ героя анализа: место на нём не пишется (Q1).
      { key: 'anna', name: 'Anna street', kind: 'place', whatIs: 'a street', firstChapter: 1 },
      { key: 'axe', name: 'axe', kind: 'object', whatIs: 'a tool', firstChapter: 1 },
    ],
  },
  glossary: null,
  bookTitle: 'B',
  author: 'A',
  originalLanguage: '',
  entities,
  chapters: [
    { number: 1, title: 'C1', content: '<p>Anna sat in the garret.</p>' },
    { number: 2, title: 'C2', content: '<p>Anna left the garret for the square.</p>' },
  ],
  analysis: { characters: [{ key: 'anna', name: 'Anna', role: 'main' }] },
  names: { titles: ['B'], authors: ['A'] },
});

describe('WorldWriteHandler: places at the choice step (F08-12b, Q1)', () => {
  // Текст не влез (`stageFit` - нет): шаг выбора без вызова; места считаются по названиям досье.
  const choose = async (data: unknown, ctx = context()) => {
    const llm = { stageFit: jest.fn().mockResolvedValue({ fits: false }) };
    const prisma = { bookWorldEntity: { findMany: jest.fn().mockResolvedValue([]) } };
    const handler = worldWriteHandler({ llm, prisma });
    const inner = handler as unknown as {
      candidatesOf: jest.Mock;
      produceStep: (...a: unknown[]) => Promise<{
        places?: Array<{ key: string; mentions: { chapters: number[] } }>;
        placesOff?: unknown;
        leftOut?: Array<{ key: string; reason: string }>;
      } | null>;
    };
    inner.candidatesOf = jest.fn().mockResolvedValue({
      candidates: [anna],
      leftOut: [],
      coPresence: new Map(),
    });
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

  it('a new run: the dossier place in 2 chapters is a place of the run, one chapter and a hero key are left out', async () => {
    const record = await choose(worldDataJson(emptyWorldData()));
    expect(record?.places?.map((p) => [p.key, p.mentions.chapters])).toEqual([['garret', [1, 2]]]);
    expect(record?.placesOff).toBeNull();
    expect(record?.leftOut?.map((s) => [s.key, s.reason])).toEqual([
      ['anna', 'PLACE_KEY_TAKEN'],
      ['square', 'PLACE_BELOW_MIN_CHAPTERS'],
    ]);
  });

  it('a stored entity of another type on the place key: the place is left out before any paid step', async () => {
    const record = await choose(
      worldDataJson(emptyWorldData()),
      context(new Map([['garret', { type: 'character' }]])),
    );
    expect(record?.places).toEqual([]);
    expect(record?.leftOut?.map((s) => [s.key, s.reason])).toContainEqual([
      'garret',
      'PLACE_KEY_TAKEN',
    ]);
  });

  it('a run started before F08-12b (no places field) gets no places: its estimate had none', async () => {
    const record = await choose({ candidates: null, pairs: null, steps: [] });
    expect(record?.places).toEqual([]);
    expect(record?.leftOut).toEqual([]);
  });

  it('a language without a place sample: no places, WORLD_PLACE_LANGUAGE', async () => {
    const record = await choose(worldDataJson(emptyWorldData()), { ...context(), language: 'de' });
    expect(record?.places).toEqual([]);
    expect(record?.placesOff).toBe('WORLD_PLACE_LANGUAGE');
  });
});

describe('WorldWriteHandler: the place step (F08-12b)', () => {
  const garret = {
    key: 'garret',
    name: 'Garret',
    aliases: ['garret'],
    mentions: { chapters: [1, 2], perChapter: {} },
  };
  const data = { ...emptyWorldData(), candidates: [anna], pairs: [], places: [garret] };
  const placeStep = (ctx: ReturnType<typeof context>, loopResult: unknown, place = garret) => {
    const llm = {
      stageFit: jest.fn().mockResolvedValue({ fits: true }),
      stageInputCeiling: jest.fn().mockResolvedValue({ maxInputChars: null }),
      getStageSetting: jest.fn().mockResolvedValue({}),
    };
    const handler = worldWriteHandler({ llm });
    const inner = handler as unknown as {
      loop: jest.Mock;
      produceStep: (...a: unknown[]) => Promise<{
        step: { kind: string; key: string | null; outcome: string; failedReason: string | null };
        items: Array<{ block: string }>;
      } | null>;
    };
    inner.loop = jest.fn().mockResolvedValue(loopResult);
    // Шаг 3: выбор, страница и внешние блоки Анны - 0..2, пар нет, место - 3.
    const step = inner.produceStep(
      { id: 'd1', bookVersionId: 'v1' },
      { kind: 'run', operationId: 'op1' },
      3,
      ctx,
      { ...data, places: [place] },
      null,
      {},
    );
    return { step, loop: inner.loop };
  };

  it('step 1 + 2 heroes + pairs is the place step: the place page is written by the page stage', async () => {
    const draft = {
      name: 'The garret',
      blocks: { short: 'A tiny room.', kind: 'fictional', description: 'A cupboard of a room.' },
      fixes: [],
      droppedQuotes: [],
    };
    const { step, loop } = placeStep(context(), {
      ok: true,
      draft,
      attempt: 1,
      verdict: 'ok',
      remarks: [],
      authorModel: 'a',
      review: { kind: 'answered', model: 'r' },
      costUsd: new Prisma.Decimal(0),
    });
    const record = await step;
    expect(record?.step).toMatchObject({ kind: 'place', key: 'garret', outcome: 'done' });
    expect(record?.items.map((i) => i.block)).toEqual(['aliases', 'short', 'kind', 'description']);
    expect(loop).toHaveBeenCalledTimes(1);
  });

  it('the place key got an entity of another type after the choice - WORLD_PLACE_KEY_TAKEN, no call', async () => {
    const { step, loop } = placeStep(context(new Map([['garret', { type: 'pair' }]])), null);
    expect((await step)?.step).toMatchObject({
      outcome: 'failed',
      failedReason: 'WORLD_PLACE_KEY_TAKEN',
    });
    expect(loop).not.toHaveBeenCalled();
  });

  it('a place found in no chapter - WORLD_PLACE_NOT_FOUND (its own code, /qa round 2), no call', async () => {
    const lost = { ...garret, mentions: { chapters: [], perChapter: {} } };
    const { step, loop } = placeStep(context(), null, lost);
    expect((await step)?.step).toMatchObject({
      outcome: 'failed',
      failedReason: 'WORLD_PLACE_NOT_FOUND',
    });
    expect(loop).not.toHaveBeenCalled();
  });
});

describe('placeRecord: the items of a written place step (F08-12b, Q2)', () => {
  const garret = {
    key: 'garret',
    name: 'Garret',
    aliases: ['garret'],
    mentions: { chapters: [1, 2], perChapter: {} },
  };
  const loopDraft = (blocks: Record<string, unknown>, remarks: DraftRemark[] = []) => ({
    ok: true as const,
    draft: { name: null, blocks, fixes: [], droppedQuotes: [], briefFor: 'print-of-description' },
    attempt: 1 as const,
    verdict: 'ok' as const,
    remarks,
    authorModel: 'author',
    review: { kind: 'answered' as const, model: 'reviewer' },
    costUsd: new Prisma.Decimal(0),
  });

  it('the brief goes with the print of the description; no name from the model - the place name', () => {
    const got = placeRecord(
      3,
      garret,
      loopDraft({ description: 'A cupboard.', imageBrief: 'A wide 16:9 view.' }),
      'text',
      false,
    );
    expect(got.items.map((i) => [i.block, i.name])).toEqual([
      ['aliases', 'Garret'],
      ['description', 'Garret'],
      ['imageBrief', 'Garret'],
    ]);
    expect(got.items.find((i) => i.block === 'imageBrief')?.basis).toBe('print-of-description');
  });

  it('the description refused by the import takes the brief away with BRIEF_WITHOUT_DESCRIPTION', () => {
    const refused: DraftRemark = {
      code: 'IMPORT_INVALID',
      where: 'description',
      note: 'too long',
      by: 'code',
    };
    const got = placeRecord(
      3,
      garret,
      loopDraft({ description: 'x', imageBrief: 'A wide 16:9 view.' }, [refused]),
      'text',
      true,
    );
    expect(got.items.map((i) => [i.block, i.outcome])).toEqual([['description', 'none']]);
    expect(got.step.dropped.map((f) => f.code)).toEqual(['BRIEF_WITHOUT_DESCRIPTION']);
  });
});

// /qa круг 1 F08-12b (code-review, решение арбитра `F08 | F08-12b` R3): вид и номер - один пункт.
describe('placeRecord: kind and wikidataId are one item (F08-12b, R3)', () => {
  const garret = {
    key: 'square',
    name: 'Square',
    aliases: [],
    mentions: { chapters: [1, 2], perChapter: {} },
  };
  const loop = (blocks: Record<string, unknown>, remarks: DraftRemark[] = []) => ({
    ok: true as const,
    draft: { name: null, blocks, fixes: [], droppedQuotes: [] },
    attempt: 1 as const,
    verdict: 'ok' as const,
    remarks,
    authorModel: 'author',
    review: { kind: 'answered' as const, model: 'reviewer' },
    costUsd: new Prisma.Decimal(0),
  });

  it('one kind item with {kind, wikidataId} in the place of the kind block; no wikidataId item', () => {
    const got = placeRecord(
      3,
      garret,
      loop({ short: 'A square.', kind: 'real', wikidataId: 'Q656', significance: 'x' }),
      'text',
      false,
    );
    expect(got.items.map((i) => i.block)).toEqual(['short', 'kind', 'significance']);
    expect(got.items.find((i) => i.block === 'kind')?.value).toEqual({
      kind: 'real',
      wikidataId: 'Q656',
    });
    const fictional = placeRecord(3, garret, loop({ kind: 'fictional' }), 'text', true);
    expect(fictional.items.map((i) => [i.block, i.value])).toEqual([
      ['kind', { kind: 'fictional', wikidataId: null }],
    ]);
  });

  it('a remark of the import on wikidataId refuses the kind item: kind is not written without its id', () => {
    const refused: DraftRemark = {
      code: 'IMPORT_INVALID',
      where: 'wikidataId',
      note: 'bad',
      by: 'code',
    };
    const got = placeRecord(
      3,
      garret,
      loop({ kind: 'real', wikidataId: 'Q656' }, [refused]),
      'text',
      true,
    );
    expect(got.items.map((i) => [i.block, i.outcome, i.failedReason])).toEqual([
      ['kind', 'none', 'IMPORT_INVALID'],
    ]);
  });
});

describe('WorldWriteHandler: places at the choice step with an answer (F08-12b, /qa round 1)', () => {
  it('the forms of the answer and the stored forms count the place; an excluded form does not; a place on a pair key is taken', async () => {
    const llm = {
      stageFit: jest.fn().mockResolvedValue({ fits: true }),
      stageInputCeiling: jest.fn().mockResolvedValue({ maxInputChars: null }),
      getStageSetting: jest.fn().mockResolvedValue({}),
    };
    const findMany = jest
      .fn()
      .mockResolvedValue([
        { key: 'garret', aliasExclusions: ['the room'], aliasChapterExclusions: null },
      ]);
    const handler = worldWriteHandler({ llm, prisma: { bookWorldEntity: { findMany } } });
    const ctx = {
      ...context(new Map([['garret', { type: 'place', aliases: ['Garret'] } as never]])),
      chapters: [
        { number: 1, title: 'C1', content: '<p>Anna sat in the room.</p>' },
        { number: 2, title: 'C2', content: '<p>Anna left the closet.</p>' },
        { number: 3, title: 'C3', content: '<p>Back in the Garret.</p>' },
      ],
    };
    const inner = handler as unknown as {
      loop: jest.Mock;
      candidatesOf: jest.Mock;
      produceStep: (...a: unknown[]) => Promise<{
        places?: Array<{ key: string; aliases: string[]; mentions: { chapters: number[] } }>;
        leftOut?: Array<{ key: string; reason: string }>;
      } | null>;
    };
    inner.candidatesOf = jest.fn().mockResolvedValue({
      candidates: [anna, { ...anna, key: 'boris', name: 'Boris' }],
      leftOut: [],
      coPresence: new Map([
        ['anna', { boris: [1, 2] }],
        ['boris', { anna: [1, 2] }],
      ]),
    });
    inner.loop = jest.fn().mockResolvedValue({
      ok: true,
      draft: {
        characters: [],
        // Форма «the room» исключена редактором, «closet» - форма ответа.
        places: [{ key: 'garret', name: 'The garret', aliases: ['the room', 'closet'] }],
        fixes: [],
      },
      attempt: 1,
      verdict: 'ok',
      remarks: [],
      authorModel: 'a',
      review: { kind: 'answered', model: 'r' },
      costUsd: new Prisma.Decimal(0),
    });
    const record = await inner.produceStep(
      { id: 'd1', bookVersionId: 'v1' },
      { kind: 'run', operationId: 'op1' },
      0,
      {
        ...ctx,
        dossier: {
          entities: [
            { key: 'garret', name: 'garret', kind: 'place', whatIs: '', firstChapter: 1 },
            // Ключ пары хода: место на нём не пишется.
            { key: 'anna--boris', name: 'The bridge', kind: 'place', whatIs: '', firstChapter: 1 },
          ],
        },
      },
      readWorldData(worldDataJson(emptyWorldData())),
      null,
      {},
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookVersionId: 'v1', key: { in: ['garret'] } },
        select: { key: true, aliasExclusions: true, aliasChapterExclusions: true },
      }),
    );
    const garret = record?.places?.find((p) => p.key === 'garret');
    expect(garret?.aliases).toEqual(expect.arrayContaining(['Garret', 'closet']));
    // Глава 1 стоит только по исключённой форме - не в счёт.
    expect(garret?.mentions.chapters).toEqual([2, 3]);
    expect(record?.leftOut?.map((s) => [s.key, s.reason])).toContainEqual([
      'anna--boris',
      'PLACE_KEY_TAKEN',
    ]);
  });
});

// R3: перегенерация пункта `kind` места - вид и номер вместе; блок сущности `kind` - та же пара.
describe('the kind item of a place on regeneration and in the stored entity (F08-12b, R3)', () => {
  const place = {
    key: 'square',
    name: 'Square',
    aliases: [],
    mentions: { chapters: [1], perChapter: {} },
  };
  it('a regeneration of kind keeps the wikidataId of the answer; other blocks are thrown away', () => {
    const input = placeInput(
      context() as never,
      place,
      indexChapters(new Map([[1, 'Anna sat in the garret.']])),
      { text: 'x', partial: false },
      { block: 'kind', current: { kind: 'real', wikidataId: 'Q1' }, remark: null },
    );
    const draft = input.read({ kind: 'real', wikidataId: 'Q656', short: 'Dropped.' });
    expect(draft.blocks).toEqual({ kind: 'real', wikidataId: 'Q656' });
  });

  it('entityBlock of a stored place: kind is the pair of kind and wikidataId; a character keeps its kind field', () => {
    const stored = { type: 'place', kind: 'real', wikidataId: 'Q656' } as never;
    expect(entityBlock(stored, 'kind')).toEqual({ kind: 'real', wikidataId: 'Q656' });
    expect(entityBlock({ type: 'place', kind: null, wikidataId: null } as never, 'kind')).toEqual({
      kind: null,
      wikidataId: null,
    });
    expect(entityBlock({ type: 'place', short: 'S.' } as never, 'short')).toBe('S.');
  });
});

// /qa круг 3 F08-12b: что переписывает перегенерация - блок сущности, а пустой блок - предложение.
describe('regenCurrent: the stored block, an empty one - the proposal (F08-12b, /qa round 3)', () => {
  const proposal = { block: 'kind' as const, value: { kind: 'real', wikidataId: 'Q42' } };
  it('a stored place kind pair is rewritten as is; an empty pair or no entity - the proposal', () => {
    const real = { type: 'place', kind: 'real', wikidataId: 'Q656' } as never;
    expect(regenCurrent(real, proposal)).toEqual({ kind: 'real', wikidataId: 'Q656' });
    const empty = { type: 'place', kind: null, wikidataId: null } as never;
    expect(regenCurrent(empty, proposal)).toEqual({ kind: 'real', wikidataId: 'Q42' });
    expect(regenCurrent(undefined, proposal)).toEqual({ kind: 'real', wikidataId: 'Q42' });
  });
  it('a hero block: the stored text; an empty string - the proposal', () => {
    const item = { block: 'short' as const, value: 'Proposed.' };
    expect(regenCurrent({ type: 'character', short: 'Stored.' } as never, item)).toBe('Stored.');
    expect(regenCurrent({ type: 'character', short: '' } as never, item)).toBe('Proposed.');
  });
});
