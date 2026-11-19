import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import { droppedOfBlock, WorldWriteHandler } from './world-write.handler';
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
      ...([{}, {}, {}, {}, {}, {}] as unknown as [never, never, never, never, never, never]),
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
        candidatesOf: (...a: unknown[]) => Promise<Array<{ key: string; role: string }>>;
      }
    ).candidatesOf('v1', context, base, null, index);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledTimes(1);
    return found.map((c) => `${c.key}:${c.role}`);
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
