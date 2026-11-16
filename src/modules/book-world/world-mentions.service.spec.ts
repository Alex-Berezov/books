import { createHash } from 'crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { WORLD_MENTIONS_CHAPTERS_BATCH } from './world-mentions-count';
import { fingerprintOfChapters, worldItemKey } from './world-quote-check';
import { WORLD_MENTIONS_PASS_LIMIT, WorldMentionsService } from './world-mentions.service';

/**
 * F08-2: пересчёт присутствия версии на подменённой базе (решения арбитра `F08 | F08-2` Q1–Q2).
 * Полный путь с базой — `test/book-world.e2e-spec.ts`.
 */
type Row = Record<string, unknown>;
const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const EDITED = new Date('2026-11-01T10:00:00Z');

const quote = (chapter: number, text: string) => ({ text, chapter, interpretation: 'Why' });
const scene = (chapter: number) => ({ chapter, title: 'T', text: 'S' });

/** Герой с полным ядром, кроме присутствия: его даёт подсчёт по главам. */
const hero = (over: Row = {}): Row => ({
  key: 'olga',
  type: 'character',
  name: 'Ольга',
  role: 'main',
  short: 'Who she is.',
  aliases: null,
  aliasExclusions: null,
  blocks: {
    character: 'Kind.',
    arc: { from: 'A', to: 'B' },
    quotes: [quote(1, 'Ольга пришла'), quote(1, 'Ольга ушла'), quote(2, 'Ольга спит')],
    scenes: [scene(1), scene(2)],
  },
  sources: null,
  mentions: null,
  mentionsAt: null,
  hasCore: false,
  coreMissing: ['mentions'],
  isListed: false,
  isVisible: true,
  isIndexable: true,
  readAt: null,
  autoTextAt: null,
  firstPublishedAt: null,
  createdAt: EDITED,
  updatedAt: EDITED,
  ...over,
});

function setup(opts: { rows: Row[]; chapters: Record<number, string> }) {
  const chapters = { ...opts.chapters };
  let rows = opts.rows;
  const update = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  /** Очередь: осевшие строки (`dueWorldMentions`) — задаёт кейс. */
  let due: { bookVersionId: string; generation: number }[] = [];
  const queryRaw = jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('"WorldMentionsPending"')) return Promise.resolve(due);
    const numbers = Object.keys(chapters)
      .map(Number)
      .sort((a, b) => a - b);
    if (sql.includes('string_agg')) {
      return Promise.resolve([
        {
          fingerprint: fingerprintOfChapters(
            numbers.map((n) => ({ number: n, digest: md5(chapters[n]) })),
          ),
        },
      ]);
    }
    if (sql.includes('ORDER BY')) {
      const [, after, limit] = values as [string, number, number];
      return Promise.resolve(
        numbers
          .filter((n) => n > after)
          .slice(0, limit)
          .map((n) => ({ number: n, content: chapters[n], digest: md5(chapters[n]) })),
      );
    }
    if (sql.includes('md5')) {
      return Promise.resolve(numbers.map((n) => ({ number: n, digest: md5(chapters[n]) })));
    }
    return Promise.resolve([]);
  });
  let between: () => void = () => {};
  const prisma = {
    bookVersion: { findUnique: jest.fn().mockResolvedValue({ status: 'published' }) },
    bookWorldEntity: { findMany: jest.fn(() => Promise.resolve(rows)), update },
    worldMentionsPending: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: queryRaw,
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      between();
      return fn(prisma);
    }),
  };
  const service = new WorldMentionsService(prisma as unknown as PrismaService);
  return {
    service,
    prisma,
    update,
    chapters,
    setRows: (next: Row[]) => (rows = next),
    setDue: (next: { bookVersionId: string; generation: number }[]) => (due = next),
    onTransaction: (fn: () => void) => (between = fn),
  };
}

const TEXT = {
  1: '<p>Ольга пришла. Ольга ушла.</p>',
  2: '<p>Ольга спит.</p>',
  3: '<p>Никого.</p>',
};

describe('WorldMentionsService.recountVersion (F08-2)', () => {
  it('пишет присутствие, ядро и isListed с прежним updatedAt; autoTextAt и readAt не трогает', async () => {
    const { service, update } = setup({ rows: [hero()], chapters: TEXT });
    await expect(service.recountVersion('v1')).resolves.toEqual({ status: 'done', written: 1 });
    const data = update.mock.calls[0][0].data;
    expect(data.mentions).toMatchObject({
      chapters: [1, 2],
      first: 1,
      perChapter: { '1': 2, '2': 1 },
      stale: [],
    });
    expect(data.hasCore).toBe(true);
    expect(data.isListed).toBe(true);
    expect(data.firstPublishedAt).toBeInstanceOf(Date);
    expect(data.updatedAt).toBe(EDITED);
    expect(data.mentionsAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('autoTextAt');
    expect(data).not.toHaveProperty('readAt');
  });

  it('ничего не изменилось — запись не идёт', async () => {
    const first = setup({ rows: [hero()], chapters: TEXT });
    await first.service.recountVersion('v1');
    const written = first.update.mock.calls[0][0].data;
    const { service, update } = setup({
      rows: [hero({ ...written, updatedAt: EDITED })],
      chapters: TEXT,
    });
    await expect(service.recountVersion('v1')).resolves.toEqual({ status: 'done', written: 0 });
    expect(update).not.toHaveBeenCalled();
  });

  it('те же mentions, но колонка числа глав пуста — пишется только она, mentionsAt не двигается', async () => {
    const first = setup({ rows: [hero()], chapters: TEXT });
    await first.service.recountVersion('v1');
    const written = first.update.mock.calls[0][0].data;
    const { service, update } = setup({
      rows: [hero({ ...written, mentionChapters: null, updatedAt: EDITED })],
      chapters: TEXT,
    });
    await expect(service.recountVersion('v1')).resolves.toEqual({ status: 'done', written: 1 });
    const data = update.mock.calls[0][0].data;
    expect(data.mentionChapters).toBe(2);
    expect(data).not.toHaveProperty('mentions');
    expect(data).not.toHaveProperty('mentionsAt');
  });

  it('герой исчез из всех глав — ядро падает, isListed снимается', async () => {
    const { service, update } = setup({
      rows: [
        hero({
          mentions: { chapters: [1], first: 1 },
          hasCore: true,
          coreMissing: [],
          isListed: true,
        }),
      ],
      chapters: { 1: '<p>Никого.</p>', 2: '<p>Тоже.</p>' },
    });
    await service.recountVersion('v1');
    const data = update.mock.calls[0][0].data;
    expect(data.mentions).toMatchObject({ chapters: [], first: null });
    expect(data.hasCore).toBe(false);
    expect(data.coreMissing).toContain('mentions');
    expect(data.isListed).toBe(false);
  });

  it('цитата больше не стоит дословно и сцена из удалённой главы — в stale, ядро падает (Q2)', async () => {
    const { service, update } = setup({
      rows: [hero()],
      chapters: { 1: '<p>Ольга пришла. Ольга вернулась.</p>' },
    });
    await service.recountVersion('v1');
    const data = update.mock.calls[0][0].data;
    // Ключи по содержанию (S1): цитата гл.1 не дословна, цитата и сцена гл.2 — главы нет.
    expect((data.mentions as { stale: string[] }).stale).toEqual(
      [
        worldItemKey('quotes', quote(1, 'Ольга ушла')),
        worldItemKey('quotes', quote(2, 'Ольга спит')),
        worldItemKey('scenes', scene(2)),
      ].sort(),
    );
    expect(data.hasCore).toBe(false);
    expect(data.isListed).toBe(false);
  });

  it('глава изменилась во время подсчёта — retry, ничего не пишется', async () => {
    const { service, update, chapters, onTransaction } = setup({ rows: [hero()], chapters: TEXT });
    onTransaction(() => {
      chapters[2] = '<p>Иван.</p>';
    });
    await expect(service.recountVersion('v1')).resolves.toEqual({ status: 'retry' });
    expect(update).not.toHaveBeenCalled();
  });

  it('сущность записана во время подсчёта — retry', async () => {
    const { service, update, setRows, onTransaction } = setup({ rows: [hero()], chapters: TEXT });
    onTransaction(() => setRows([hero({ updatedAt: new Date('2026-11-02T00:00:00Z') })]));
    await expect(service.recountVersion('v1')).resolves.toEqual({ status: 'retry' });
    expect(update).not.toHaveBeenCalled();
  });

  it('coPresence — только у героев и только непустые пересечения (Q3)', async () => {
    const ivan = hero({ key: 'ivan', name: 'Иван', blocks: null });
    const town = hero({ key: 'town', type: 'place', name: 'Город', blocks: null });
    const { service, update } = setup({
      rows: [hero(), ivan, town],
      chapters: { 1: '<p>Ольга пришла. Ольга ушла. Город.</p>', 2: '<p>Иван и Ольга спит.</p>' },
    });
    await service.recountVersion('v1');
    const byKey = new Map(
      update.mock.calls.map(([args]) => [
        (args as unknown as { where: { bookVersionId_key: { key: string } } }).where
          .bookVersionId_key.key,
        args.data.mentions as { coPresence: Record<string, number[]> },
      ]),
    );
    expect(byKey.get('olga')!.coPresence).toEqual({ ivan: [2] });
    expect(byKey.get('ivan')!.coPresence).toEqual({ olga: [2] });
    expect(byKey.get('town')!.coPresence).toEqual({});
  });
});

describe('WorldMentionsService.recountVersion: края (F08-2)', () => {
  it('версия без сущностей — done без подсчёта и транзакции', async () => {
    const { service, prisma } = setup({ rows: [], chapters: TEXT });
    await expect(service.recountVersion('v1')).resolves.toEqual({ status: 'done', written: 0 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('версию удалили до транзакции — done, ничего не пишется', async () => {
    const { service, prisma, update } = setup({ rows: [hero()], chapters: TEXT });
    prisma.bookVersion.findUnique.mockResolvedValue(null);
    await expect(service.recountVersion('v1')).resolves.toEqual({ status: 'done', written: 0 });
    expect(update).not.toHaveBeenCalled();
  });

  it('сущность добавили во время подсчёта — retry', async () => {
    const { service, update, setRows, onTransaction } = setup({ rows: [hero()], chapters: TEXT });
    onTransaction(() => setRows([hero(), hero({ key: 'ivan', name: 'Иван' })]));
    await expect(service.recountVersion('v1')).resolves.toEqual({ status: 'retry' });
    expect(update).not.toHaveBeenCalled();
  });

  it(`главы читаются порциями по ${WORLD_MENTIONS_CHAPTERS_BATCH}: глава на стыке порций не теряется`, async () => {
    const count = WORLD_MENTIONS_CHAPTERS_BATCH * 2 + 1;
    const chapters: Record<number, string> = {};
    for (let n = 1; n <= count; n++) chapters[n] = '<p>Никого.</p>';
    for (const n of [WORLD_MENTIONS_CHAPTERS_BATCH, WORLD_MENTIONS_CHAPTERS_BATCH + 1, count]) {
      chapters[n] = '<p>Ольга.</p>';
    }
    const { service, update, prisma } = setup({ rows: [hero({ blocks: null })], chapters });
    await service.recountVersion('v1');
    expect(update.mock.calls[0][0].data.mentions).toMatchObject({
      chapters: [WORLD_MENTIONS_CHAPTERS_BATCH, WORLD_MENTIONS_CHAPTERS_BATCH + 1, count],
    });
    const pages = (prisma.$queryRaw.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][])
      .filter(([strings]) => strings.join('?').includes('ORDER BY'))
      .map((call): unknown => call[2]);
    expect(pages).toEqual([-1, WORLD_MENTIONS_CHAPTERS_BATCH, WORLD_MENTIONS_CHAPTERS_BATCH * 2]);
  });
});

describe('WorldMentionsService.recountPending (F08-2)', () => {
  const taken = { bookVersionId: 'v1', generation: 3 };
  /** Отложенные строки (`deferWorldMentions`): версия и generation из параметров запроса. */
  const deferred = (executeRaw: jest.Mock) =>
    (executeRaw.mock.calls as [TemplateStringsArray, ...unknown[]][])
      .filter(([strings]) => strings.join('?').includes('"attempts" = "attempts" + 1'))
      .map((call) => call.slice(-2));
  /** Перепоставка без роста попыток (R3a): `dirtyAt` от часов базы, `attempts` не трогается. */
  const requeued = (executeRaw: jest.Mock) =>
    (executeRaw.mock.calls as [TemplateStringsArray, ...unknown[]][])
      .filter(([strings]) => {
        const sql = strings.join('?');
        return sql.includes('UPDATE "WorldMentionsPending"') && !sql.includes('"attempts"');
      })
      .map((call) => call.slice(-2));
  const dueCall = (queryRaw: jest.Mock) =>
    (queryRaw.mock.calls as [TemplateStringsArray, ...unknown[]][]).filter(([strings]) =>
      strings.join('?').includes('"WorldMentionsPending"'),
    );

  it('берёт осевшие версии часами базы, не больше прохода; снимает строку с взятым generation', async () => {
    const { service, prisma, setDue } = setup({ rows: [hero()], chapters: TEXT });
    setDue([taken]);
    await service.recountPending(10_000);
    const calls = dueCall(prisma.$queryRaw as jest.Mock);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(1)).toEqual([10_000, WORLD_MENTIONS_PASS_LIMIT]);
    expect(calls[0][0].join('?')).toContain('clock_timestamp()');
    expect(prisma.worldMentionsPending.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.worldMentionsPending.deleteMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', generation: 3 },
    });
    expect(deferred(prisma.$executeRaw as jest.Mock)).toEqual([]);
  });

  it('сдвиг текста во время подсчёта: строка не снимается, перепоставлена без роста попыток (R3a)', async () => {
    const { service, prisma, chapters, onTransaction, setDue } = setup({
      rows: [hero()],
      chapters: TEXT,
    });
    setDue([taken]);
    onTransaction(() => {
      chapters[3] = '<p>Ольга.</p>';
    });
    await service.recountPending(10_000);
    expect(prisma.worldMentionsPending.deleteMany).not.toHaveBeenCalled();
    expect(requeued(prisma.$executeRaw as jest.Mock)).toEqual([['v1', 3]]);
    expect(deferred(prisma.$executeRaw as jest.Mock)).toEqual([]);
  });

  it('сдвиг сущности во время подсчёта (правка без постановки, S2) — тоже перепоставка без роста (R3a)', async () => {
    const { service, prisma, setRows, onTransaction, setDue } = setup({
      rows: [hero()],
      chapters: TEXT,
    });
    setDue([taken]);
    onTransaction(() => setRows([hero({ updatedAt: new Date(EDITED.getTime() + 1000) })]));
    await service.recountPending(10_000);
    expect(requeued(prisma.$executeRaw as jest.Mock)).toEqual([['v1', 3]]);
    expect(deferred(prisma.$executeRaw as jest.Mock)).toEqual([]);
  });

  it('ошибка одной версии не обрывает проход: следующая пересчитывается, упавшая откладывается', async () => {
    const { service, prisma, setDue } = setup({ rows: [hero()], chapters: TEXT });
    setDue([taken, { bookVersionId: 'v2', generation: 0 }]);
    prisma.bookWorldEntity.findMany.mockImplementationOnce(() =>
      Promise.reject(new Error('broken row')),
    );
    await service.recountPending(10_000);
    expect(deferred(prisma.$executeRaw as jest.Mock)).toEqual([['v1', 3]]);
    expect(requeued(prisma.$executeRaw as jest.Mock)).toEqual([]);
    expect(prisma.worldMentionsPending.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.worldMentionsPending.deleteMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v2', generation: 0 },
    });
  });

  it('пересчёт читает сущности своей версии', async () => {
    const { service, prisma, setDue } = setup({ rows: [hero()], chapters: TEXT });
    setDue([taken]);
    await service.recountPending(10_000);
    // Два чтения: до подсчёта и под замком — оба своей версии (L-005).
    expect(prisma.bookWorldEntity.findMany).toHaveBeenCalledTimes(2);
    for (const [args] of prisma.bookWorldEntity.findMany.mock.calls as unknown as [
      { where: unknown },
    ][]) {
      expect(args.where).toEqual({ bookVersionId: 'v1' });
    }
    const chapterReads = (prisma.$queryRaw.mock.calls as [TemplateStringsArray, ...unknown[]][])
      .filter(([strings]) => strings.join('?').includes('"Chapter"'))
      .map((call) => call[1]);
    expect(new Set(chapterReads)).toEqual(new Set(['v1']));
  });
});
