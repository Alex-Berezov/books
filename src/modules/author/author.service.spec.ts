import { AuthorService } from './author.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';

interface PrismaStub {
  author: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
    findMany: jest.Mock;
  };
  authorTranslation: {
    deleteMany: jest.Mock;
    createMany: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    findFirst: jest.Mock;
  };
  seo: {
    deleteMany: jest.Mock;
  };
  bookVersion: {
    findMany: jest.Mock;
  };
  bookRating: {
    aggregate: jest.Mock;
    groupBy: jest.Mock;
  };
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
}

const createPrismaStub = (): PrismaStub => {
  const stub = {
    author: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    authorTranslation: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    seo: {
      deleteMany: jest.fn(),
    },
    bookVersion: {
      findMany: jest.fn(),
    },
    bookRating: {
      aggregate: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };

  stub.$transaction.mockImplementation(async (callback: unknown) => {
    if (typeof callback === 'function') {
      const fn = callback as (tx: Omit<PrismaStub, '$transaction'>) => Promise<unknown>;
      return fn(stub);
    }
    return callback;
  });

  return stub;
};

const createSlugRedirectStub = () => ({
  record: jest.fn().mockResolvedValue(undefined),
  recordBaseSlugChange: jest.fn().mockResolvedValue(undefined),
  resolve: jest.fn().mockResolvedValue(null),
});

describe('AuthorService', () => {
  let service: AuthorService;
  let prisma: PrismaStub;
  let slugRedirects: ReturnType<typeof createSlugRedirectStub>;

  beforeEach(() => {
    prisma = createPrismaStub();
    slugRedirects = createSlugRedirectStub();
    service = new AuthorService(
      prisma as unknown as PrismaService,
      slugRedirects as unknown as SlugRedirectService,
    );
  });

  describe('create', () => {
    it('creates author successfully', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      prisma.author.create.mockResolvedValue({ id: 'auth1', translations: [] });

      const dto = {
        translations: [{ language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' }],
      };

      const result = await service.create(dto);
      expect(prisma.authorTranslation.findFirst).toHaveBeenCalledWith({
        where: { language: Language.en, slug: 'oscar-wilde' },
      });
      expect(prisma.author.create).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('throws BadRequestException if translation slug exists', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue({ id: 'trans1', slug: 'oscar-wilde' });

      const dto = {
        translations: [{ language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' }],
      };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    /**
     * `LEGACY-196`. Отказ базы отдавался как **400** с текстом драйвера,
     * приклеенным к `message`: разведданные о схеме уходили сотруднику,
     * а падение базы выглядело в мониторинге потоком ошибок валидации
     * и не поднимало ни одного алерта — `SentryExceptionFilter` шлёт
     * в Sentry только 5xx.
     *
     * ⚠️ Проверяется `toEqual`, а не `toContain`: `toContain` прошёл бы
     * и на теле, где рядом с фразой лежит лишнее поле с тем же текстом.
     */
    it('отказ базы — 500 без текста драйвера, текст в лог и в cause', async () => {
      const driverText =
        'Invalid `prisma.author.create()` invocation: column "birth_date" does not exist';
      const original = new Error(driverText);
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      prisma.author.create.mockRejectedValue(original);
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const dto = {
        translations: [{ language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' }],
      };

      try {
        await service.create(dto);
        throw new Error('create was expected to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const failure = err as HttpException;
        expect(failure.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect(failure.getResponse()).toEqual({ message: 'Failed to create author' });
        expect(JSON.stringify(failure.getResponse())).not.toContain('birth_date');
        expect(failure.cause).toBe(original);
      }

      expect(String(logged.mock.calls[0][0])).toContain(driverText);
      logged.mockRestore();
    });

    /** Отказ не-`Error` объектом иначе превращается в `[object Object]`. */
    it('отказ не-Error объектом всё равно оставляет след в логе', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      prisma.author.create.mockRejectedValue({ code: 'P2024' });
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const dto = {
        translations: [{ language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' }],
      };

      await expect(service.create(dto)).rejects.toBeInstanceOf(HttpException);
      expect(String(logged.mock.calls[0][0])).toContain('P2024');
      logged.mockRestore();
    });

    /**
     * Проверка занятого слага стоит **выше** `try` и обязана остаться 400:
     * заворачивание её в 500 было бы «починкой», которая ломает контракт.
     */
    it('занятый слаг остаётся 400, а не превращается в 500', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue({ id: 'trans1', slug: 'oscar-wilde' });

      const dto = {
        translations: [{ language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' }],
      };

      await expect(service.create(dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * `P2002` — ошибка ввода, а не сбой сервера. Предпроверка слага выше
     * по методу ловит `@@unique([language, slug])`, но не
     * `@@unique([authorId, language])`: два перевода одного языка в одном теле
     * доходят до базы. 500 здесь был бы той же подменой статуса, ради снятия
     * которой `LEGACY-196` и заводилась, — только в другую сторону
     * (`STYLE_GUIDE.md` §8: `P2002` → 409).
     */
    it('нарушенное уникальное ограничение — 409, а не 500', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      prisma.author.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`authorId`,`language`)',
          { code: 'P2002', clientVersion: '7.0.0' },
        ),
      );

      const dto = {
        translations: [
          { language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' },
          { language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde-2' },
        ],
      };

      const err = await service.create(dto).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      // Текст драйвера не уходит наружу и на этом пути тоже.
      expect(JSON.stringify((err as ConflictException).getResponse())).not.toContain(
        'Unique constraint failed',
      );
    });
  });

  describe('update', () => {
    it('updates author successfully', async () => {
      prisma.author.findUnique.mockResolvedValue({ id: 'auth1' }); // findUnique check in service
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      prisma.author.update.mockResolvedValue({ id: 'auth1' });
      prisma.authorTranslation.findMany.mockResolvedValue([]);

      const dto = {
        translations: [{ language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' }],
      };

      const result = await service.update('auth1', dto);
      expect(result).toBeDefined();
    });

    /**
     * `LEGACY-196`, вторая точка. `update` заворачивал отказ `$transaction`
     * в тот же 400 с текстом драйвера. Проверка нужна отдельно от `create`:
     * это разные блоки `catch`, и починка одного оставила бы второй как был.
     */
    it('отказ транзакции — 500 без текста драйвера', async () => {
      const driverText =
        'Invalid `prisma.authorTranslation.create()` invocation: Unique constraint failed on the fields: (`slug`)';
      const original = new Error(driverText);
      prisma.author.findUnique.mockResolvedValue({ id: 'auth1' });
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      prisma.$transaction.mockRejectedValueOnce(original);
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const dto = {
        translations: [{ language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' }],
      };

      try {
        await service.update('auth1', dto);
        throw new Error('update was expected to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const failure = err as HttpException;
        expect(failure.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect(failure.getResponse()).toEqual({ message: 'Failed to update author' });
        expect(JSON.stringify(failure.getResponse())).not.toContain('Unique constraint');
        expect(failure.cause).toBe(original);
      }

      expect(String(logged.mock.calls[0][0])).toContain(driverText);
      logged.mockRestore();
    });

    it('throws NotFoundException if author does not exist', async () => {
      prisma.author.findUnique.mockResolvedValue(null);

      await expect(service.update('auth1', { translations: [] })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('delete', () => {
    it('deletes author successfully', async () => {
      prisma.author.findUnique.mockResolvedValue({ id: 'auth1' });
      prisma.author.delete.mockResolvedValue({ id: 'auth1' });

      await service.delete('auth1');
      expect(prisma.author.delete).toHaveBeenCalledWith({ where: { id: 'auth1' } });
    });

    it('throws NotFoundException on delete if not found', async () => {
      prisma.author.findUnique.mockResolvedValue(null);

      await expect(service.delete('auth1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getPublicBySlug', () => {
    it('returns author public view data with translated books', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue({
        id: 'trans1',
        authorId: 'auth1',
        slug: 'oscar-wilde',
        language: Language.en,
        name: 'Oscar Wilde',
        biography: 'Bio text',
        quotes: [],
        faq: [],
        similarSlugs: [],
        author: {
          id: 'auth1',
          birthDate: '1854-10-16',
          deathDate: '1900-11-30',
        },
      });

      prisma.bookVersion.findMany.mockResolvedValue([
        {
          id: 'v1',
          bookId: 'b1',
          slug: 'picture-of-dorian-gray',
          title: 'The Picture of Dorian Gray',
          author: 'Oscar Wilde',
          coverImageUrl: 'cover.jpg',
          type: 'text',
          isFree: true,
          language: Language.en,
          status: 'published',
          book: { id: 'b1', slug: 'dorian-gray' },
        },
      ]);

      prisma.bookRating.groupBy.mockResolvedValue([{ bookId: 'b1', _avg: { score: 4.5 } }]);

      const result = await service.getPublicBySlug('oscar-wilde', Language.en);
      expect(result.name).toBe('Oscar Wilde');
      expect(result.books).toHaveLength(1);
      expect(result.books[0].title).toBe('The Picture of Dorian Gray');
      expect(result.books[0].rating).toBe(4.5);
    });

    it('throws NotFoundException if no translation is found by slug', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue(null);

      await expect(service.getPublicBySlug('oscar-wilde', Language.en)).rejects.toThrow(
        NotFoundException,
      );
    });

    /**
     * `LEGACY-216`. Проверяется **число запросов**, а не форма ответа: до правки
     * страница уходила в базу по разу на каждую книгу автора, и ни один кейс
     * этого не видел - ответ был правильным при любом числе походов.
     *
     * Образец - `book/book.service.query-count.spec.ts`, где тот же приём
     * посажен на `findAll`.
     */
    describe('число запросов за рейтингами (LEGACY-216)', () => {
      const twentyVersions = Array.from({ length: 20 }, (_, i) => ({
        id: `v${i}`,
        bookId: `b${i}`,
        slug: `book-${i}`,
        title: `Book ${i}`,
        author: 'Oscar Wilde',
        coverImageUrl: 'cover.jpg',
        type: 'text',
        isFree: true,
        language: Language.en,
        status: 'published',
        book: { id: `b${i}`, slug: `book-${i}` },
      }));

      beforeEach(() => {
        prisma.authorTranslation.findFirst.mockResolvedValue({
          id: 'trans1',
          authorId: 'auth1',
          slug: 'oscar-wilde',
          language: Language.en,
          name: 'Oscar Wilde',
          biography: 'Bio text',
          quotes: [],
          faq: [],
          similarSlugs: [],
          author: { id: 'auth1', birthDate: null, deathDate: null },
        });
      });

      it('на двадцати книгах не зовёт bookRating.aggregate ни разу, а groupBy - ровно один', async () => {
        prisma.bookVersion.findMany.mockResolvedValue(twentyVersions);
        prisma.bookRating.groupBy.mockResolvedValue([]);

        await service.getPublicBySlug('oscar-wilde', Language.en);

        expect(prisma.bookRating.aggregate).toHaveBeenCalledTimes(0);
        expect(prisma.bookRating.groupBy).toHaveBeenCalledTimes(1);
      });

      it('групповой запрос спрашивает идентификаторы всех книг автора', async () => {
        prisma.bookVersion.findMany.mockResolvedValue(twentyVersions);
        prisma.bookRating.groupBy.mockResolvedValue([]);

        await service.getPublicBySlug('oscar-wilde', Language.en);

        const [args] = prisma.bookRating.groupBy.mock.calls[0] as [
          { where: { bookId: { in: string[] } } },
        ];
        expect(args.where.bookId.in).toEqual(twentyVersions.map((v) => v.bookId));
      });

      it('у автора без книг в базу за рейтингами не ходит вовсе', async () => {
        prisma.bookVersion.findMany.mockResolvedValue([]);

        const result = await service.getPublicBySlug('oscar-wilde', Language.en);

        expect(result.books).toEqual([]);
        expect(prisma.bookRating.groupBy).toHaveBeenCalledTimes(0);
      });
    });
  });

  describe('list', () => {
    // LEGACY-117. Здесь ранний выход уже стоял (`countPublishedBooksByAuthor`
    // возвращает пустую карту до сборки условия) — спека держит его на месте:
    // `Prisma.join([])` бросает TypeError, и снятие проверки красит её.
    // Проверяется именно **отсутствие вызова** `$queryRaw`.
    it('returns an empty page without touching $queryRaw when the page is out of range', async () => {
      prisma.$transaction.mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
      prisma.author.count.mockResolvedValue(42);
      prisma.author.findMany.mockResolvedValue([]);
      prisma.$queryRaw.mockRejectedValue(new Error('$queryRaw must not be reached'));

      const res = await service.list(99, 20, Language.en);

      expect(res.data).toEqual([]);
      expect(res.meta).toEqual({ page: 99, limit: 20, total: 42, totalPages: 3 });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    // LEGACY-352: сервер отвечает за поиск, а не за фильтрацию клиентом.
    // Условие проверяется у ОБОИХ запросов: перенос `where` только на `count`
    // оставил бы `meta.total: 0` рядом с полной страницей случайных авторов.
    it('filters by translation name (case-insensitive) when search is given', async () => {
      prisma.$transaction.mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
      prisma.author.count.mockResolvedValue(0);
      prisma.author.findMany.mockResolvedValue([]);

      const res = await service.list(1, 20, undefined, 'tolstoy');

      const expectedWhere = {
        translations: { some: { name: { contains: 'tolstoy', mode: 'insensitive' } } },
      };
      expect(prisma.author.count).toHaveBeenCalledTimes(1);
      expect(prisma.author.count).toHaveBeenCalledWith({ where: expectedWhere });
      expect(prisma.author.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.author.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
      expect(res.data).toEqual([]);
    });

    // `%` и `_` — символы запроса, а не подстановки: без экранирования
    // `?q=%` вернул бы первую сотню авторов вместо пустого списка.
    it('escapes LIKE wildcards and trims the term', async () => {
      prisma.$transaction.mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
      prisma.author.count.mockResolvedValue(0);
      prisma.author.findMany.mockResolvedValue([]);

      await service.list(1, 20, undefined, '  100%_  ');

      const expectedWhere = {
        translations: {
          some: { name: { contains: '100\\%\\_', mode: 'insensitive' } },
        },
      };
      expect(prisma.author.count).toHaveBeenCalledTimes(1);
      expect(prisma.author.count).toHaveBeenCalledWith({ where: expectedWhere });
      // Страницу собирает `findMany`, и сырой терм именно в нём дал бы
      // `meta.total: 0` рядом с полной страницей случайных авторов.
      expect(prisma.author.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.author.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
    });

    // Пустой и пробельный запрос — это «без отбора», а не «совпадение со всем».
    it('ignores a blank search instead of matching everything', async () => {
      prisma.$transaction.mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
      prisma.author.count.mockResolvedValue(0);
      prisma.author.findMany.mockResolvedValue([]);

      await service.list(1, 20, undefined, '   ');

      expect(prisma.author.count).toHaveBeenCalledTimes(1);
      expect(prisma.author.count).toHaveBeenCalledWith({ where: undefined });
      expect(prisma.author.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.author.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    // Язык и имя — один `some`, иначе они могут совпасть в РАЗНЫХ переводах,
    // и автор с русским именем попадёт в выдачу с `lang=en`.
    it('puts lang and search into one translation condition, not two', async () => {
      prisma.$transaction.mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
      prisma.author.count.mockResolvedValue(0);
      prisma.author.findMany.mockResolvedValue([]);

      await service.list(1, 20, Language.en, 'tolstoy');

      const expectedWhere = {
        translations: {
          some: {
            language: Language.en,
            name: { contains: 'tolstoy', mode: 'insensitive' },
          },
        },
      };
      expect(prisma.author.count).toHaveBeenCalledTimes(1);
      expect(prisma.author.count).toHaveBeenCalledWith({ where: expectedWhere });
      expect(prisma.author.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.author.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
    });
  });

  describe('findOne', () => {
    // LEGACY-352: страница правки автора раньше искала запись в первой
    // странице `list()` и не находила авторов за сотым — одиночное чтение
    // снимает поиск целиком.
    it('throws NotFoundException when the author does not exist', async () => {
      prisma.author.findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns the author shaped like a list() item', async () => {
      prisma.author.findUnique.mockResolvedValue({
        id: 'auth1',
        birthDate: null,
        deathDate: null,
        translations: [
          {
            language: 'en',
            slug: 'jane-doe',
            name: 'Jane Doe',
            wikidataUrl: null,
            wikipediaUrl: null,
            photoUrl: null,
          },
        ],
      });
      prisma.$queryRaw.mockResolvedValue([{ authorId: 'auth1', booksCount: 3 }]);

      const res = await service.findOne('auth1');

      expect(res).toMatchObject({
        id: 'auth1',
        slug: 'jane-doe',
        name: 'Jane Doe',
        booksCount: 3,
      });
      expect(prisma.author.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.author.findUnique).toHaveBeenCalledWith({
        where: { id: 'auth1' },
        include: { translations: { include: { seo: true } } },
      });
    });
  });

  describe('listPublic', () => {
    /**
     * `$queryRaw` вызывается тегом шаблона, поэтому мок получает
     * `(strings, ...values)`, а вложенные `Prisma.sql` приезжают значениями.
     * Собираем из этого читаемый SQL: проверять надо именно текст запроса —
     * сортировку, `HAVING`, потолок, — а не факт вызова.
     */
    const renderValue = (value: unknown): string => {
      if (value && typeof value === 'object' && 'strings' in value && 'values' in value) {
        const sql = value as { strings: readonly string[]; values: readonly unknown[] };
        return sql.strings
          .map((part, at) => (at === 0 ? part : renderValue(sql.values[at - 1]) + part))
          .join('');
      }
      return JSON.stringify(value);
    };

    const renderCall = (call: unknown[]): string => {
      const [strings, ...values] = call as [readonly string[], ...unknown[]];
      return strings
        .map((part, at) => (at === 0 ? part : renderValue(values[at - 1]) + part))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const pageSql = () => renderCall(prisma.$queryRaw.mock.calls[0]);
    const totalSql = () => renderCall(prisma.$queryRaw.mock.calls[1]);

    const ROW = {
      authorId: 'a1',
      booksCount: 28,
      audioCount: 9,
      bioSource: '<p>Русский писатель.</p>',
    };

    const AUTHOR = {
      id: 'a1',
      birthDate: '1821-11-11',
      deathDate: '1881-02-09',
      translations: [
        { language: Language.ru, slug: 'dostoevskiy', name: 'Фёдор Достоевский' },
        { language: Language.en, slug: 'dostoevsky', name: 'Fyodor Dostoevsky' },
      ],
    };

    const PAGE_TRANSLATION = {
      authorId: 'a1',
      slug: 'dostoevskiy',
      name: 'Фёдор Достоевский',
      photoUrl: 'https://media.bibliaris.com/a1.jpg',
    };

    /** Одна выдача из четырёх запросов: страница, total и две добирающих. */
    const arrange = (
      rows: Array<typeof ROW> = [ROW],
      total = 1,
      authors: Array<typeof AUTHOR> = [AUTHOR],
      pageTranslations: Array<typeof PAGE_TRANSLATION> = [PAGE_TRANSLATION],
    ) => {
      prisma.$transaction.mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
      prisma.$queryRaw.mockResolvedValueOnce(rows).mockResolvedValueOnce([{ total }]);
      prisma.author.findMany.mockResolvedValue(authors);
      prisma.authorTranslation.findMany.mockResolvedValue(pageTranslations);
    };

    it('builds the card from the path-language translation and the batched counters', async () => {
      arrange();

      const res = await service.listPublic(Language.ru);

      expect(res.data).toEqual([
        {
          id: 'a1',
          slug: 'dostoevskiy',
          name: 'Фёдор Достоевский',
          birthDate: '1821-11-11',
          deathDate: '1881-02-09',
          photoUrl: 'https://media.bibliaris.com/a1.jpg',
          shortBio: 'Русский писатель.',
          booksCount: 28,
          audioCount: 9,
          translations: [
            { language: Language.ru, slug: 'dostoevskiy', name: 'Фёдор Достоевский' },
            { language: Language.en, slug: 'dostoevsky', name: 'Fyodor Dostoevsky' },
          ],
        },
      ]);
      expect(res.meta).toEqual({ page: 1, limit: 24, total: 1, totalPages: 1 });
    });

    // 🔴 LEGACY-214: анонимной ручке незачем биография, quotes, faq и Seo каждого
    // перевода. Тест держит состав ответа, а не только его наличие.
    it('never leaks the full biography or the editorial fields', async () => {
      arrange([{ ...ROW, bioSource: `${'слово '.repeat(60)}хвост` }], 1);

      const [card] = (await service.listPublic(Language.ru)).data;

      expect(Object.keys(card).sort()).toEqual([
        'audioCount',
        'birthDate',
        'booksCount',
        'deathDate',
        'id',
        'name',
        'photoUrl',
        'shortBio',
        'slug',
        'translations',
      ]);
      expect(card.shortBio!.endsWith('…')).toBe(true);
      expect([...card.shortBio!].length).toBeLessThanOrEqual(161);
      expect(card.translations.every((t) => Object.keys(t).length === 3)).toBe(true);
    });

    it('reads only the whitelisted columns of the page-language translation', async () => {
      arrange();

      await service.listPublic(Language.ru);

      expect(prisma.authorTranslation.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.authorTranslation.findMany).toHaveBeenCalledWith({
        where: { authorId: { in: ['a1'] }, language: Language.ru },
        select: {
          authorId: true,
          slug: true,
          name: true,
          photoUrl: true,
        },
      });
    });

    // 🔴 `@db.Text` на двадцать четыре карточки ради ста шестидесяти знаков —
    // мегабайты по сети. Базa обрезает биографию сама, добор её не читает вовсе.
    it('takes the short bio from the query, never reading the full biography', async () => {
      arrange();

      await service.listPublic(Language.ru);

      expect(pageSql()).toContain('MIN(left(t.biography,');
      const select = prisma.authorTranslation.findMany.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('biography');
    });

    it('rejects a letter outside the alphabet of the path language', async () => {
      await expect(service.listPublic(Language.ru, { letter: 'W' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.listPublic(Language.en, { letter: 'Д' })).rejects.toThrow(
        BadRequestException,
      );
      // Отказ до запроса: пустой ответ с кодом 200 осел бы в общем кэше.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('accepts an own letter in either case and the # group', async () => {
      for (const letter of ['д', 'Д', '#']) {
        jest.clearAllMocks();
        arrange();
        await expect(service.listPublic(Language.ru, { letter })).resolves.toBeDefined();
      }
    });

    it('sorts alphabetically by default, with a tiebreaker for stable paging', async () => {
      arrange();

      await service.listPublic(Language.ru);

      expect(pageSql()).toContain('ORDER BY t.name ASC, t."authorId" ASC');
      expect(pageSql()).toContain('LIMIT 24 OFFSET 0');
    });

    // 🔴 Требование ТЗ: на тысяче авторов «взять всех, отсортировать в памяти,
    // потом отрезать» собрало бы страницу из случайных людей.
    it('sorts and pages by book count inside the SQL, not in JavaScript', async () => {
      arrange();

      await service.listPublic(Language.ru, { sort: 'books', page: 3, limit: 10 });

      expect(pageSql()).toContain('ORDER BY "booksCount" DESC, t.name ASC, t."authorId" ASC');
      expect(pageSql()).toContain('LIMIT 10 OFFSET 20');
    });

    it('counts audiobooks by BookType audio in the same query as the books', async () => {
      arrange();

      await service.listPublic(Language.ru);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(pageSql()).toContain(
        'COUNT(DISTINCT bv."bookId") FILTER (WHERE bv.type = \'audio\')::int AS "audioCount"',
      );
      // Двойное условие связи: FK в проде NULL у всех опубликованных версий.
      expect(pageSql()).toContain('bv."authorId" = t."authorId" OR bv.author = t.name');
    });

    it('searches by name case-insensitively and escapes LIKE wildcards', async () => {
      arrange();

      await service.listPublic(Language.ru, { search: '100%_дост' });

      expect(pageSql()).toContain('t.name ILIKE "%100\\\\%\\\\_дост%" ESCAPE \'\\\'');
    });

    it('ignores a blank search instead of matching everything', async () => {
      arrange();

      await service.listPublic(Language.ru, { search: '   ' });

      expect(pageSql()).not.toContain('ILIKE');
    });

    it('filters by letter through the folded first letter', async () => {
      arrange();

      await service.listPublic(Language.ru, { letter: 'д' });

      // `btrim` парен `.trim()` в `indexLetterOf`: имя с ведущим пробелом
      // обязано попасть под ту же букву, что показывает указатель.
      expect(pageSql()).toContain('upper(left(translate(btrim(t.name),');
      expect(pageSql()).toContain('= "Д"');
    });

    it('filters # as "starts with none of the alphabet"', async () => {
      arrange();

      await service.listPublic(Language.ru, { letter: '#' });

      expect(pageSql()).toContain('<> ALL (');
    });

    it('applies the same conditions to the page and to the total', async () => {
      arrange();

      await service.listPublic(Language.ru, { search: 'дост', letter: 'д' });

      expect(totalSql()).toContain('ILIKE');
      expect(totalSql()).toContain('= "Д"');
      expect(totalSql()).toContain('SELECT COUNT(*)::int AS total FROM (');
    });

    it('drops authors without books only when hasBooks is asked for', async () => {
      arrange();
      await service.listPublic(Language.ru, { hasBooks: true });
      expect(pageSql()).toContain('HAVING COUNT(DISTINCT bv."bookId") > 0');
      expect(totalSql()).toContain('HAVING COUNT(DISTINCT bv."bookId") > 0');

      jest.clearAllMocks();
      arrange();
      await service.listPublic(Language.ru);
      expect(pageSql()).not.toContain('HAVING');
    });

    // 🔴 Второй рубеж после `@Max` в DTO: сервис зовётся не только из контроллера.
    it('clamps the page size and reports the applied value in meta', async () => {
      arrange([ROW], 250);

      const res = await service.listPublic(Language.ru, { limit: 1000 });

      expect(pageSql()).toContain('LIMIT 100 OFFSET 0');
      expect(res.meta.limit).toBe(100);
      expect(res.meta.totalPages).toBe(3);
    });

    it('falls back to the defaults on a garbage page or limit', async () => {
      arrange();

      const res = await service.listPublic(Language.ru, {
        page: Number.NaN,
        limit: 0,
      });

      expect(res.meta).toEqual({ page: 1, limit: 24, total: 1, totalPages: 1 });
    });

    it('returns an empty page without hydrating when nothing matched', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      const res = await service.listPublic(Language.ru, { search: 'никого' });

      expect(res.data).toEqual([]);
      expect(res.meta).toEqual({ page: 1, limit: 24, total: 0, totalPages: 0 });
      expect(prisma.author.findMany).not.toHaveBeenCalled();
      expect(prisma.authorTranslation.findMany).not.toHaveBeenCalled();
    });

    // Расхождение между запросом страницы и добором — не «нет данных». Пустое
    // имя со ссылкой в никуда хуже отсутствующей карточки.
    it('drops a row whose page-language translation did not come back', async () => {
      arrange(
        [ROW, { ...ROW, authorId: 'a2', booksCount: 3, audioCount: 0 }],
        2,
        [AUTHOR],
        [PAGE_TRANSLATION],
      );

      const res = await service.listPublic(Language.ru);

      expect(res.data).toHaveLength(1);
      expect(res.data[0].id).toBe('a1');
    });

    it('keeps the order the SQL returned, not the order Prisma hydrated', async () => {
      const second = { ...AUTHOR, id: 'a2', translations: [] };
      const secondTranslation = {
        ...PAGE_TRANSLATION,
        authorId: 'a2',
        slug: 'wilde',
        name: 'Wilde',
      };
      arrange(
        [{ ...ROW, authorId: 'a2', booksCount: 40, audioCount: 1 }, ROW],
        2,
        [AUTHOR, second],
        [PAGE_TRANSLATION, secondTranslation],
      );

      const res = await service.listPublic(Language.ru, { sort: 'books' });

      expect(res.data.map((a) => a.id)).toEqual(['a2', 'a1']);
    });
  });

  describe('listPublicLetters', () => {
    it('returns the whole alphabet with zeros, # last, always filtered to authors with books', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { letter: 'Д', count: 12 },
        { letter: 'А', count: 3 },
      ]);

      const letters = await service.listPublicLetters(Language.ru);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(letters).toHaveLength(30); // 29 букв алфавита плюс `#`
      expect(letters[0]).toEqual({ letter: 'А', count: 3 });
      expect(letters.at(-1)).toEqual({ letter: '#', count: 0 });
      expect(letters.find((l) => l.letter === 'Д')).toEqual({ letter: 'Д', count: 12 });
      expect(letters.find((l) => l.letter === 'Б')).toEqual({ letter: 'Б', count: 0 });
    });

    // Счётчик буквы обязан совпасть с числом карточек под ней, а хаб показывает
    // только авторов с книгами.
    it('keeps the has-books filter in the query itself', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await service.listPublicLetters(Language.en);

      const [strings] = prisma.$queryRaw.mock.calls[0] as [readonly string[]];
      expect(strings.join(' ')).toContain('HAVING COUNT(DISTINCT bv."bookId") > 0');
    });

    it('folds a letter outside the page alphabet into #', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { letter: 'W', count: 2 },
        { letter: '5', count: 1 },
      ]);

      const letters = await service.listPublicLetters(Language.ru);

      expect(letters.at(-1)).toEqual({ letter: '#', count: 3 });
    });
  });
});
