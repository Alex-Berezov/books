import { Prisma } from '@prisma/client';
import { BOOK_WORLD_LIMITS } from '../../book-world/dto/book-world-blocks.dto';
import { worldHero, worldPairContext, worldWriteHandler } from './world-write.spec-fixtures';
import type { DraftRemark } from '../draft-quality/text-checks';
import { droppedOfBlock, pageRecord, pairRecord } from './world-write.handler';
import { choosePairs } from './world-write.pairs';
import { indexChapters } from '../draft-quality/quote-check';
import { emptyWorldData, readWorldData, worldDataJson } from './world-write.data';

/**
 * Круг /fix 1 (/qa 17.11.2026, L-019): снятие отметки перегенерации переписывает данные хода целиком -
 * поэтому сначала берёт замок строк хода мира версии, тот же, что `mutate`, «Accept» и «Discard».
 */
describe('WorldWriteHandler.clearRegenMark', () => {
  it('locks the world runs of the version before it reads and rewrites the run data', async () => {
    const order: string[] = [];
    const data = {
      ...emptyWorldData(),
      items: [
        {
          key: 'anna',
          block: 'short' as const,
          step: 1,
          verdict: 'ok' as const,
          remarks: [],
          review: null,
          outcome: 'proposed' as const,
          value: 'Short.',
          sources: null,
          name: 'Anna',
          base: null,
          failedReason: null,
          regen: { operationId: 'op9', remark: null, pending: null, previous: null },
          regenFailedReason: null,
        },
      ],
    };
    const tx = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FOR UPDATE')) {
          order.push('lock');
          return Promise.resolve([]);
        }
        order.push('find');
        return Promise.resolve([{ id: 'd1', bookVersionId: 'v1' }]);
      }),
      contentDraft: {
        findUnique: jest.fn(() => {
          order.push('read');
          return Promise.resolve({ id: 'd1', data: worldDataJson(data) });
        }),
        update: jest.fn(() => {
          order.push('write');
          return Promise.resolve({});
        }),
      },
    };
    const handler = worldWriteHandler();
    await handler.clearRegenMark('op9', tx as unknown as Prisma.TransactionClient);
    expect(order).toEqual(['find', 'lock', 'read', 'write']);
  });
});

/** /fix 3 (решение арбитра `F08 | F08-4a`, остаток code-review круга 3). */
describe('WorldWriteHandler: a regeneration and the external step', () => {
  const candidate = {
    key: 'anna',
    name: 'Anna',
    aliases: ['Anna'],
    mentions: { chapters: [1], perChapter: { '1': 1 } },
  };
  const row = {
    id: 'd1',
    bookVersionId: 'v1',
    kind: 'world_write',
    status: 'building',
    language: 'en',
    operationId: 'op1',
    dossierId: 'dos1',
    glossaryId: null,
    data: null,
  };
  const step = (n: number, kind: string, key: string | null) => ({
    step: n,
    kind,
    key,
    verdict: 'ok',
    remarks: [],
    attempt: 1,
    outcome: 'done',
    failedReason: null,
    authorModel: 'm',
    review: null,
    source: 'text',
    dropped: [],
  });

  function make(rowPatch: Record<string, unknown>, fields: Record<string, jest.Mock>) {
    const db = {
      contentDraft: { findUnique: jest.fn().mockResolvedValue({ ...row, ...rowPatch }) },
      bookDossier: { findUnique: jest.fn().mockResolvedValue({ data: {} }) },
    };
    const tasks = {
      completeOperation: jest.fn((_id: string, fn?: (tx: unknown) => Promise<void>) =>
        fn ? fn({}).then(() => true) : Promise.resolve(true),
      ),
    };
    const handler = worldWriteHandler({ prisma: db, tasks, fields });
    return { handler, tasks };
  }

  it('a regeneration resumed with its item still waiting: the refused import is reported WORLD_WRITE_REFUSED, not dropped silently', async () => {
    const waiting = {
      key: 'anna',
      block: 'short',
      step: 1,
      outcome: 'waiting',
      regen: { operationId: 'op9', remark: null, pending: null, previous: null },
    };
    const fields = {
      read: jest.fn().mockResolvedValue({ ...emptyWorldData(), items: [waiting] }),
      settleStep: jest.fn().mockResolvedValue('refused'),
    };
    const { handler } = make({ status: 'ready' }, fields);
    const clear = jest.spyOn(handler, 'clearRegenMark').mockResolvedValue(undefined);
    const task = { operationId: 'op9', payload: { draftId: 'd1', index: 0 } };
    await handler.handler.run(task as never, {} as never);
    expect(fields.settleStep).toHaveBeenCalledTimes(1);
    expect(fields.settleStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd1' }),
      { kind: 'regen', operationId: 'op9', index: 0 },
      1,
      0,
    );
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith('op9', expect.anything(), 'WORLD_WRITE_REFUSED');
  });

  it('the page step is done but wrote nothing (no entity): the external step fails WORLD_PAGE_MISSING before any paid call', async () => {
    const data = {
      ...emptyWorldData(),
      candidates: [candidate],
      steps: [step(0, 'select', null), step(1, 'page', 'anna')],
    };
    let saved: unknown = null;
    const fields = {
      read: jest.fn().mockResolvedValue(data),
      settleStep: jest.fn().mockResolvedValue('settled'),
      mutate: jest.fn(async (_row: unknown, _gate: unknown, apply: (d: unknown) => unknown) => {
        saved = await apply(data);
        return saved;
      }),
    };
    const { handler } = make({}, fields);
    jest.spyOn(handler, 'contextOf').mockResolvedValue({
      language: 'en',
      dossier: {},
      glossary: null,
      bookTitle: 'Book',
      author: 'Author',
      originalLanguage: 'English',
      chapters: [{ number: 1, title: 'C1', content: '<p>Anna.</p>' }],
      analysis: { characters: [{ key: 'anna', name: 'Anna', role: 'main' }] } as never,
      entities: new Map(),
      names: { titles: ['Book'], authors: ['Author'] },
    });
    const task = { operationId: 'op1', payload: { draftId: 'd1' } };
    // `llm` и фетчер - пустые объекты: любой платный вызов здесь упал бы.
    await expect(
      handler.handler.run(task as never, { renewLease: jest.fn() } as never),
    ).resolves.toEqual({ kind: 'continue' });
    const steps = (saved as { steps: Array<{ kind: string; failedReason: string | null }> }).steps;
    expect(steps[2]).toMatchObject({ kind: 'external', failedReason: 'WORLD_PAGE_MISSING' });
  });
});

/** /fix 3б (решение арбитра `F08 | F08-4a`, находки дельты): шаг другой попытки и снятые источники. */
describe('WorldWriteHandler: a step written by another attempt; dropped sources of one block', () => {
  it('the step is already written by another attempt (lease expired mid-call): continue, the operation is not closed', async () => {
    const select = {
      step: 0,
      kind: 'select',
      key: null,
      verdict: 'ok',
      remarks: [],
      attempt: 1,
      outcome: 'done',
      failedReason: null,
      authorModel: 'm',
      review: null,
      source: 'text',
      dropped: [],
    };
    const lonely = {
      key: 'ghost',
      name: 'Ghost',
      aliases: [],
      mentions: { chapters: [], perChapter: {} },
    };
    const mine = { ...emptyWorldData(), candidates: [lonely], steps: [select] };
    const theirs = { ...mine, steps: [select, { ...select, step: 1, kind: 'page', key: 'ghost' }] };
    const fields = {
      read: jest.fn().mockResolvedValue(mine),
      settleStep: jest.fn().mockResolvedValue('settled'),
      mutate: jest.fn((_r: unknown, _g: unknown, apply: (d: unknown) => unknown) =>
        Promise.resolve(apply(theirs)),
      ),
    };
    const store = {
      contentDraft: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'd1',
          bookVersionId: 'v1',
          kind: 'world_write',
          status: 'building',
          language: 'en',
          operationId: 'op1',
          dossierId: 'dos1',
        }),
      },
      bookDossier: { findUnique: jest.fn().mockResolvedValue({ data: {} }) },
    };
    const tasks = { completeOperation: jest.fn().mockResolvedValue(true) };
    const handler = worldWriteHandler({ prisma: store, tasks, fields });
    jest.spyOn(handler, 'contextOf').mockResolvedValue({
      language: 'en',
      dossier: {},
      glossary: null,
      bookTitle: 'Book',
      author: 'Author',
      originalLanguage: '',
      chapters: [],
      analysis: { characters: [{ key: 'ghost', name: 'Ghost', role: 'main' }] } as never,
      entities: new Map(),
      names: { titles: ['Book'], authors: ['Author'] },
    });
    const task = { operationId: 'op1', payload: { draftId: 'd1' } };
    await expect(
      handler.handler.run(task as never, { renewLease: jest.fn() } as never),
    ).resolves.toEqual({ kind: 'continue' });
    expect(tasks.completeOperation).not.toHaveBeenCalled();
    expect(fields.settleStep).not.toHaveBeenCalled();
    // Итог этой попытки не дописан поверх шага другой, и строка хода не переписывается вовсе:
    // колбэк отдаёт `null` - `mutate` ничего не пишет.
    expect(fields.mutate).toHaveBeenCalledTimes(1);
    await expect(fields.mutate.mock.results[0].value).resolves.toBeNull();
  });

  it('a regenerated external block keeps only the dropped sources it refers to, by their number in the answer', () => {
    const draft = { refs: { critique: [0], prototypes: [1], adaptations: [[2], []] } };
    // Хост снятого источника - после перехода фетчера, не из адреса ответа: сопоставление - по номеру.
    const verdict = {
      droppedSources: [
        { key: 'anna', title: 'Mine', host: 'en.mine.test', reason: 'SOURCE_UNRELATED' as const },
        { key: 'anna', title: 'Theirs', host: 'theirs.test', reason: 'SOURCE_UNRELATED' as const },
        {
          key: 'anna',
          title: 'Film',
          host: 'cdn.film.test',
          reason: 'SOURCE_UNREACHABLE' as const,
        },
      ],
      droppedAt: [0, 1, 2],
    };
    expect(droppedOfBlock(verdict, draft, 'critique')).toEqual([verdict.droppedSources[0]]);
    expect(droppedOfBlock(verdict, draft, 'prototypes')).toEqual([verdict.droppedSources[1]]);
    expect(droppedOfBlock(verdict, draft, 'adaptations')).toEqual([verdict.droppedSources[2]]);
  });
});

describe('WorldWriteHandler: second-tier heroes (F08-8b)', () => {
  const chapter = (number: number, text: string) => ({
    number,
    title: `C${number}`,
    content: `<p>${text}</p>`,
  });
  const run = async (chapters: ReturnType<typeof chapter>[], stored: unknown[] = []) => {
    const store = { bookWorldEntity: { findMany: jest.fn().mockResolvedValue(stored) } };
    const handler = worldWriteHandler({ prisma: store });
    const base = [
      { key: 'anna', name: 'Anna', role: 'main' as const },
      { key: 'boris', name: 'Boris', role: 'secondary' as const },
    ];
    const context = { chapters, dossier: null, glossary: null, entities: new Map() };
    const index = indexChapters(new Map(chapters.map((c) => [c.number, c.content])));
    // Отбор кандидатов - приватный шаг выбора: весь ход ради него поднимать дороже, чем сам отбор.
    const found = await (
      handler as unknown as {
        candidatesOf: (
          ...a: unknown[]
        ) => Promise<{ candidates: Array<{ key: string; role: string }> }>;
      }
    ).candidatesOf('v1', context, base, null, index);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledTimes(1);
    // Исключения форм читаются у всех кандидатов, второстепенных тоже (`F08-8a`, `F08-8b`).
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookVersionId: 'v1', key: { in: ['anna', 'boris'] } } }),
    );
    return found.candidates.map((c) => `${c.key}:${c.role}`);
  };
  const both = (n: number) => chapter(n, 'Anna and Boris');

  it('a secondary hero in exactly 3 chapters is a candidate with its role', async () => {
    expect(await run([1, 2, 3].map(both))).toEqual(['anna:main', 'boris:secondary']);
  });

  it('a secondary hero in 2 chapters is not a candidate', async () => {
    expect(await run([both(1), both(2), chapter(3, 'Anna')])).toEqual(['anna:main']);
  });

  it('the main hero stays a candidate in any number of chapters, even none', async () => {
    expect(await run([chapter(1, 'Boris')])).toEqual(['anna:main']);
  });

  it('excluded chapters of a form (F08-8a) take a secondary hero below the threshold', async () => {
    const stored = [
      {
        key: 'boris',
        aliasExclusions: [],
        aliasChapterExclusions: [{ form: 'Boris', chapters: [3] }],
      },
    ];
    expect(await run([1, 2, 3].map(both), stored)).toEqual(['anna:main']);
  });
});

/** Шаг пары без платного вызова (`F08-8e-1`, решения арбитра Q1, Q4; ревью круга 1). */
describe('WorldWriteHandler: pair step refusals before the paid call (F08-8e)', () => {
  const pair = { key: 'anna--boris', a: 'anna', b: 'boris', linked: false, chapters: [1] };
  const hero = (key: string, chapters: number[]) => ({
    key,
    role: 'main' as const,
    name: key,
    aliases: [],
    mentions: { chapters, perChapter: {} },
  });
  const character = { type: 'character' };
  const setup = (
    entities: Record<string, { type: string }>,
    saved: Array<{ key: string; mentions: unknown }>,
    recount: 'done' | 'retry' = 'done',
    relations: Array<{ key: string; relations: Array<{ to: string }> }> = [],
    options: { recounted?: boolean; chaptersB?: number[]; pair?: Partial<typeof pair> } = {},
  ) => {
    const store = { bookWorldEntity: { findMany: jest.fn().mockResolvedValue(saved) } };
    const mentions = { recountVersion: jest.fn().mockResolvedValue({ status: recount }) };
    const marks: unknown[] = [];
    const fields = {
      mutate: jest.fn((_row: unknown, _gate: unknown, fn: (d: unknown) => unknown) => {
        marks.push(fn(data));
        return Promise.resolve(marks.at(-1));
      }),
    };
    const handler = worldWriteHandler({ prisma: store, fields, mentions });
    const context = {
      entities: new Map(Object.entries(entities)),
      analysis: { characters: relations },
      chapters: [{ number: 1, title: 'C1', content: '<p>Anna and Boris.</p>' }],
      language: 'en',
    };
    const data = {
      ...emptyWorldData(),
      candidates: [hero('anna', [1]), hero('boris', options.chaptersB ?? [1])],
      pairs: [{ ...pair, ...options.pair }],
      mentionsRecounted: options.recounted ?? false,
    };
    const step = (pending: unknown = null) =>
      (
        handler as unknown as {
          pairStep: (
            ...a: unknown[]
          ) => Promise<{ step: { outcome: string; failedReason: string | null } } | null>;
        }
      ).pairStep(
        { id: 'd1', bookVersionId: 'v1' },
        { kind: 'run', operationId: 'op1' },
        5,
        0,
        context,
        data,
        pending,
        {},
        null,
      );
    return { step, store, mentions, marks };
  };
  const counted = (chapters: number[], coPresence: Record<string, number[]> = {}) => ({
    chapters,
    coPresence,
  });

  it('a character of the pair is not in the world as a character - WORLD_PAIR_MEMBER_MISSING, no recount, no call', async () => {
    const { step, mentions, store } = setup({ anna: character }, []);
    expect((await step())?.step).toMatchObject({
      outcome: 'failed',
      failedReason: 'WORLD_PAIR_MEMBER_MISSING',
    });
    expect(mentions.recountVersion).not.toHaveBeenCalled();
    expect(store.bookWorldEntity.findMany).not.toHaveBeenCalled();
  });

  it('the pair key belongs to an entity of another type - WORLD_PAIR_KEY_TAKEN, no recount, no read', async () => {
    const { step, mentions, store } = setup(
      { anna: character, boris: character, 'anna--boris': character },
      [],
    );
    expect((await step())?.step).toMatchObject({ failedReason: 'WORLD_PAIR_KEY_TAKEN' });
    expect(mentions.recountVersion).not.toHaveBeenCalled();
    expect(store.bookWorldEntity.findMany).not.toHaveBeenCalled();
  });

  it('a stored pair not linked in the analysis and without shared chapters - WORLD_PAIR_NOT_FOUNDED, no call (F08-8e-4 Q1)', async () => {
    const { step, mentions, store } = setup(
      { anna: character, boris: character, 'anna--boris': { type: 'pair' } },
      [],
      'done',
      [],
      { pair: { linked: false, chapters: [] } },
    );
    // Без `llm` платный путь упал бы TypeError: отказ - до вызова.
    expect((await step())?.step).toMatchObject({
      outcome: 'failed',
      failedReason: 'WORLD_PAIR_NOT_FOUNDED',
    });
    expect(mentions.recountVersion).not.toHaveBeenCalled();
    expect(store.bookWorldEntity.findMany).not.toHaveBeenCalled();
  });

  it('a new pair not linked and without shared chapters - WORLD_PAIR_NOT_FOUNDED before the recount and the read', async () => {
    const { step, mentions, store } = setup({ anna: character, boris: character }, [], 'done', [], {
      pair: { linked: false, chapters: [] },
    });
    expect((await step())?.step).toMatchObject({ failedReason: 'WORLD_PAIR_NOT_FOUNDED' });
    expect(mentions.recountVersion).not.toHaveBeenCalled();
    expect(store.bookWorldEntity.findMany).not.toHaveBeenCalled();
  });

  it('a new pair: the presence is recounted first; the recount moved - WORLD_MENTIONS_MOVED, not NOT_FOUNDED', async () => {
    const { step, mentions, store } = setup({ anna: character, boris: character }, [], 'retry');
    expect((await step())?.step).toMatchObject({ failedReason: 'WORLD_MENTIONS_MOVED' });
    expect(mentions.recountVersion).toHaveBeenCalledTimes(1);
    expect(store.bookWorldEntity.findMany).not.toHaveBeenCalled();
  });

  it('a new pair not founded by the saved presence - WORLD_PAIR_NOT_FOUNDED; the saved presence of both is read', async () => {
    const saved = [
      { key: 'anna', mentions: counted([1, 2, 3, 4], { boris: [1] }) },
      { key: 'boris', mentions: counted([1, 5, 6], { anna: [1] }) },
    ];
    const { step, mentions, store } = setup({ anna: character, boris: character }, saved);
    expect((await step())?.step).toMatchObject({ failedReason: 'WORLD_PAIR_NOT_FOUNDED' });
    expect(mentions.recountVersion).toHaveBeenCalledTimes(1);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledTimes(1);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', key: { in: ['anna', 'boris'] } },
      select: { key: true, mentions: true },
      take: 100,
    });
  });

  it('a pair already in the world is not founded again and needs no recount (R1)', async () => {
    const { step, mentions } = setup(
      { anna: character, boris: character, 'anna--boris': { type: 'pair' } },
      [],
    );
    // Проверки пройдены - дальше платный путь; без `llm` он падает на нём, а не на отказе.
    await expect(step()).rejects.toThrow(TypeError);
    expect(mentions.recountVersion).not.toHaveBeenCalled();
  });

  it('the paid text of this step is kept (pending): the refusals are not checked again', async () => {
    const { step, mentions } = setup({}, [], 'retry');
    await expect(step({ key: 'step:5', operationId: 'op1', resume: {} })).rejects.toThrow(
      TypeError,
    );
    expect(mentions.recountVersion).not.toHaveBeenCalled();
  });
});

describe('choosePairs: pairs of the run and what the choice left out (F08-8e)', () => {
  const candidate = (key: string, chapters: number[]) => ({
    key,
    role: 'main' as const,
    name: key.toUpperCase(),
    aliases: [],
    mentions: { chapters, perChapter: {} },
  });
  const chosen = {
    candidates: [candidate('anna', [1, 2]), candidate('boris', [1, 2])],
    leftOut: [{ key: 'vera', reason: 'BELOW_MIN_CHAPTERS' as const, names: ['Vera'], chapters: 2 }],
    coPresence: new Map<string, Record<string, number[]>>([
      ['anna', { boris: [1, 2] }],
      ['boris', { anna: [1, 2] }],
    ]),
  };
  const context = (language: string) =>
    ({
      language,
      entities: new Map(),
      analysis: {
        characters: [
          { key: 'anna', name: 'Anna', role: 'main' },
          { key: 'tom--old', name: 'Tom', role: 'secondary' },
        ],
      },
    }) as never;

  it('a language with a pair sample: the pair by common chapters; heroes with a pair-form key and below the threshold are left out', () => {
    const got = choosePairs(context('en'), chosen);
    expect(got.pairsOff).toBeNull();
    expect(got.pairs.map((p) => [p.key, p.chapters])).toEqual([['anna--boris', [1, 2]]]);
    expect(got.leftOut).toEqual([
      { key: 'tom--old', reason: 'KEY_PAIR_FORM', names: ['Tom'], chapters: null },
      { key: 'vera', reason: 'BELOW_MIN_CHAPTERS', names: ['Vera'], chapters: 2 },
    ]);
  });

  it('a candidate whose key holds "--" gets no pair: no pair key can be built, left out as PAIR_KEY_INVALID with the names', () => {
    const odd = candidate('old--hero', [1, 2]);
    const got = choosePairs(
      {
        ...(context('en') as object),
        entities: new Map([['old--hero', { type: 'character' }]]),
      } as never,
      {
        ...chosen,
        candidates: [candidate('anna', [1, 2]), odd],
        coPresence: new Map<string, Record<string, number[]>>([
          ['anna', { 'old--hero': [1, 2] }],
          ['old--hero', { anna: [1, 2] }],
        ]),
      },
    );
    // Ключ пары с таким героем не собрать (`--` в ключе героя): пары нет, отсеянная названа по именам.
    expect(got.pairs).toEqual([]);
    expect(got.leftOut.filter((l) => l.reason === 'PAIR_KEY_INVALID')).toEqual([
      {
        key: 'anna--old--hero',
        reason: 'PAIR_KEY_INVALID',
        names: ['ANNA', 'OLD--HERO'],
        chapters: 2,
      },
    ]);
  });

  it('a stored character with a pair-form key is not left out: the write takes it (Q7)', () => {
    const stored = {
      ...(context('en') as object),
      entities: new Map([['tom--old', { type: 'character' }]]),
    } as never;
    expect(choosePairs(stored, chosen).leftOut.map((l) => l.reason)).toEqual([
      'BELOW_MIN_CHAPTERS',
    ]);
  });

  it.each(['es', 'fr', 'pt'])(
    '%s has a pair sample: the pair by common chapters (F08-9)',
    (language) => {
      const got = choosePairs(context(language), chosen);
      expect(got.pairsOff).toBeNull();
      expect(got.pairs.map((p) => p.key)).toEqual(['anna--boris']);
    },
  );

  it('a language without a pair sample: no pairs, WORLD_PAIR_LANGUAGE; the heroes are still left out with their reason', () => {
    const got = choosePairs(context('de'), chosen);
    expect(got).toEqual({
      pairs: [],
      pairsOff: 'WORLD_PAIR_LANGUAGE',
      leftOut: [
        { key: 'tom--old', reason: 'KEY_PAIR_FORM', names: ['Tom'], chapters: null },
        { key: 'vera', reason: 'BELOW_MIN_CHAPTERS', names: ['Vera'], chapters: 2 },
      ],
    });
  });
});

describe('WorldWriteHandler.candidatesOf: left out and common chapters (F08-8e)', () => {
  it('a secondary hero below the threshold is left out with its chapters; common chapters are counted between candidates', async () => {
    const store = { bookWorldEntity: { findMany: jest.fn().mockResolvedValue([]) } };
    const handler = worldWriteHandler({ prisma: store });
    const chapters = [
      { number: 1, title: 'C1', content: '<p>Anna and Boris and Vera</p>' },
      { number: 2, title: 'C2', content: '<p>Anna and Boris</p>' },
      { number: 3, title: 'C3', content: '<p>Anna</p>' },
    ];
    const base = [
      { key: 'anna', name: 'Anna', role: 'main' as const },
      { key: 'boris', name: 'Boris', role: 'main' as const },
      { key: 'vera', name: 'Vera', role: 'secondary' as const },
    ];
    const context = { chapters, dossier: null, glossary: null, entities: new Map() };
    const index = indexChapters(new Map(chapters.map((c) => [c.number, c.content])));
    const got = await (
      handler as unknown as {
        candidatesOf: (...a: unknown[]) => Promise<{
          candidates: Array<{ key: string }>;
          leftOut: unknown[];
          coPresence: Map<string, Record<string, number[]>>;
        }>;
      }
    ).candidatesOf('v1', context, base, null, index);
    // Исключения форм - одним запросом по ключам выбора, только нужные поля, не больше сущностей версии.
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledTimes(1);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', key: { in: ['anna', 'boris', 'vera'] } },
      select: { key: true, aliasExclusions: true, aliasChapterExclusions: true },
      take: BOOK_WORLD_LIMITS.entities,
    });
    expect(got.candidates.map((c) => c.key)).toEqual(['anna', 'boris']);
    expect(got.leftOut).toEqual([
      { key: 'vera', reason: 'BELOW_MIN_CHAPTERS', names: ['Vera'], chapters: 1 },
    ]);
    expect(got.coPresence.get('anna')).toEqual({ boris: [1, 2], vera: [1] });
  });
});

describe('WorldWriteHandler: the presence recount before new pairs, until it succeeds once (F08-8e-1 Q1 note)', () => {
  const hero = (key: string, chapters: number[]) => ({
    key,
    role: 'main' as const,
    name: key,
    aliases: [],
    mentions: { chapters, perChapter: {} },
  });
  const pair = (a: string, b: string) => ({ key: `${a}--${b}`, a, b, linked: true, chapters: [1] });
  const run = (
    recounted: boolean,
    recount: 'done' | 'retry',
    at: number,
    chaptersB = [1],
    gone = false,
  ) => {
    const saved = [
      { key: 'anna', mentions: { chapters: [1], coPresence: { boris: [1] } } },
      { key: 'boris', mentions: { chapters: [1], coPresence: { anna: [1] } } },
    ];
    const store = { bookWorldEntity: { findMany: jest.fn().mockResolvedValue(saved) } };
    const mentions = { recountVersion: jest.fn().mockResolvedValue({ status: recount }) };
    const marks: Array<{ mentionsRecounted?: boolean }> = [];
    const data = {
      ...emptyWorldData(),
      candidates: [hero('anna', [1]), hero('boris', chaptersB), hero('carl', [1])],
      pairs: [pair('anna', 'boris'), pair('anna', 'carl')],
      mentionsRecounted: recounted,
    };
    const fields = {
      mutate: jest.fn((_r: unknown, _g: unknown, fn: (d: typeof data) => typeof data) => {
        if (gone) return Promise.resolve(null);
        marks.push(fn(data));
        return Promise.resolve(marks.at(-1));
      }),
    };
    const handler = worldWriteHandler({ prisma: store, fields, mentions });
    const character = { type: 'character' };
    const context = {
      entities: new Map([
        ['anna', character],
        ['boris', character],
        ['carl', character],
      ]),
      analysis: {
        characters: [{ key: 'anna', relations: [{ to: 'boris' }, { to: 'carl' }] }],
      },
      chapters: [{ number: 1, title: 'C1', content: '<p>Anna and Boris and Carl.</p>' }],
      language: 'en',
    };
    const step = (
      handler as unknown as {
        pairStep: (
          ...a: unknown[]
        ) => Promise<{ step: { outcome: string; failedReason: string | null } } | null>;
      }
    ).pairStep(
      { id: 'd1', bookVersionId: 'v1' },
      { kind: 'run', operationId: 'op1' },
      7 + at,
      at,
      context,
      data,
      null,
      {},
      null,
    );
    return { step, mentions, marks, store };
  };

  it('no successful recount yet and it moves: only this pair fails, the run is not marked', async () => {
    const { step, mentions, marks } = run(false, 'retry', 0);
    expect((await step)?.step).toMatchObject({ failedReason: 'WORLD_MENTIONS_MOVED' });
    expect(mentions.recountVersion).toHaveBeenCalledTimes(1);
    expect(marks).toEqual([]);
  });

  it('the next new pair recounts again; a successful recount marks the run (the linked pair then goes to the paid path)', async () => {
    const { step, mentions, marks } = run(false, 'done', 1);
    await expect(step).rejects.toThrow(TypeError);
    expect(mentions.recountVersion).toHaveBeenCalledTimes(1);
    expect(mentions.recountVersion).toHaveBeenCalledWith('v1');
    expect(marks.map((m) => m.mentionsRecounted)).toEqual([true]);
  });

  it('the run is gone while the presence recounts (the mark is not saved) - the step is dropped, no paid call', async () => {
    const { step, mentions, store } = run(false, 'done', 1, [1], true);
    await expect(step).resolves.toBeNull();
    expect(mentions.recountVersion).toHaveBeenCalledTimes(1);
    // Ход ушёл - сохранённое присутствие пары не читается (`RUN_GONE` до `savedMentionsOf`).
    expect(store.bookWorldEntity.findMany).not.toHaveBeenCalled();
  });

  it('after a successful recount a new pair does not recount', async () => {
    const { step, mentions } = run(true, 'retry', 1);
    await expect(step).rejects.toThrow(TypeError);
    expect(mentions.recountVersion).not.toHaveBeenCalled();
  });

  it('a character of the pair found in no chapter - WORLD_CHARACTER_NOT_FOUND, no recount, no call', async () => {
    const { step, mentions } = run(false, 'done', 0, []);
    expect((await step)?.step).toMatchObject({ failedReason: 'WORLD_CHARACTER_NOT_FOUND' });
    expect(mentions.recountVersion).not.toHaveBeenCalled();
  });
});

describe('WorldWriteHandler: the choice step of a run started before F08-8e (F08-8e-4 Q2)', () => {
  const candidate = (key: string) => ({
    key,
    role: 'main' as const,
    name: key.toUpperCase(),
    aliases: [],
    mentions: { chapters: [1, 2], perChapter: {} },
  });
  const chosen = {
    candidates: [candidate('anna'), candidate('boris')],
    leftOut: [],
    coPresence: new Map<string, Record<string, number[]>>([
      ['anna', { boris: [1, 2] }],
      ['boris', { anna: [1, 2] }],
    ]),
  };
  const context = {
    language: 'en',
    dossier: null,
    glossary: null,
    bookTitle: 'B',
    author: 'A',
    originalLanguage: '',
    entities: new Map(),
    chapters: [{ number: 1, title: 'C1', content: '<p>Anna and Boris.</p>' }],
    analysis: {
      characters: [
        { key: 'anna', name: 'Anna', role: 'main' },
        { key: 'boris', name: 'Boris', role: 'main' },
        // Новый герой с ключом вида пары: в ход не идёт, виден отсеянным (Q7) - у любого хода.
        { key: 'vera--new', name: 'Vera', role: 'main' },
      ],
    },
    names: { titles: ['B'], authors: ['A'] },
  };
  const veraLeftOut = {
    key: 'vera--new',
    reason: 'KEY_PAIR_FORM',
    names: ['Vera'],
    chapters: null,
  };
  // Текст не влез (`stageFit` - нет): шаг выбора без вызова, отбор пар идёт по кандидатам.
  const choose = async (data: unknown) => {
    const llm = { stageFit: jest.fn().mockResolvedValue({ fits: false }) };
    const handler = worldWriteHandler({ llm });
    const inner = handler as unknown as {
      candidatesOf: jest.Mock;
      produceStep: (...a: unknown[]) => Promise<{
        pairs?: Array<{ key: string }>;
        leftOut?: unknown[];
        pairsOff?: unknown;
      } | null>;
    };
    inner.candidatesOf = jest.fn().mockResolvedValue(chosen);
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

  it('a new run (pairs: null) gets its pairs at the choice', async () => {
    const record = await choose(worldDataJson(emptyWorldData()));
    expect(record?.pairs?.map((p) => p.key)).toEqual(['anna--boris']);
    expect(record?.leftOut).toEqual([veraLeftOut]);
    expect(record?.pairsOff).toBeNull();
  });

  it('a run without the pairs field gets no pairs: its estimate had none; the left-out heroes are still shown', async () => {
    const record = await choose({ candidates: null, steps: [] });
    expect(record?.pairs).toEqual([]);
    expect(record?.leftOut).toEqual([veraLeftOut]);
    expect(record?.pairsOff).toBeNull();
  });
});

describe('WorldWriteHandler: pair step branches after the checks (F08-8e-1 review, F08-8e-4)', () => {
  const hero = (key: string) => ({
    key,
    role: 'main' as const,
    name: key.toUpperCase(),
    aliases: [],
    mentions: { chapters: [1], perChapter: {} },
  });
  const character = { type: 'character' };
  const context = {
    language: 'en',
    dossier: null,
    glossary: null,
    bookTitle: 'B',
    author: 'A',
    originalLanguage: '',
    // Пара заведена: условие заведения не проверяется (R1), дальше - вход и вызов.
    entities: new Map([
      ['anna', character],
      ['boris', character],
      ['anna--boris', { type: 'pair' }],
    ]),
    chapters: [{ number: 1, title: 'C1', content: '<p>Anna and Boris.</p>' }],
    analysis: { characters: [] },
    names: { titles: ['B'], authors: ['A'] },
  };
  const data = {
    ...emptyWorldData(),
    candidates: [hero('anna'), hero('boris')],
    pairs: [{ key: 'anna--boris', a: 'anna', b: 'boris', linked: true, chapters: [1] }],
    mentionsRecounted: true,
  };
  const pairStep = (fits: boolean, loopResult: unknown) => {
    const llm = {
      stageFit: jest.fn().mockResolvedValue({ fits }),
      stageInputCeiling: jest.fn().mockResolvedValue({ maxInputChars: null }),
      getStageSetting: jest.fn().mockResolvedValue({}),
    };
    const handler = worldWriteHandler({ llm });
    const inner = handler as unknown as {
      loop: jest.Mock;
      pairStep: (
        ...a: unknown[]
      ) => Promise<{ step: { outcome: string; failedReason: string | null } } | null>;
    };
    inner.loop = jest.fn().mockResolvedValue(loopResult);
    const step = inner.pairStep(
      { id: 'd1', bookVersionId: 'v1' },
      { kind: 'run', operationId: 'op1' },
      5,
      0,
      context,
      data,
      null,
      {},
      null,
    );
    return { step, loop: inner.loop };
  };

  it('the text does not fit even with no chapters - DRAFT_TOO_LONG, no call', async () => {
    const { step, loop } = pairStep(false, null);
    expect((await step)?.step).toMatchObject({ outcome: 'failed', failedReason: 'DRAFT_TOO_LONG' });
    expect(loop).not.toHaveBeenCalled();
  });

  it('the quality loop gave no valid answer - DRAFT_INVALID_RESPONSE', async () => {
    const { step, loop } = pairStep(true, { ok: false });
    expect((await step)?.step).toMatchObject({
      outcome: 'failed',
      failedReason: 'DRAFT_INVALID_RESPONSE',
    });
    expect(loop).toHaveBeenCalledTimes(1);
  });

  it('the run stopped taking the step during the call - the step is dropped (null)', async () => {
    const { step } = pairStep(true, null);
    await expect(step).resolves.toBeNull();
  });
});

describe('a pair without shared chapters on the paid paths: both heroes are read, no refusal (F08-8e-4 Q1, Q1-bis)', () => {
  const pair = { key: 'anna--boris', a: 'anna', b: 'boris', linked: false, chapters: [] };
  const context = worldPairContext(
    new Map([
      ['anna', { type: 'character' }],
      ['boris', { type: 'character' }],
      ['anna--boris', { type: 'pair' }],
    ]),
  );
  const texts = (mock: jest.Mock) => JSON.stringify(mock.mock.calls as unknown[]);
  const run = async (
    pairPatch: Partial<typeof pair>,
    paths: { regen?: boolean; pending?: boolean } = {},
  ) => {
    const llm = {
      stageFit: jest.fn().mockResolvedValue({ fits: true }),
      stageInputCeiling: jest.fn().mockResolvedValue({ maxInputChars: null }),
      getStageSetting: jest.fn().mockResolvedValue({}),
    };
    const handler = worldWriteHandler({ llm });
    const inner = handler as unknown as {
      loop: jest.Mock;
      pairStep: (...a: unknown[]) => Promise<{ step: { failedReason: string | null } } | null>;
    };
    inner.loop = jest.fn().mockResolvedValue({ ok: false });
    const data = {
      ...emptyWorldData(),
      candidates: [worldHero('anna', [1]), worldHero('boris', [2])],
      pairs: [{ ...pair, ...pairPatch }],
      mentionsRecounted: true,
    };
    // Оплаченный текст шага 5 уже сохранён (обрыв после вызова) - `pending` этого шага.
    const pending = paths.pending ? { key: 'step:5', operationId: 'op1', resume: {} } : null;
    const regen = paths.regen
      ? { spec: { block: 'bonds', current: null, remark: null }, index: 0 }
      : null;
    const got = await inner.pairStep(
      { id: 'd1', bookVersionId: 'v1' },
      { kind: 'run', operationId: 'op1' },
      5,
      0,
      context,
      data,
      pending,
      {},
      regen,
    );
    return { got, loop: inner.loop, sent: texts(llm.stageFit) };
  };
  const readsBoth = (sent: string) => {
    expect(sent).toContain('Anna maps the road.');
    expect(sent).toContain('Boris rings the bell.');
  };

  it.each([
    ['regenerating a block', { regen: true }],
    ['the paid text of the step is kept (pending)', { pending: true }],
  ])(
    'not linked - %s: no refusal, the call gets the chapters of both heroes',
    async (_l, paths) => {
      const { got, loop, sent } = await run({}, paths);
      expect(got?.step.failedReason).toBe('DRAFT_INVALID_RESPONSE');
      expect(loop).toHaveBeenCalledTimes(1);
      readsBoth(sent);
    },
  );

  it('linked, the ordinary step: no refusal, the call gets the chapters of both heroes', async () => {
    const { got, loop, sent } = await run({ linked: true });
    expect(got?.step.failedReason).toBe('DRAFT_INVALID_RESPONSE');
    expect(loop).toHaveBeenCalledTimes(1);
    readsBoth(sent);
  });

  it('not linked, the ordinary step: WORLD_PAIR_NOT_FOUNDED, no call', async () => {
    const { got, loop } = await run({});
    expect(got?.step.failedReason).toBe('WORLD_PAIR_NOT_FOUNDED');
    expect(loop).not.toHaveBeenCalled();
  });
});

/**
 * Итог шага страницы героя и пары (`F08-8e-5`, общий `blockItems`): пункт на блок, блок с ошибкой
 * импорта - пункт `failed`/`IMPORT_INVALID` без значения и имени; формы имени - только у страницы
 * и не на перегенерации; имя пары без ответа модели - запасное.
 */
describe('pageRecord / pairRecord: the items of a written step (F08-8e-5)', () => {
  const importRemark: DraftRemark = {
    code: 'IMPORT_INVALID',
    where: 'faq.0.answer',
    note: 'The field faq.0.answer: too long.',
    by: 'code',
  };
  const loopDraft = <D>(draft: D, remarks: DraftRemark[], answered = true) => ({
    ok: true as const,
    draft,
    attempt: 1 as const,
    verdict: 'flags' as const,
    remarks,
    authorModel: 'author',
    review: answered
      ? { kind: 'answered' as const, model: 'reviewer' }
      : { kind: 'unavailable' as const },
    costUsd: new Prisma.Decimal(0),
  });
  const blocks = { short: 'Short text.', faq: [{ question: 'Q?', answer: 'A.' }] };
  const view = (items: ReturnType<typeof pageRecord>['items']) =>
    items.map((i) => ({
      key: i.key,
      block: i.block,
      step: i.step,
      verdict: i.verdict,
      outcome: i.outcome,
      value: i.value,
      name: i.name,
      failedReason: i.failedReason,
      remarks: i.remarks.map((r) => r.where),
    }));
  const anna = { ...worldHero('anna', [1]), aliases: ['Anna', 'Annushka'] };

  it('a page: the name forms first, a block of the version as is, a block refused by the import - failed without value', () => {
    const got = pageRecord(
      4,
      anna,
      loopDraft({ name: 'Anna K.', blocks, fixes: [], droppedQuotes: [] }, [importRemark]),
      'text',
      false,
    );
    expect(view(got.items)).toEqual([
      {
        key: 'anna',
        block: 'aliases',
        step: 4,
        verdict: 'ok',
        outcome: 'waiting',
        value: ['Anna', 'Annushka'],
        name: 'Anna K.',
        failedReason: null,
        remarks: [],
      },
      {
        key: 'anna',
        block: 'short',
        step: 4,
        verdict: 'ok',
        outcome: 'waiting',
        value: 'Short text.',
        name: 'Anna K.',
        failedReason: null,
        remarks: [],
      },
      {
        key: 'anna',
        block: 'faq',
        step: 4,
        verdict: 'failed',
        outcome: 'none',
        value: null,
        name: null,
        failedReason: 'IMPORT_INVALID',
        remarks: ['faq.0.answer'],
      },
    ]);
    expect(got.step).toMatchObject({ step: 4, kind: 'page', key: 'anna', outcome: 'done' });
  });

  it('a page regenerated: no name forms item; without the reviewer - flags; no name from the model - the hero name', () => {
    const got = pageRecord(
      4,
      anna,
      loopDraft(
        { name: null, blocks: { short: 'Short text.' }, fixes: [], droppedQuotes: [] },
        [],
        false,
      ),
      'text',
      true,
    );
    expect(view(got.items)).toEqual([
      {
        key: 'anna',
        block: 'short',
        step: 4,
        verdict: 'flags',
        outcome: 'waiting',
        value: 'Short text.',
        name: 'ANNA',
        failedReason: null,
        remarks: [],
      },
    ]);
  });

  it('a pair: items under the pair key, the fallback name, a block refused by the import - failed without value', () => {
    const pair = { key: 'anna--boris', a: 'anna', b: 'boris', linked: true, chapters: [1] };
    const members = { a: worldHero('anna', [1]), b: worldHero('boris', [2]) };
    const got = pairRecord(
      6,
      'en',
      pair,
      members,
      loopDraft({ name: null, blocks, fixes: [], droppedQuotes: [] }, [importRemark]),
      'text',
    );
    expect(view(got.items)).toEqual([
      {
        key: 'anna--boris',
        block: 'short',
        step: 6,
        verdict: 'ok',
        outcome: 'waiting',
        value: 'Short text.',
        name: 'ANNA and BORIS',
        failedReason: null,
        remarks: [],
      },
      {
        key: 'anna--boris',
        block: 'faq',
        step: 6,
        verdict: 'failed',
        outcome: 'none',
        value: null,
        name: null,
        failedReason: 'IMPORT_INVALID',
        remarks: ['faq.0.answer'],
      },
    ]);
    expect(got.step).toMatchObject({ step: 6, kind: 'pair', key: 'anna--boris', outcome: 'done' });
  });
});
