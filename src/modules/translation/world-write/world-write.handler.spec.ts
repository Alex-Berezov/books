import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import { droppedOfBlock, WorldWriteHandler } from './world-write.handler';
import { choosePairs } from './world-write.pairs';
import { indexChapters } from '../draft-quality/quote-check';
import { emptyWorldData, worldDataJson } from './world-write.data';

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
    const handler = new WorldWriteHandler(
      {} as PrismaService,
      ...([{}, {}, {}, {}, {}, {}, {}] as unknown as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
    );
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
    const handler = new WorldWriteHandler(
      db as unknown as PrismaService,
      {} as never,
      tasks as never,
      {} as never,
      {} as never,
      fields as never,
      {} as never,
      {} as never,
    );
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
    const handler = new WorldWriteHandler(
      store as unknown as PrismaService,
      {} as never,
      tasks as never,
      {} as never,
      {} as never,
      fields as never,
      {} as never,
      {} as never,
    );
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
    const handler = new WorldWriteHandler(
      store as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
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
    options: { recounted?: boolean; chaptersB?: number[] } = {},
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
    const handler = new WorldWriteHandler(
      store as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      fields as never,
      {} as never,
      mentions as never,
    );
    const context = {
      entities: new Map(Object.entries(entities)),
      analysis: { characters: relations },
      chapters: [{ number: 1, title: 'C1', content: '<p>Anna and Boris.</p>' }],
      language: 'en',
    };
    const data = {
      ...emptyWorldData(),
      candidates: [hero('anna', [1]), hero('boris', options.chaptersB ?? [1])],
      pairs: [pair],
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

  it('the pair key belongs to an entity of another type - WORLD_PAIR_KEY_TAKEN', async () => {
    const { step } = setup({ anna: character, boris: character, 'anna--boris': character }, []);
    expect((await step())?.step).toMatchObject({ failedReason: 'WORLD_PAIR_KEY_TAKEN' });
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

  it('a language without a pair sample: no pairs, WORLD_PAIR_LANGUAGE; the heroes are still left out with their reason', () => {
    const got = choosePairs(context('es'), chosen);
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
    const handler = new WorldWriteHandler(
      store as unknown as PrismaService,
      ...([{}, {}, {}, {}, {}, {}, {}] as unknown as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
    );
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
    const handler = new WorldWriteHandler(
      store as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      fields as never,
      {} as never,
      mentions as never,
    );
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
    return { step, mentions, marks };
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
    const { step, mentions } = run(false, 'done', 1, [1], true);
    await expect(step).resolves.toBeNull();
    expect(mentions.recountVersion).toHaveBeenCalledTimes(1);
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
