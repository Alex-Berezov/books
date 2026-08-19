import { BookService } from './book.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BookType, Language } from '@prisma/client';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { RelatedTaxonomyService } from '../seo/related-taxonomy/related-taxonomy.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';

/**
 * Пачка `B7`: сколько раз маршрут уходит в базу.
 *
 * 🔴 Спеки здесь считают **вызовы**, а не сверяют ответ: дефекты этой пачки
 * ответ не меняли вовсе — совпадал каждый байт, отличалось только число
 * запросов, и потому их не видели ни типы, ни линт, ни прежние тесты.
 * Поэтому у каждого ожидания стоит `toHaveBeenCalledTimes`: без счётчика
 * спека зелена и на коде с вернувшимся дефектом, где нужный вызов просто
 * стоит рядом с лишними.
 */

interface PrismaStub {
  book: { findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock };
  bookVersion: { findMany: jest.Mock; findFirst: jest.Mock; groupBy: jest.Mock };
  bookSummary: { findFirst: jest.Mock };
  seo: { findUnique: jest.Mock; findMany: jest.Mock };
  bookCategory: { findMany: jest.Mock };
  bookTag: { findMany: jest.Mock };
  bookRating: { aggregate: jest.Mock; groupBy: jest.Mock };
  authorTranslation: { findMany: jest.Mock };
  readingProgress: { findFirst: jest.Mock };
  chapter: { findMany: jest.Mock };
  $queryRaw: jest.Mock;
}

const createPrismaStub = (): PrismaStub => ({
  book: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
  bookVersion: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  bookSummary: { findFirst: jest.fn().mockResolvedValue(null) },
  seo: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  bookCategory: { findMany: jest.fn().mockResolvedValue([]) },
  bookTag: { findMany: jest.fn().mockResolvedValue([]) },
  bookRating: {
    aggregate: jest.fn().mockResolvedValue({ _avg: { score: 4 } }),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  authorTranslation: { findMany: jest.fn().mockResolvedValue([]) },
  readingProgress: { findFirst: jest.fn().mockResolvedValue(null) },
  chapter: { findMany: jest.fn().mockResolvedValue([]) },
  $queryRaw: jest.fn().mockResolvedValue([]),
});

/**
 * Текст запроса из тегированного шаблона: куски литерала плюс подставленные
 * фрагменты `Prisma.sql` (у них свои `strings`). Значения-параметры остаются
 * знаком вопроса — сверяются они отдельно, по массиву значений вызова.
 *
 * 🔴 Без этого условия фильтра не проверяет никто: в ветке `popular` они
 * собраны заново на сыром SQL, а прежние спеки фильтров зовут `findCards`
 * без `sort` и уходят в ветку по умолчанию.
 */
const renderSql = (call: unknown[]): string => {
  const [strings, ...values] = call as [string[], ...unknown[]];
  return strings
    .map((chunk, i) => {
      if (i >= values.length) return chunk;
      const value = values[i] as { strings?: string[] } | null;
      const rendered =
        value && typeof value === 'object' && Array.isArray(value.strings)
          ? value.strings.join('?')
          : '?';
      return chunk + rendered;
    })
    .join('');
};

const createService = (prisma: PrismaStub): BookService =>
  new BookService(
    prisma as unknown as PrismaService,
    { assertAccess: jest.fn() } as unknown as GeoBlockRuleService,
    new RelatedTaxonomyService(prisma as unknown as PrismaService),
    {
      record: jest.fn(),
      recordBaseSlugChange: jest.fn(),
      resolve: jest.fn().mockResolvedValue(null),
    } as unknown as SlugRedirectService,
    {
      isModerator: jest.fn().mockResolvedValue(false),
      isAdmin: jest.fn().mockResolvedValue(false),
    } as unknown as ModeratorRolesService,
  );

describe('LEGACY-124: findAll берёт рейтинги одним групповым запросом', () => {
  let prisma: PrismaStub;
  let service: BookService;

  const books = Array.from({ length: 20 }, (_, i) => ({
    id: `b${i}`,
    slug: `book-${i}`,
    versions: [
      {
        id: `v${i}`,
        status: 'published',
        type: BookType.text,
        _count: { chapters: 3, audioChapters: 0, summaries: 0 },
      },
    ],
  }));

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.book.findMany.mockResolvedValue(books);
    prisma.book.count.mockResolvedValue(books.length);
    service = createService(prisma);
  });

  it('на 20 книгах не зовёт bookRating.aggregate ни разу, а groupBy — ровно один', async () => {
    await service.findAll({ page: 1, limit: 20 });

    expect(prisma.bookRating.aggregate).toHaveBeenCalledTimes(0);
    expect(prisma.bookRating.groupBy).toHaveBeenCalledTimes(1);
  });

  it('групповой запрос спрашивает идентификаторы всех книг страницы', async () => {
    await service.findAll({ page: 1, limit: 20 });

    const [args] = prisma.bookRating.groupBy.mock.calls[0] as [
      { where: { bookId: { in: string[] } } },
    ];
    expect(args.where.bookId.in).toEqual(books.map((b) => b.id));
  });

  it('на пустой странице в базу за рейтингами не ходит вовсе', async () => {
    prisma.book.findMany.mockResolvedValue([]);
    prisma.book.count.mockResolvedValue(0);

    const res = await service.findAll({ page: 5, limit: 20 });

    expect(res.data).toEqual([]);
    expect(prisma.bookRating.groupBy).toHaveBeenCalledTimes(0);
    expect(prisma.bookRating.aggregate).toHaveBeenCalledTimes(0);
  });

  /**
   * Публичное значение `rating` менять нельзя (`LEGACY-124`, Rule): у книги без
   * оценок оно `null`, у оценённой — среднее без округления, ровно как отдавал
   * прежний `getAverageRating`.
   */
  it('rating: среднее у оценённой книги, null у книги без оценок', async () => {
    prisma.bookRating.groupBy.mockResolvedValue([
      { bookId: 'b0', _avg: { score: 4.5 }, _count: { score: 2 } },
    ]);

    const res = await service.findAll({ page: 1, limit: 20 });

    expect(res.data[0].rating).toBe(4.5);
    expect(res.data[1].rating).toBeNull();
  });
});

describe('LEGACY-126: getOverview собирает seo одной выборкой', () => {
  let prisma: PrismaStub;
  let service: BookService;

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'slug-1' });
    // Первый вызов — версии книги, второй — внутренние поля (`seoId`).
    prisma.bookVersion.findMany
      .mockResolvedValueOnce([
        {
          id: 'v-text',
          language: Language.en,
          type: BookType.text,
          isFree: true,
          slug: 'slug-1',
          _count: { chapters: 5, audioChapters: 0, summaries: 1 },
        },
        {
          id: 'v-audio',
          language: Language.en,
          type: BookType.audio,
          isFree: false,
          slug: 'slug-1',
          _count: { chapters: 0, audioChapters: 4, summaries: 1 },
        },
      ])
      .mockResolvedValueOnce([
        { id: 'v-text', seoId: 1, primaryCategoryId: null },
        { id: 'v-audio', seoId: 2, primaryCategoryId: null },
      ]);
    prisma.seo.findMany.mockResolvedValue([
      { id: 1, metaTitle: 'T-text', metaDescription: 'D-text' },
      { id: 2, metaTitle: 'T-audio', metaDescription: 'D-audio' },
    ]);
    service = createService(prisma);
  });

  it('на книге с текстовой и аудиоверсией в базу за seo уходит ровно один запрос', async () => {
    await service.getOverview('slug-1', Language.en);

    expect(prisma.seo.findUnique).toHaveBeenCalledTimes(0);
    expect(prisma.seo.findMany).toHaveBeenCalledTimes(1);
  });

  it('состав четырёх полей seo не изменился', async () => {
    const res = await service.getOverview('slug-1', Language.en);

    expect(res.seo.main).toEqual({ metaTitle: 'T-text', metaDescription: 'D-text' });
    expect(res.seo.read).toEqual({ metaTitle: 'T-text', metaDescription: 'D-text' });
    expect(res.seo.listen).toEqual({ metaTitle: 'T-audio', metaDescription: 'D-audio' });
    expect(res.seo.summary).toEqual({ metaTitle: 'T-text', metaDescription: 'D-text' });
  });

  it('за seo спрашиваются только идентификаторы нужных версий, узким select', async () => {
    await service.getOverview('slug-1', Language.en);

    const [args] = prisma.seo.findMany.mock.calls[0] as [
      { where: { id: { in: number[] } }; select: Record<string, boolean> },
    ];
    expect(args.where.id.in.sort()).toEqual([1, 2]);
    expect(Object.keys(args.select).sort()).toEqual(['id', 'metaDescription', 'metaTitle']);
  });
});

describe('LEGACY-126: реферальная книга не теряет seo.main', () => {
  let prisma: PrismaStub;
  let service: BookService;

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.book.findUnique.mockResolvedValue({ id: 'b2', slug: 'ref-1' });
    prisma.bookVersion.findMany
      .mockResolvedValueOnce([
        {
          id: 'v-ref',
          language: Language.en,
          type: BookType.referral,
          isFree: true,
          slug: 'ref-1',
          _count: { chapters: 0, audioChapters: 0, summaries: 0 },
        },
      ])
      .mockResolvedValueOnce([{ id: 'v-ref', seoId: 7, primaryCategoryId: null }]);
    prisma.seo.findMany.mockResolvedValue([
      { id: 7, metaTitle: 'T-ref', metaDescription: 'D-ref' },
    ]);
    service = createService(prisma);
  });

  /**
   * У реферальной книги нет ни текстовой, ни аудиоверсии, и `seo.main` берётся
   * из третьей ветки цепочки. Выпади её идентификатор из выборки — страница
   * уехала бы без title и description, а счётчик запросов остался бы верным.
   */
  it('seoId реферальной версии попадает в выборку, и seo.main заполнен', async () => {
    const res = await service.getOverview('ref-1', Language.en);

    const [args] = prisma.seo.findMany.mock.calls[0] as [{ where: { id: { in: number[] } } }];
    expect(args.where.id.in).toEqual([7]);
    expect(res.seo.main).toEqual({ metaTitle: 'T-ref', metaDescription: 'D-ref' });
    expect(res.seo.read).toBeNull();
    expect(res.seo.listen).toBeNull();
  });

  it('поля seo не делят один объект: правка одного не переписывает соседние', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b3', slug: 'slug-3' });
    prisma.bookVersion.findMany.mockReset();
    prisma.bookVersion.findMany
      .mockResolvedValueOnce([
        {
          id: 'v-text',
          language: Language.en,
          type: BookType.text,
          isFree: true,
          slug: 'slug-3',
          _count: { chapters: 2, audioChapters: 0, summaries: 1 },
        },
      ])
      .mockResolvedValueOnce([{ id: 'v-text', seoId: 7, primaryCategoryId: null }]);

    const res = await service.getOverview('slug-3', Language.en);

    expect(res.seo.main).toEqual(res.seo.read);
    expect(res.seo.main).not.toBe(res.seo.read);
  });
});

describe('LEGACY-127: читалка не тянет всю модель версии ради одного поля', () => {
  let prisma: PrismaStub;
  let service: BookService;

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'slug-1' });
    prisma.bookVersion.findMany
      .mockResolvedValueOnce([
        {
          id: 'v-text',
          language: Language.en,
          type: BookType.text,
          isFree: true,
          slug: 'slug-1',
          _count: { chapters: 5, audioChapters: 0, summaries: 0 },
        },
      ])
      .mockResolvedValueOnce([{ id: 'v-text', seoId: null, primaryCategoryId: null }]);
    // Прогресса по запрошенной версии нет — идёт запасной поиск по всем версиям.
    prisma.readingProgress.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ chapterNumber: 3, position: 120, bookVersion: { type: 'text' } });
    service = createService(prisma);
  });

  it('запасной поиск прогресса идёт с select и без include всей версии', async () => {
    await service.getReaderBootstrap('slug-1', Language.en, 'u1');

    expect(prisma.readingProgress.findFirst).toHaveBeenCalledTimes(2);
    const [fallbackArgs] = prisma.readingProgress.findFirst.mock.calls[1] as [
      { select?: Record<string, unknown>; include?: Record<string, unknown> },
    ];
    expect(fallbackArgs.include).toBeUndefined();
    expect(fallbackArgs.select).toBeDefined();
    expect(fallbackArgs.select).toEqual({
      chapterNumber: true,
      position: true,
      bookVersion: { select: { type: true } },
    });
  });

  it('прогресс из другой версии по-прежнему поднимается', async () => {
    const res = await service.getReaderBootstrap('slug-1', Language.en, 'u1');

    expect(res.lastProgress).toEqual({ chapterNumber: 3, position: 120 });
  });
});

describe('LEGACY-127: прогресс из аудиоверсии в читалку не поднимается', () => {
  let prisma: PrismaStub;
  let service: BookService;

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'slug-1' });
    prisma.bookVersion.findMany
      .mockResolvedValueOnce([
        {
          id: 'v-text',
          language: Language.en,
          type: BookType.text,
          isFree: true,
          slug: 'slug-1',
          _count: { chapters: 5, audioChapters: 0, summaries: 0 },
        },
      ])
      .mockResolvedValueOnce([{ id: 'v-text', seoId: null, primaryCategoryId: null }]);
    prisma.readingProgress.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ chapterNumber: 9, position: 700, bookVersion: { type: 'audio' } });
    service = createService(prisma);
  });

  /**
   * Тип версии — единственное, ради чего запасной поиск вообще читает
   * `bookVersion`. Узкий `select` обязан оставить проверку работающей: иначе
   * позиция, оставленная в плеере, приедет в читалку как прочитанная глава.
   */
  it('позиция из плеера не становится последней прочитанной главой', async () => {
    const res = await service.getReaderBootstrap('slug-1', Language.en, 'u1');

    expect(res.lastProgress).toBeNull();
  });
});

describe('LEGACY-128: сортировка по популярности считается в базе', () => {
  let prisma: PrismaStub;
  let service: BookService;

  /** 200 книг в каталоге, страница — 12. */
  const pageBookIds = Array.from({ length: 12 }, (_, i) => ({ bookId: `b${i}` }));

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ total: 200 }])
      .mockResolvedValueOnce(pageBookIds)
      .mockResolvedValue([]);
    prisma.bookVersion.findMany.mockResolvedValue(
      pageBookIds.map(({ bookId }, i) => ({
        id: `v${i}`,
        bookId,
        slug: `book-${i}`,
        title: `T${i}`,
        author: 'A',
        authorId: null,
        coverImageUrl: '',
        type: BookType.text,
        publishedAt: new Date('2026-01-01T00:00:00Z'),
        _count: { chapters: 1, audioChapters: 0 },
        categories: [],
      })),
    );
    service = createService(prisma);
  });

  it('при 200 книгах и limit=12 из базы не запрашивается 200 строк', async () => {
    const res = await service.findCards(Language.en, 1, 12, 'popular');

    // Страница собирается запросом с LIMIT/OFFSET, а не выборкой всего каталога:
    // безлимитный `bookVersion.findMany` с `distinct` в этой ветке больше не зовётся.
    const distinctCalls = prisma.bookVersion.findMany.mock.calls.filter(
      ([args]: [{ distinct?: unknown }]) => !!args?.distinct,
    );
    expect(distinctCalls).toHaveLength(0);
    expect(res.items).toHaveLength(12);
    expect(res.pagination).toEqual({ page: 1, limit: 12, total: 200, totalPages: 17 });
  });

  it('страница берётся из базы с LIMIT и OFFSET', async () => {
    await service.findCards(Language.en, 3, 12, 'popular');

    // `$queryRaw` зовётся тегированным шаблоном: первый аргумент - куски
    // литерала, дальше подставляемые значения.
    const pageQuery = prisma.$queryRaw.mock.calls[1] as [string[], ...unknown[]];
    const sql = pageQuery[0].join('?');
    expect(sql).toMatch(/LIMIT/);
    expect(sql).toMatch(/OFFSET/);
    // Порядок при равных рейтингах сохранён дословно (`LEGACY-128`, Rule) -
    // вместе с перевёрнутым вторым ключом: прежний comparator звался с
    // переставленными аргументами и давал `publishedAt` по возрастанию с
    // датой-`null` в начале (`LEGACY-253`). Здесь стережётся именно прежнее
    // поведение: разворот на `DESC NULLS LAST` сдвинет границы всех страниц.
    // Третий ключ обязателен: без `id ASC` книги с равными рейтингом и датой
    // тасуются между запросами, и одна и та же книга приезжает на двух
    // страницах подряд, а другая пропадает.
    expect(sql).toMatch(
      /ORDER BY COALESCE\("avgScore", -1\) DESC, "publishedAt" ASC NULLS FIRST, id ASC/,
    );
    // Внутренний порядок `DISTINCT ON` — своя посадка: его подмена вернёт
    // произвольный выбор версии, ради которого `DISTINCT ON` и написан.
    expect(sql).toMatch(/ORDER BY bv\."bookId", bv\."publishedAt" DESC NULLS LAST, bv\.id ASC/);
    // Порядок значений важен: `LIMIT ${skip} OFFSET ${limit}` отдаст 24 карточки
    // с 12-й позиции, и `arrayContaining` этого не заметит.
    expect(pageQuery.slice(-2)).toEqual([12, 24]);
  });

  /**
   * 🔴 Условия фильтра в этой ветке собраны заново на сыром SQL, и прежние
   * спеки фильтров их не видят: они зовут `findCards` без `sort` и уходят в
   * ветку по умолчанию. Снятое здесь условие языка или статуса тихо смешало бы
   * в популярном каталоге черновики и чужие языки.
   */
  it('фильтр по языку и статусу стоит в обоих запросах', async () => {
    await service.findCards(Language.en, 1, 12, 'popular');

    for (const call of prisma.$queryRaw.mock.calls) {
      const sql = renderSql(call as unknown[]);
      expect(sql).toContain('bv.language = ?::"Language"');
      expect(sql).toContain(`bv.status = 'published'::"PublicationStatus"`);
    }
  });

  it('фильтр по типу переезжает в SQL: audio — по аудиоглавам', async () => {
    await service.findCards(Language.en, 1, 12, 'popular', 'audio');

    const sql = renderSql(prisma.$queryRaw.mock.calls[1] as unknown[]);
    expect(sql).toContain('EXISTS (SELECT 1 FROM "AudioChapter"');
    expect(sql).not.toContain('"Chapter" ch');
  });

  it('фильтр по типу переезжает в SQL: text — по главам или типу версии', async () => {
    await service.findCards(Language.en, 1, 12, 'popular', 'text');

    const sql = renderSql(prisma.$queryRaw.mock.calls[1] as unknown[]);
    expect(sql).toContain('EXISTS (SELECT 1 FROM "Chapter"');
    expect(sql).toContain(`bv.type = 'text'::"BookType"`);
  });

  it('поиск переезжает в SQL по названию и автору, значением-параметром', async () => {
    await service.findCards(Language.en, 1, 12, 'popular', undefined, 'tolstoy');

    const pageCall = prisma.$queryRaw.mock.calls[1] as [string[], ...unknown[]];
    const sql = renderSql(pageCall as unknown[]);
    expect(sql).toContain('bv.title ILIKE');
    expect(sql).toContain('bv.author ILIKE');
    // Значение уходит параметром, а не склейкой в текст запроса.
    expect(sql).not.toContain('tolstoy');
    const whereSql = pageCall[1] as { values: unknown[] };
    expect(whereSql.values).toEqual(expect.arrayContaining(['tolstoy']));
  });

  /**
   * `total` считает **книги**, а не версии, и приходит числом, а не `BigInt`:
   * снятый `::int` роняет `Math.ceil(total / limit)` в `TypeError` на живой
   * витрине, а `SELECT bv.id` вместо `DISTINCT bv."bookId"` втрое завышает
   * число страниц у книги с тремя переводами.
   */
  it('счётный запрос считает различные bookId и приводит счёт к int', async () => {
    await service.findCards(Language.en, 1, 12, 'popular');

    const sql = renderSql(prisma.$queryRaw.mock.calls[0] as unknown[]);
    expect(sql).toContain('COUNT(*)::int AS total');
    expect(sql).toContain('SELECT DISTINCT bv."bookId"');
  });

  it('пустой каталог отдаёт пустую страницу и не идёт за карточками', async () => {
    prisma.$queryRaw.mockReset();
    prisma.$queryRaw.mockResolvedValueOnce([{ total: 0 }]);

    const res = await service.findCards(Language.en, 1, 12, 'popular');

    expect(res.items).toEqual([]);
    expect(res.pagination.total).toBe(0);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
