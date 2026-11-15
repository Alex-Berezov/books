import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import type { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { BookWorldService, WORLD_QUOTE_CHAPTERS_BATCH } from './book-world.service';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import type { UpdateBookWorldDto } from './dto/update-book-world.dto';

/**
 * F08-1: ветки проверки импорта (`plan`) на подменённой базе. Полный путь с базой —
 * `test/book-world.e2e-spec.ts`; здесь только то, что e2e различает дорого: порции глав и правка
 * главы между проверкой до транзакции и записью под замком.
 */
type Row = Record<string, unknown>;

const savedRow = (key: string, over: Row = {}): Row => ({
  key,
  type: 'character',
  name: 'Saved',
  role: 'main',
  short: null,
  aliases: null,
  blocks: null,
  sources: null,
  mentions: null,
  hasCore: false,
  isIndexable: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  isListed: false,
  isVisible: true,
  readAt: null,
  autoTextAt: null,
  firstPublishedAt: null,
  coreMissing: [],
  ...over,
});

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

function setup(opts: { saved?: Row[]; chapters?: Record<number, string> } = {}) {
  const saved = opts.saved ?? [];
  const chapters: Record<number, string> = { ...(opts.chapters ?? {}) };
  const chapterFindMany = jest.fn((args: { where: { number: { in: number[] } } }) =>
    Promise.resolve(args.where.number.in.filter((n) => n in chapters).map((n) => ({ number: n }))),
  );
  /** Сырые запросы: тексты глав с отпечатком, отпечатки под замком, замки. */
  const queryRaw = jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (!sql.includes('md5')) return Promise.resolve([]);
    const numbers = (values.find(Array.isArray) as number[]).filter((n) => n in chapters);
    const withContent = sql.includes('"content",');
    return Promise.resolve(
      numbers.map((n) => ({
        number: n,
        digest: md5(chapters[n]),
        ...(withContent ? { content: chapters[n] } : {}),
      })),
    );
  });
  const textCalls = () =>
    queryRaw.mock.calls.filter(([strings]) => strings.join('?').includes('"content",'));
  let between: () => void = () => {};
  const prisma = {
    bookVersion: {
      findUnique: jest.fn().mockResolvedValue({ language: 'en', status: 'published' }),
    },
    bookAnalysis: { findUnique: jest.fn().mockResolvedValue(null) },
    bookWorldEntity: {
      findMany: jest.fn((args: { where: { key?: { in: string[] } } }) =>
        Promise.resolve(
          args.where.key
            ? saved.filter((r) => args.where.key!.in.includes(r.key as string))
            : saved.map((r) => ({ key: r.key })),
        ),
      ),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(saved.length),
      create: jest.fn((args: { data: Row }) => Promise.resolve(savedRow('x', args.data))),
    },
    chapter: { findMany: chapterFindMany },
    $queryRaw: queryRaw,
    // Между проверкой до транзакции и транзакцией — `between` (правка главы чужим писателем).
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      between();
      return fn(prisma);
    }),
  };
  const service = new BookWorldService(
    prisma as unknown as PrismaService,
    { isModerator: jest.fn() } as unknown as ModeratorRolesService,
  );
  const save = (entities: Row[], dryRun = true) =>
    service.saveVersion(
      'v1',
      { language: 'en', entities } as unknown as UpdateBookWorldDto,
      dryRun,
    );
  const messages = async (entities: Row[], dryRun = true) => {
    try {
      await save(entities, dryRun);
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return (e as BadRequestException).getResponse() as { message: string[] };
    }
    throw new Error('expected 400');
  };
  const onTransaction = (fn: () => void) => {
    between = fn;
  };
  return { prisma, chapters, textCalls, save, messages, onTransaction };
}

const hero = (key: string, over: Row = {}): Row => ({
  key,
  type: 'character',
  name: 'Hero',
  ...over,
});

describe('BookWorldService.plan (F08-1)', () => {
  it('неизвестная ссылка — 400 с путём сущности тела', async () => {
    const { messages } = setup();
    const res = await messages([hero('a', { relations: [{ to: 'ghost', label: 'x' }] })]);
    expect(res.message).toEqual([
      'entities.0.relations.0.to: unknown entity or character key "ghost"',
    ]);
  });

  it('глава не из версии — 400 с путём; текст главы не читается', async () => {
    const { messages, textCalls } = setup({ chapters: { 1: '<p>A</p>' } });
    const res = await messages([hero('a', { scenes: [{ chapter: 7, title: 't', text: 's' }] })]);
    expect(res.message).toEqual(['entities.0.scenes.0.chapter: chapter 7 is not in this version']);
    expect(textCalls()).toEqual([]);
  });

  it(`предел ${BOOK_WORLD_LIMITS.entities} сущностей на слитом наборе версии`, async () => {
    const saved = Array.from({ length: BOOK_WORLD_LIMITS.entities }, (_, i) => savedRow(`s${i}`));
    const { messages, save } = setup({ saved });
    const res = await messages([hero('extra')]);
    expect(res.message).toEqual([
      `entities: the version would hold ${BOOK_WORLD_LIMITS.entities + 1} entities, at most ${BOOK_WORLD_LIMITS.entities}`,
    ]);
    // Правка уже сохранённой сущности предел не трогает.
    await expect(save([hero('s0')])).resolves.toMatchObject({ world: null });
  });

  it('имя: у сохранённой сущности очистка — «cannot be cleared», у новой — «required»', async () => {
    const { messages } = setup({ saved: [savedRow('a')] });
    const res = await messages([
      { key: 'a', type: 'character', name: null },
      { key: 'b', type: 'character' },
    ]);
    expect(res.message).toEqual([
      'entities.0.name: name cannot be cleared',
      'entities.1.name: name is required for a new entity',
    ]);
  });

  it(`тексты глав для цитат читаются порциями по ${WORLD_QUOTE_CHAPTERS_BATCH}`, async () => {
    const count = WORLD_QUOTE_CHAPTERS_BATCH * 2 + 1;
    const chapters = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [i + 1, `<p>Line ${i + 1}.</p>`]),
    );
    const entities = Array.from({ length: Math.ceil(count / BOOK_WORLD_LIMITS.quotes) }, (_, e) =>
      hero(`h${e}`, {
        quotes: Array.from({ length: BOOK_WORLD_LIMITS.quotes }, (_, j) => e * 12 + j + 1)
          .filter((n) => n <= count)
          .map((n) => ({ text: `Line ${n}.`, chapter: n, interpretation: 'i' })),
      }),
    );
    const { save, textCalls } = setup({ chapters });
    await save(entities);
    expect(
      textCalls().map((call) => (call.slice(1).find(Array.isArray) as number[]).length),
    ).toEqual([WORLD_QUOTE_CHAPTERS_BATCH, WORLD_QUOTE_CHAPTERS_BATCH, 1]);
  });

  const quoted = () =>
    hero('a', { quotes: [{ text: 'He lay on the sofa.', chapter: 1, interpretation: 'i' }] });

  it('глава изменена между проверкой и записью — под замком цитата сверяется заново: 400 с путём', async () => {
    const { messages, onTransaction, chapters, prisma } = setup({
      chapters: { 1: '<p>He lay on the sofa.</p>' },
    });
    onTransaction(() => {
      chapters[1] = '<p>He stood up.</p>';
    });
    const res = await messages([quoted()], false);
    expect(res.message).toEqual([
      'entities.0.quotes.0.text: the quote is not found verbatim in chapter 1',
    ]);
    expect(prisma.bookWorldEntity.create).not.toHaveBeenCalled();
  });

  it('глава удалена между проверкой и записью — 400 с путём', async () => {
    const { messages, onTransaction, chapters } = setup({
      chapters: { 1: '<p>He lay on the sofa.</p>' },
    });
    onTransaction(() => {
      delete chapters[1];
    });
    const res = await messages([quoted()], false);
    expect(res.message).toEqual(['entities.0.quotes.0.chapter: chapter 1 is not in this version']);
  });

  it('глава не менялась — текст под замком не перечитывается, запись идёт', async () => {
    const { save, textCalls, prisma } = setup({ chapters: { 1: '<p>He lay on the sofa.</p>' } });
    await save([quoted()], false);
    expect(textCalls()).toHaveLength(1);
    expect(prisma.bookWorldEntity.create).toHaveBeenCalledTimes(1);
  });
});
