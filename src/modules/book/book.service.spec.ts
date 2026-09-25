import { RelatedTaxonomyService } from '../seo/related-taxonomy/related-taxonomy.service';
import { BookService } from './book.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorService } from '../author/author.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';
import { BookType, Language } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { RedirectException } from '../../common/exceptions/redirect.exception';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';

interface PrismaStub {
  book: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
  };
  bookVersion: { findMany: jest.Mock; findFirst: jest.Mock; groupBy: jest.Mock };
  bookSummary: { findFirst: jest.Mock };
  seo: { findUnique: jest.Mock; findMany: jest.Mock };
  bookCategory: { findMany: jest.Mock };
  bookTag: { findMany: jest.Mock };
  bookRating: {
    aggregate: jest.Mock;
    upsert: jest.Mock;
    findUnique: jest.Mock;
    groupBy: jest.Mock;
  };
  authorTranslation: { findMany: jest.Mock };
  $queryRaw: jest.Mock;
  // `remove()` (LEGACY-395) читает после `book.delete` внутри той же
  // транзакции, чтобы своя же (уже удалённая) книга не мешала проверке.
  $transaction: jest.Mock;
}

const createPrismaStub = (): PrismaStub => {
  const stub: PrismaStub = {
    book: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
    },
    bookVersion: {
      findMany: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn(),
    },
    bookSummary: { findFirst: jest.fn() },
    seo: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    bookCategory: { findMany: jest.fn().mockResolvedValue([]) },
    bookTag: { findMany: jest.fn().mockResolvedValue([]) },
    bookRating: {
      aggregate: jest.fn().mockResolvedValue({ _avg: { score: 5.0 } }),
      upsert: jest.fn(),
      findUnique: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    authorTranslation: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };
  stub.$transaction.mockImplementation((fn: (tx: PrismaStub) => unknown) => fn(stub));
  return stub;
};

/**
 * Текст запроса из тегированного шаблона: куски литерала плюс подставленные фрагменты
 * `Prisma.sql` (у них свои `strings`). Значения-параметры остаются знаком вопроса.
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

const createGeoBlockRuleServiceStub = (): GeoBlockRuleService =>
  ({
    assertAccess: jest.fn(),
  }) as unknown as GeoBlockRuleService;

/** Чтение обзора историю слагов не пишет — нужен лишь корректный конструктор. */
const createSlugRedirectStub = (): SlugRedirectService =>
  ({
    record: jest.fn().mockResolvedValue(undefined),
    recordBaseSlugChange: jest.fn().mockResolvedValue(undefined),
    resolve: jest.fn().mockResolvedValue(null),
    cleanupDeadRedirects: jest.fn().mockResolvedValue(undefined),
  }) as unknown as SlugRedirectService;

/**
 * Обзор и карточки читает аноним, поэтому во всех спеках ниже модератора нет:
 * стаб отвечает «нет» — ровно то состояние, в котором черновики не видны
 * (`LEGACY-090`).
 */
const createModeratorRolesStub = (): ModeratorRolesService =>
  ({
    isModerator: jest.fn().mockResolvedValue(false),
    isAdmin: jest.fn().mockResolvedValue(false),
  }) as unknown as ModeratorRolesService;

describe('BookService.getOverview', () => {
  let service: BookService;
  let adminAudit: { record: jest.Mock };
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new BookService(
      prisma as unknown as PrismaService,
      createGeoBlockRuleServiceStub(),
      new RelatedTaxonomyService(prisma as unknown as PrismaService),
      createSlugRedirectStub(),
      createModeratorRolesStub(),
      // LEGACY-006: настоящий AuthorService на том же стабе prisma — добор слагов
      // по-прежнему управляется моками `authorTranslation.findMany`.
      new AuthorService(
        prisma as unknown as PrismaService,
        {} as unknown as SlugRedirectService,
        // `LEGACY-015`, пачка `T21`: писатель журнала обязателен по конструктору, но этот
        // файл удаление автора не трогает вовсе — `record` здесь не зовётся ни разу.
        { record: jest.fn() } as unknown as AdminAuditService,
      ),
      adminAudit as unknown as AdminAuditService,
    );
  });

  it('returns aggregated overview with languages, flags and SEO (happy path)', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'slug-1' });
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-text-en',
        language: Language.en,
        type: BookType.text,
        isFree: true,
        seoId: 1,
        _count: { chapters: 5, audioChapters: 0, summaries: 1 },
      },
      {
        id: 'v-audio-es',
        language: Language.es,
        type: BookType.audio,
        isFree: false,
        seoId: 2,
        _count: { chapters: 0, audioChapters: 3, summaries: 0 },
      },
      {
        id: 'v-ref-fr',
        language: Language.fr,
        type: BookType.referral,
        isFree: true,
        seoId: null,
        _count: { chapters: 0, audioChapters: 0, summaries: 0 },
      },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's1' });
    // Все четыре поля `seo` собираются одной выборкой (`LEGACY-126`).
    prisma.seo.findMany.mockResolvedValue([
      { id: 1, metaTitle: 'T-text', metaDescription: 'D-text' },
      { id: 2, metaTitle: 'T-audio', metaDescription: 'D-audio' },
    ]);

    // ⚠️ Язык приходит вторым аргументом, а не заголовком третьим: третьего
    // у метода больше нет — он читался только снятым `GET /books/:slug/overview`
    // (`LEGACY-387`, 15.09.2026). Выбор `es` и все ожидания ниже те же.
    const res = await service.getOverview('slug-1', 'es');

    expect(res.book.slug).toBe('slug-1');
    expect(new Set(res.availableLanguages)).toEqual(
      new Set([Language.en, Language.es, Language.fr]),
    );
    expect(res.hasText).toBe(true);
    expect(res.hasAudio).toBe(true);
    expect(res.hasSummary).toBe(true);
    expect(res.versionIds).toEqual({ text: 'v-text-en', audio: 'v-audio-es' });
    expect(res.seo.main?.metaTitle).toBe('T-text');
    expect(res.seo.read?.metaTitle).toBe('T-text');
    expect(res.seo.listen?.metaTitle).toBe('T-audio');
    expect(res.seo.summary?.metaTitle).toBe('T-text');
  });

  /**
   * 🔴 LEGACY-006. Публичный адрес автора обзор книги не отдавал вовсе, и фронт
   * собирал его слагификацией отображаемого имени. Слаг бывает транслитерацией:
   * «Сунь-цзы» лежит под `sun-czy`, а из имени получалось бы другое — ссылка
   * со страницы книги вела в 404. Теперь ключ отдаётся сервером, а фронту собирать
   * его запрещено (`books-front/types/api-schema/books.ts`, `BookCardModel.authorSlug`).
   */
  describe('настоящий слаг автора в обзоре (LEGACY-006)', () => {
    const arrangeOverview = (
      authorId: string | null,
      extraVersions: Array<Record<string, unknown>> = [],
    ) => {
      prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'slug-1' });
      prisma.bookVersion.findMany.mockResolvedValue([
        {
          id: 'v-text-ru',
          language: Language.ru,
          type: BookType.text,
          isFree: true,
          seoId: null,
          author: 'Сунь-цзы',
          authorId,
          _count: { chapters: 5, audioChapters: 0, summaries: 0 },
        },
        ...extraVersions,
      ]);
      prisma.seo.findMany.mockResolvedValue([]);
    };

    it('отдаёт слаг из справочника и на верхнем уровне, и у версии', async () => {
      arrangeOverview('author-1');
      prisma.authorTranslation.findMany.mockResolvedValue([
        { authorId: 'author-1', language: Language.ru, slug: 'sun-czy' },
      ]);

      const res = await service.getOverview('slug-1', Language.ru);

      expect(res.authorSlug).toBe('sun-czy');
      expect(res.versions[0].authorSlug).toBe('sun-czy');
      // Запрос один на весь обзор, а не по запросу на версию.
      expect(prisma.authorTranslation.findMany).toHaveBeenCalledTimes(1);
      // 🔴 Язык спрашивается **строго** тот, что у версии: английского фолбэка нет.
      // `en`-слаг, подставленный в адрес под `/ru`, — гарантированный 404
      // (`getPublicBySlug` ищет парой «слаг + язык»).
      expect(prisma.authorTranslation.findMany).toHaveBeenCalledWith({
        where: { authorId: { in: ['author-1'] }, language: { in: [Language.ru] } },
        select: { authorId: true, language: true, slug: true },
      });
    });

    // Перевода на язык ответа нет — адреса нет. `null` честнее выдуманного слага:
    // фронт по нему рисует имя текстом, без ссылки в никуда.
    it('отдаёт null, когда перевода автора нет', async () => {
      arrangeOverview('author-1');
      prisma.authorTranslation.findMany.mockResolvedValue([]);

      const res = await service.getOverview('slug-1', Language.ru);

      expect(res.authorSlug).toBeNull();
      expect(res.versions[0].authorSlug).toBeNull();
      // Имя при этом на месте — правка меняет адрес, а не подпись.
      expect(res.author).toBe('Сунь-цзы');
    });

    /**
     * 🔴 Слаг версии считается по языку **этой версии**, а не по языку страницы.
     * Иначе у книги с версиями `ru` и `fr` французская версия получила бы русский слаг,
     * и ссылка из неё ушла бы на `/fr/author/<русский слаг>` — 404.
     */
    it('слаг каждой версии считается в языке этой версии', async () => {
      arrangeOverview('author-1', [
        {
          id: 'v-text-fr',
          language: Language.fr,
          type: BookType.text,
          isFree: true,
          seoId: null,
          author: 'Sun Tzu',
          authorId: 'author-1',
          _count: { chapters: 3, audioChapters: 0, summaries: 0 },
        },
      ]);
      prisma.authorTranslation.findMany.mockResolvedValue([
        { authorId: 'author-1', language: Language.ru, slug: 'sun-czy' },
        { authorId: 'author-1', language: Language.fr, slug: 'sun-tzu-fr' },
      ]);

      const res = await service.getOverview('slug-1', Language.ru);

      const ru = res.versions.find((v) => v.language === Language.ru);
      const fr = res.versions.find((v) => v.language === Language.fr);
      expect(ru?.authorSlug).toBe('sun-czy');
      expect(fr?.authorSlug).toBe('sun-tzu-fr');

      // Оба языка спрошены одним запросом, а не по запросу на версию.
      expect(prisma.authorTranslation.findMany).toHaveBeenCalledTimes(1);
      const where = prisma.authorTranslation.findMany.mock.calls[0][0].where as {
        language: { in: string[] };
      };
      expect(new Set(where.language.in)).toEqual(new Set([Language.ru, Language.fr]));
    });

    /**
     * 🔴 Активная версия не обязана быть на языке ответа: текста на запрошенном языке
     * может не быть вовсе, и тогда активной становится версия другого языка. Слаг этой
     * версии посчитан в **её** языке, а потребитель клеит его с языком ответа (`language`
     * ниже в теле) — получилась бы пара «слаг + язык», которой нет, то есть 404.
     * Поэтому верхнеуровневый слаг считается в языке **ответа**, а не активной версии.
     */
    it('верхнеуровневый слаг считается в языке ответа, а не активной версии', async () => {
      // Русская версия — аудио без глав, текст лежит только в английской: активной
      // станет английская, а ответ останется русским.
      prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'slug-1' });
      prisma.bookVersion.findMany.mockResolvedValue([
        {
          id: 'v-audio-ru',
          language: Language.ru,
          type: BookType.audio,
          isFree: true,
          seoId: null,
          slug: 'slug-1',
          author: 'Сунь-цзы',
          authorId: 'author-1',
          _count: { chapters: 0, audioChapters: 0, summaries: 0 },
        },
        {
          id: 'v-text-en',
          language: Language.en,
          type: BookType.text,
          isFree: true,
          seoId: null,
          slug: 'slug-1',
          author: 'Sun Tzu',
          authorId: 'author-1',
          _count: { chapters: 7, audioChapters: 0, summaries: 0 },
        },
      ]);
      prisma.seo.findMany.mockResolvedValue([]);
      prisma.authorTranslation.findMany.mockResolvedValue([
        { authorId: 'author-1', language: Language.ru, slug: 'sun-czy' },
        { authorId: 'author-1', language: Language.en, slug: 'sun-tzu' },
      ]);

      const res = await service.getOverview('slug-1', Language.ru);

      // Ответ русский — значит и слаг верхнего уровня русский, хотя активная версия английская.
      expect(res.language).toBe(Language.ru);
      expect(res.authorSlug).toBe('sun-czy');
      // У самих версий слаг по-прежнему в языке версии: эта ссылка ведёт под `/en`.
      const en = res.versions.find((v) => v.language === Language.en);
      expect(en?.authorSlug).toBe('sun-tzu');
    });

    /**
     * 🔴 Выбор языка может не состояться вовсе: книга издана только на `es` и `fr`,
     * запрос пришёл на `/pt` (`LEGACY-104`). Тогда `preferredLang` — `undefined`,
     * и подстановка `en` «чтобы что-то было» вернула бы снятый английский фолбэк
     * с другой стороны: ответ ушёл бы с английским слагом, а потребитель склеил бы
     * его с языком адреса и получил 404.
     */
    it('не выдаёт слаг, когда язык ответа не определился вовсе', async () => {
      prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'slug-1' });
      prisma.bookVersion.findMany.mockResolvedValue([
        {
          id: 'v-text-es',
          language: Language.es,
          type: BookType.text,
          isFree: true,
          seoId: null,
          slug: 'slug-1',
          author: 'Sun Tzu',
          authorId: 'author-1',
          _count: { chapters: 4, audioChapters: 0, summaries: 0 },
        },
      ]);
      prisma.seo.findMany.mockResolvedValue([]);
      prisma.authorTranslation.findMany.mockResolvedValue([
        { authorId: 'author-1', language: Language.en, slug: 'sun-tzu' },
        { authorId: 'author-1', language: Language.es, slug: 'sun-tzu-es' },
      ]);

      const res = await service.getOverview('slug-1', Language.pt);

      expect(res.language).toBeUndefined();
      expect(res.authorSlug).toBeNull();
      // У самой версии слаг есть — он в её собственном языке и годится только под `/es`.
      expect(res.versions[0].authorSlug).toBe('sun-tzu-es');
    });

    // Перевода на язык версии нет — слага нет. Подставлять английский нельзя:
    // страница автора ищет строго парой, и такой адрес отдаёт 404.
    it('не подставляет английский слаг, когда перевода на язык версии нет', async () => {
      arrangeOverview('author-1');
      prisma.authorTranslation.findMany.mockResolvedValue([
        { authorId: 'author-1', language: Language.en, slug: 'sun-tzu' },
      ]);

      const res = await service.getOverview('slug-1', Language.ru);

      expect(res.authorSlug).toBeNull();
      expect(res.versions[0].authorSlug).toBeNull();
    });

    // Ключа автора у версии нет (legacy-данные) — в справочник не ходим вовсе.
    it('не ходит в справочник, когда ключа автора нет', async () => {
      arrangeOverview(null);

      const res = await service.getOverview('slug-1', Language.ru);

      expect(res.authorSlug).toBeNull();
      expect(prisma.authorTranslation.findMany).not.toHaveBeenCalled();
    });
  });

  it('handles no versions gracefully', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b2', slug: 'book-2' });
    prisma.bookVersion.findMany.mockResolvedValue([]);

    const res = await service.getOverview('book-2', Language.en);
    expect(res.availableLanguages).toEqual([]);
    expect(res.hasText).toBe(false);
    expect(res.hasAudio).toBe(false);
    expect(res.hasSummary).toBe(false);
    expect(res.versionIds).toEqual({ text: null, audio: null });
    expect(res.seo.main).toBeNull();
  });

  it('prefers same-language version when available', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b3', slug: 'book-3' });
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-text-en',
        language: Language.en,
        type: BookType.text,
        isFree: true,
        seoId: 1,
        _count: { chapters: 3, audioChapters: 0, summaries: 1 },
      },
      {
        id: 'v-text-es',
        language: Language.es,
        type: BookType.text,
        isFree: true,
        seoId: 2,
        _count: { chapters: 4, audioChapters: 0, summaries: 1 },
      },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's2' });
    prisma.seo.findMany.mockResolvedValue([
      { id: 1, metaTitle: 'T-any', metaDescription: 'D-any' },
      { id: 2, metaTitle: 'T-any', metaDescription: 'D-any' },
    ]);

    const res = await service.getOverview('book-3', 'es');
    expect(res.versionIds.text).toBe('v-text-es');
  });

  /**
   * 🔴 `LEGACY-104`. Редирект не должен подставлять в адрес строку `undefined`.
   *
   * `resolveRequestedLanguage` отдаёт `undefined`, когда задан `available`
   * и в нём нет ни запрошенного языка, ни `DEFAULT_LANGUAGE`
   * (`language.util.ts:66`). Здесь ровно этот вход: книга издана на `es`
   * и `fr`, дефолт `en`, запрошен путь `/pt/`. До правки адрес собирался как
   * `/api/undefined/books/<slug>/overview` — и объявлялся `public, s-maxage=300`,
   * то есть битый 301 уходил в общий кэш на 300 секунд плюс час
   * `stale-while-revalidate`.
   *
   * Проверяется **цель редиректа целиком**, а не отсутствие подстроки
   * `undefined`: вторая форма зелена и на адресе, собранном не тем языком.
   */
  it('редирект не подставляет undefined, когда язык не определился', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b4', slug: 'book-4' });
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-text-es',
        slug: 'libro-4',
        language: Language.es,
        type: BookType.text,
        isFree: true,
        seoId: 1,
        _count: { chapters: 3, audioChapters: 0, summaries: 0 },
      },
      {
        id: 'v-text-fr',
        slug: 'livre-4',
        language: Language.fr,
        type: BookType.text,
        isFree: true,
        seoId: 2,
        _count: { chapters: 3, audioChapters: 0, summaries: 0 },
      },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue(null);
    prisma.seo.findMany.mockResolvedValue([]);

    // `pt` — поддерживаемый язык, поэтому `isPathLang` внутри сервиса истинно
    // (`book.service.ts:266`), и собирается ветка адреса с префиксом — та же,
    // что у публичного кэшируемого `GET /:lang/books/:slug/overview`.
    const url = await service
      .getOverview('book-4', Language.pt)
      .then(() => null)
      .catch((error: RedirectException) => error.url);

    expect(url).toBe('/api/es/books/libro-4/overview');
  });

  /**
   * 🔴 `LEGACY-375`. Обе выборки версий читают один набор строк, и из него берётся
   * `versions[0]` — запасная версия, когда язык не определился (`book.service.ts`, `targetVersion`);
   * тот же массив уезжает наружу полем `versions`. `findMany` без `orderBy` не обещает
   * никакого порядка: он меняется после `UPDATE`, после `VACUUM`, при смене плана,
   * на реплике. С edge-кэшем, включённым 13.09.2026, первый пришедший заморозил бы
   * случайную из двух целей 301 на 300 секунд плюс час `stale-while-revalidate`.
   *
   * ⚠️ Проверка идёт **по аргументам вызова**, а не по порядку возвращённых строк:
   * `PrismaService` здесь заглушка, порядок задаёт мок, и наблюдать настоящую
   * сортировку юнитом нечем. `toHaveBeenCalledTimes` рядом обязателен — без него
   * `toHaveBeenNthCalledWith` зелен и тогда, когда одна из двух выборок исчезла.
   */
  it('обе выборки версий упорядочены по языку, иначе versions[0] недетерминирован', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b5', slug: 'book-5' });
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-text-en',
        slug: 'book-5',
        language: Language.en,
        type: BookType.text,
        isFree: true,
        seoId: 1,
        _count: { chapters: 1, audioChapters: 0, summaries: 0 },
      },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue(null);
    prisma.seo.findMany.mockResolvedValue([]);

    await service.getOverview('book-5', Language.en);

    expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.bookVersion.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ orderBy: { language: 'asc' } }),
    );
    expect(prisma.bookVersion.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ orderBy: { language: 'asc' } }),
    );
  });

  /**
   * 🔴 `LEGACY-375`, вторая половина. Слаг версии уникален только в паре с языком
   * (`@@unique([language, slug])`), поэтому один слаг законно принадлежит версиям разных
   * книг на разных языках. Голый `findFirst` отдавал любую из них — и `bookId`, из которого
   * собирается весь обзор и цель 301, выбирался произвольно.
   *
   * ⚠️ Как и в тесте выше, проверка идёт по аргументам вызова: `PrismaService` — заглушка,
   * какую строку вернул бы Postgres, юнитом не наблюдаемо. `toHaveBeenCalledTimes` рядом
   * обязателен (`L-005`).
   */
  it('слаг ищется сначала на языке пути — иначе bookId берётся у чужой книги', async () => {
    prisma.bookVersion.findFirst.mockResolvedValue({
      bookId: 'b-en',
      language: Language.en,
      id: 'v-en',
    });
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-en',
        slug: 'the-trial',
        language: Language.en,
        type: BookType.text,
        isFree: true,
        seoId: 1,
        _count: { chapters: 1, audioChapters: 0, summaries: 0 },
      },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue(null);
    prisma.seo.findMany.mockResolvedValue([]);

    const result = await service.getOverview('the-trial', Language.en);

    expect(result.id).toBe('b-en');
    expect(prisma.bookVersion.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.bookVersion.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { slug: 'the-trial', status: 'published', language: Language.en },
      }),
    );
  });

  /**
   * Обратная сторона той же правки: язык пути **предпочитается, а не требуется**.
   * Книга издана только на `es`, запрошен `/en/books/<es-slug>/overview` — точного
   * совпадения по языку нет, и поиск обязан повториться без него. Безусловное сужение
   * `where` языком отдало бы здесь 404 на живую книгу. Второй запрос при этом уже
   * упорядочен — он тоже может встретить один слаг у двух книг.
   */
  it('промах по языку не даёт 404: поиск повторяется без языка, но с orderBy', async () => {
    prisma.bookVersion.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bookId: 'b-es', language: Language.es, id: 'v-es' });
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-es',
        slug: 'el-proceso',
        language: Language.es,
        type: BookType.text,
        isFree: true,
        seoId: 1,
        _count: { chapters: 1, audioChapters: 0, summaries: 0 },
      },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue(null);
    prisma.seo.findMany.mockResolvedValue([]);

    const result = await service.getOverview('el-proceso', Language.en);

    expect(result.id).toBe('b-es');
    expect(prisma.bookVersion.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.bookVersion.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { slug: 'el-proceso', status: 'published' },
        orderBy: { language: 'asc' },
      }),
    );
  });

  /**
   * 🔴 LEGACY-005. Запрос без `select` выбирал бы все скаляры связи. Белый список здесь
   * не украшение: он — условие, при котором `DROP COLUMN` мёртвой `isPrimary` вообще
   * становится возможным, не ломая откат образа (`ADR-018`, класс 1).
   */
  it('категории обзора читаются белым списком, а не include', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'slug-1' });
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-text-en',
        language: Language.en,
        type: BookType.text,
        isFree: true,
        seoId: null,
        _count: { chapters: 1, audioChapters: 0, summaries: 0 },
      },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue(null);

    await service.getOverview('slug-1', Language.en);

    expect(prisma.bookCategory.findMany).toHaveBeenCalledTimes(1);
    const [args] = prisma.bookCategory.findMany.mock.calls[0] as [Record<string, unknown>];
    expect(args.include).toBeUndefined();
    expect(args.select).toEqual({
      categoryId: true,
      category: { include: { translations: true } },
    });
  });

  describe('rateBook', () => {
    it('throws NotFoundException if book does not exist', async () => {
      prisma.book.findUnique.mockResolvedValue(null);
      await expect(service.rateBook('u1', 'b-none', 5)).rejects.toThrow(NotFoundException);
    });

    it('upserts rating when book exists', async () => {
      prisma.book.findUnique.mockResolvedValue({ id: 'b1' });
      prisma.bookRating.upsert.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        bookId: 'b1',
        score: 5,
      });

      const res = await service.rateBook('u1', 'b1', 5);
      expect(res.score).toBe(5);
      expect(prisma.bookRating.upsert).toHaveBeenCalledWith({
        where: { userId_bookId: { userId: 'u1', bookId: 'b1' } },
        create: { userId: 'u1', bookId: 'b1', score: 5 },
        update: { score: 5 },
      });
    });
  });

  describe('getUserRating', () => {
    it('returns score when rating exists', async () => {
      prisma.bookRating.findUnique.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        bookId: 'b1',
        score: 4,
      });

      const res = await service.getUserRating('u1', 'b1');
      expect(res).toEqual({ score: 4 });
      expect(prisma.bookRating.findUnique).toHaveBeenCalledWith({
        where: { userId_bookId: { userId: 'u1', bookId: 'b1' } },
      });
    });

    it('returns null score when rating does not exist', async () => {
      prisma.bookRating.findUnique.mockResolvedValue(null);

      const res = await service.getUserRating('u1', 'b1');
      expect(res).toEqual({ score: null });
    });
  });

  describe('findAll', () => {
    it('returns list of books with ratings, hasText, hasAudio, hasSummary flags', async () => {
      prisma.book.count.mockResolvedValue(1);
      prisma.book.findMany.mockResolvedValue([
        {
          id: 'b1',
          slug: 'slug-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          versions: [
            {
              id: 'v1',
              language: Language.en,
              type: BookType.text,
              status: 'published',
              _count: { chapters: 5, audioChapters: 2, summaries: 1 },
            },
          ],
        },
      ]);

      const res = await service.findAll({ page: 1, limit: 10 });

      expect(res.meta.total).toBe(1);
      expect(res.data[0].id).toBe('b1');
      expect(res.data[0].hasText).toBe(true);
      expect(res.data[0].hasAudio).toBe(true);
      expect(res.data[0].hasSummary).toBe(true);
    });

    it('sets hasText/hasAudio to false if no chapters or drafts only', async () => {
      prisma.book.count.mockResolvedValue(1);
      prisma.book.findMany.mockResolvedValue([
        {
          id: 'b2',
          slug: 'slug-2',
          createdAt: new Date(),
          updatedAt: new Date(),
          versions: [
            {
              id: 'v2',
              language: Language.en,
              type: BookType.text,
              status: 'draft',
              _count: { chapters: 5, audioChapters: 2, summaries: 1 },
            },
            {
              id: 'v3',
              language: Language.es,
              type: BookType.referral,
              status: 'published',
              _count: { chapters: 0, audioChapters: 0, summaries: 0 },
            },
          ],
        },
      ]);

      const res = await service.findAll({ page: 1, limit: 10 });

      expect(res.data[0].hasText).toBe(false);
      expect(res.data[0].hasAudio).toBe(false);
      expect(res.data[0].hasSummary).toBe(false);
    });
  });

  describe('findCards', () => {
    let service: BookService;
    let adminAudit: { record: jest.Mock };
    let prisma: PrismaStub;

    const mockVersion = (overrides: Record<string, unknown> = {}) => ({
      id: (overrides.id as string) ?? 'v1',
      bookId: (overrides.bookId as string) ?? 'b1',
      slug: (overrides.slug as string) ?? 'test-book',
      title: (overrides.title as string) ?? 'Test Book',
      author: (overrides.author as string) ?? 'Test Author',
      authorId: (overrides.authorId as string | null) ?? 'a1',
      coverImageUrl: (overrides.coverImageUrl as string | null) ?? 'https://example.com/cover.jpg',
      type: (overrides.type as BookType) ?? BookType.text,
      publishedAt: (overrides.publishedAt as Date | null) ?? new Date('2024-01-01'),
      language: (overrides.language as Language) ?? Language.en,
      status: (overrides.status as string) ?? 'published',
      _count: {
        chapters: (overrides.chapters as number) ?? 5,
        audioChapters: (overrides.audioChapters as number) ?? 0,
      },
      categories: (overrides.categories as { categoryId: string }[]) ?? [{ categoryId: 'c1' }],
    });

    beforeEach(() => {
      prisma = createPrismaStub();
      adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
      service = new BookService(
        prisma as unknown as PrismaService,
        createGeoBlockRuleServiceStub(),
        new RelatedTaxonomyService(prisma as unknown as PrismaService),
        createSlugRedirectStub(),
        createModeratorRolesStub(),
        // LEGACY-006: настоящий AuthorService на том же стабе prisma — добор слагов
        // по-прежнему управляется моками `authorTranslation.findMany`.
        new AuthorService(
          prisma as unknown as PrismaService,
          {} as unknown as SlugRedirectService,
          // `LEGACY-015`, пачка `T21`: писатель журнала обязателен по конструктору, но этот
          // файл удаление автора не трогает вовсе — `record` здесь не зовётся ни разу.
          { record: jest.fn() } as unknown as AdminAuditService,
        ),
        adminAudit as unknown as AdminAuditService,
      );
    });

    /** Порядок запросов: счёт, страница, дальше карточки. */
    const mockOneCard = () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([{ bookId: 'b1' }]);
      prisma.bookRating.groupBy.mockResolvedValue([]);
    };

    it('returns paginated compact cards with default sort', async () => {
      mockOneCard();
      prisma.bookVersion.findMany
        .mockResolvedValueOnce([mockVersion()])
        .mockResolvedValueOnce([{ authorId: 'a1', language: 'en', slug: 'test-author' }]);

      const res = await service.findCards(Language.en);

      expect(res.items).toHaveLength(1);
      expect(res.items[0].title).toBe('Test Book');
      expect(res.pagination.total).toBe(1);
      expect(res.pagination.page).toBe(1);
    });

    /**
     * Фильтр проверяется на **счётном** запросе: набор условий в `findCards` один
     * на счёт и на страницу, и именно счёт решает, дойдёт ли запрос за страницей
     * до базы вообще (`skip >= total`). Набор условий страницы стережёт
     * `book.service.query-count.spec.ts`.
     */
    it('applies type=audio filter', async () => {
      mockOneCard();
      prisma.bookVersion.findMany
        .mockResolvedValueOnce([mockVersion({ audioChapters: 3 })])
        .mockResolvedValueOnce([{ authorId: 'a1', language: 'en', slug: 'test-author' }]);

      await service.findCards(Language.en, 1, 24, undefined, 'audio');

      const countSql = renderSql(prisma.$queryRaw.mock.calls[0] as unknown[]);
      expect(countSql).toContain('bv.language = ?::"Language"');
      expect(countSql).toContain(`bv.status = 'published'::"PublicationStatus"`);
      expect(countSql).toContain('EXISTS (SELECT 1 FROM "AudioChapter"');
      expect(countSql).not.toContain('"Chapter" ch');
    });

    it('applies type=text filter', async () => {
      mockOneCard();
      prisma.bookVersion.findMany
        .mockResolvedValueOnce([mockVersion({ chapters: 3 })])
        .mockResolvedValueOnce([{ authorId: 'a1', language: 'en', slug: 'test-author' }]);

      await service.findCards(Language.en, 1, 24, undefined, 'text');

      const countSql = renderSql(prisma.$queryRaw.mock.calls[0] as unknown[]);
      expect(countSql).toContain('EXISTS (SELECT 1 FROM "Chapter"');
      expect(countSql).toContain(`bv.type = 'text'::"BookType"`);
    });

    it('applies q search filter', async () => {
      mockOneCard();
      prisma.bookVersion.findMany
        .mockResolvedValueOnce([mockVersion({ title: 'Hamlet' })])
        .mockResolvedValueOnce([{ authorId: 'a1', language: 'en', slug: 'test-author' }]);

      await service.findCards(Language.en, 1, 24, undefined, undefined, 'hamlet');

      const countCall = prisma.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
      const countSql = renderSql(countCall as unknown[]);
      expect(countSql).toContain('bv.title ILIKE');
      expect(countSql).toContain('bv.author ILIKE');
      // Значение уходит параметром, а не склейкой в текст запроса.
      expect(countSql).not.toContain('hamlet');
      const whereSql = countCall[1] as { values: unknown[] };
      expect(whereSql.values).toEqual(expect.arrayContaining(['hamlet']));
    });

    it('returns empty items when no books match', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ total: 0 }]);
      prisma.bookVersion.findMany.mockResolvedValue([]);

      const res = await service.findCards(Language.en, 1, 24, undefined, 'audio');

      expect(res.items).toHaveLength(0);
      expect(res.pagination.total).toBe(0);
      // За страницей пустого каталога в базу не ходим вовсе: только счёт.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('enforces max limit of 48', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ total: 100 }]).mockResolvedValueOnce([]);
      prisma.bookVersion.findMany.mockResolvedValue([]);

      await service.findCards(Language.en, 1, 999);

      // Два последних значения тегированного шаблона — `LIMIT` и `OFFSET`.
      const pageCall = prisma.$queryRaw.mock.calls[1] as unknown[];
      expect(pageCall.slice(-2)).toEqual([48, 0]);
    });
  });

  /**
   * `LEGACY-253`. Оба блока `findRelated` звали `comparePublishedAtDesc(b, a)` —
   * с переставленными аргументами. Функция, названная `Desc`, из-за этого
   * упорядочивала `publishedAt` по возрастанию, а книги без даты ставила
   * в начало блока.
   *
   * 🔴 Блока два, и они независимы: `similarSorted` (подбор по совпадающим категориям)
   * и `fallbackSorted` (добор до `limit`). Одна спека, покрывающая только второй,
   * оставляет первый без посадки: возврат перестановки в нём не покрасит ничего.
   * Поэтому здесь два кейса с разной подготовкой — с категориями и без.
   */
  describe('findRelated: порядок при равных рейтингах (LEGACY-253)', () => {
    let service: BookService;
    let adminAudit: { record: jest.Mock };
    let prisma: PrismaStub;

    const relatedVersion = (bookId: string, publishedAt: Date | null) => ({
      id: `v-${bookId}`,
      bookId,
      slug: bookId,
      title: bookId,
      author: 'A',
      authorId: null,
      coverImageUrl: '',
      type: BookType.text,
      publishedAt,
      _count: { chapters: 1, audioChapters: 0 },
      categories: [],
    });

    /** Порядок нарочно перемешан: правильный ответ не должен совпадать с порядком базы. */
    const shuffled = () => [
      relatedVersion('undated', null),
      relatedVersion('older', new Date('2020-01-01T00:00:00Z')),
      relatedVersion('newer', new Date('2024-01-01T00:00:00Z')),
    ];

    beforeEach(() => {
      prisma = createPrismaStub();
      adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
      service = new BookService(
        prisma as unknown as PrismaService,
        createGeoBlockRuleServiceStub(),
        new RelatedTaxonomyService(prisma as unknown as PrismaService),
        createSlugRedirectStub(),
        createModeratorRolesStub(),
        // LEGACY-006: настоящий AuthorService на том же стабе prisma — добор слагов
        // по-прежнему управляется моками `authorTranslation.findMany`.
        new AuthorService(
          prisma as unknown as PrismaService,
          {} as unknown as SlugRedirectService,
          // `LEGACY-015`, пачка `T21`: писатель журнала обязателен по конструктору, но этот
          // файл удаление автора не трогает вовсе — `record` здесь не зовётся ни разу.
          { record: jest.fn() } as unknown as AdminAuditService,
        ),
        adminAudit as unknown as AdminAuditService,
      );

      prisma.bookVersion.findFirst
        .mockResolvedValueOnce({ bookId: 'cur', author: 'A', authorId: null })
        .mockResolvedValueOnce({ id: 'v-cur' });

      // Оценка у всех трёх одна: весь порядок решает второй ключ.
      prisma.bookRating.groupBy.mockResolvedValue(
        ['undated', 'older', 'newer'].map((bookId) => ({
          bookId,
          _avg: { score: 4 },
          _count: { score: 1 },
        })),
      );
    });

    /**
     * 🔴 `LEGACY-375`, третье место того же класса. Когда версии на запрошенном языке нет,
     * `findRelated` ищет книгу по слагу «на любом языке». Слаг версии уникален лишь в паре
     * с языком, поэтому такой поиск без `orderBy` мог отдать версию **другой** книги —
     * и подборка похожих собиралась бы вокруг неё. Маршрут `GET /:lang/books/:slug/related`
     * кэшируется публично, то есть случайный исход замерзал бы на 300 секунд плюс час.
     *
     * ⚠️ Проверка по аргументам вызова: `PrismaService` — заглушка, настоящий порядок строк
     * юнитом не наблюдаем. `toHaveBeenCalledTimes` рядом обязателен (`L-005`).
     */
    it('запасной поиск книги по слагу упорядочен по языку', async () => {
      prisma.bookVersion.findFirst.mockReset();
      prisma.bookVersion.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ bookId: 'cur' })
        .mockResolvedValueOnce({ author: 'A', authorId: null })
        .mockResolvedValueOnce({ id: 'v-cur' });
      prisma.bookCategory.findMany.mockResolvedValue([]);
      prisma.bookVersion.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(shuffled());

      await service.findRelated('cur-slug', Language.en);

      expect(prisma.bookVersion.findFirst).toHaveBeenCalledTimes(4);
      expect(prisma.bookVersion.findFirst).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { slug: 'cur-slug', status: 'published' },
          orderBy: { language: 'asc' },
        }),
      );
    });

    /**
     * У книги нет категорий, поэтому подбор по совпадению не запускается и весь блок
     * `similar` собирается запасным набором — это `fallbackSorted`.
     */
    it('запасной набор: сначала самая свежая, книга без даты последней', async () => {
      prisma.bookCategory.findMany.mockResolvedValue([]);
      // Первый findMany — блок «того же автора», он пуст; второй — запасной набор.
      prisma.bookVersion.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(shuffled());

      const res = await service.findRelated('cur-slug', Language.en);

      expect(res.similar.map((card) => card.slug)).toEqual(['newer', 'older', 'undated']);
      // Без счётчика кейс зелен и на коде, где запасной набор берётся лишним третьим
      // вызовом, а проверенный второй остаётся мёртвым.
      expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.bookCategory.findMany).toHaveBeenCalledTimes(1);
    });

    /**
     * У книги есть категория, и все три кандидата совпадают с ней ровно один раз:
     * `matched` у всех равен единице, рейтинг общий — порядок опять решает второй ключ,
     * но уже в блоке `similarSorted`. Запасной набор при этом не запрашивается вовсе.
     */
    it('подбор по категориям: сначала самая свежая, книга без даты последней', async () => {
      prisma.bookCategory.findMany
        .mockResolvedValueOnce([{ categoryId: 'c1' }])
        .mockResolvedValueOnce(
          shuffled().map((version) => ({ bookVersion: version, categoryId: 'c1' })),
        );
      // Оба набора пусты: и «тот же автор», и запасной. Все три карточки блока
      // `similar` приходят подбором по категориям — значит и порядок в них его.
      prisma.bookVersion.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const res = await service.findRelated('cur-slug', Language.en);

      expect(res.similar.map((card) => card.slug)).toEqual(['newer', 'older', 'undated']);
      expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * 🔴 `LEGACY-320`, пачка `T32`. Старый слаг для редиректа берётся из строки, запертой
 * `FOR NO KEY UPDATE` внутри транзакции, а не из чтения на пуле: иначе встречная смена слага,
 * закоммиченная между ними, остаётся без редиректа. Живая гонка — в
 * `test/slug-redirect-row-lock.e2e-spec.ts`; здесь порядок и ветка пустого замка.
 */
describe('BookService.update (LEGACY-320)', () => {
  let service: BookService;
  let adminAudit: { record: jest.Mock };
  let prisma: PrismaStub;
  let slugRedirects: {
    record: jest.Mock;
    recordBaseSlugChange: jest.Mock;
    resolve: jest.Mock;
    cleanupDeadRedirects: jest.Mock;
  };

  beforeEach(() => {
    prisma = createPrismaStub();
    adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
    slugRedirects = createSlugRedirectStub() as unknown as typeof slugRedirects;
    service = new BookService(
      prisma as unknown as PrismaService,
      createGeoBlockRuleServiceStub(),
      new RelatedTaxonomyService(prisma as unknown as PrismaService),
      slugRedirects as unknown as SlugRedirectService,
      createModeratorRolesStub(),
      // LEGACY-006: настоящий AuthorService на том же стабе prisma — добор слагов
      // по-прежнему управляется моками `authorTranslation.findMany`.
      new AuthorService(
        prisma as unknown as PrismaService,
        {} as unknown as SlugRedirectService,
        // `LEGACY-015`, пачка `T21`: писатель журнала обязателен по конструктору, но этот
        // файл удаление автора не трогает вовсе — `record` здесь не зовётся ни разу.
        { record: jest.fn() } as unknown as AdminAuditService,
      ),
      adminAudit as unknown as AdminAuditService,
    );
  });

  it('locks the book row first and records the redirect from the locked slug', async () => {
    const order: string[] = [];
    prisma.$queryRaw.mockImplementation((...call: unknown[]) => {
      order.push('lock');
      // Сила — `FOR NO KEY UPDATE`: вставки версий, лайков и оценок по FK не ждут PATCH
      // (решение арбитра 25.09.2026). `FOR UPDATE` здесь — регресс, а не «надёжнее».
      expect(renderSql(call)).toContain('FOR NO KEY UPDATE');
      return Promise.resolve([{ slug: 'committed-meanwhile' }]);
    });
    slugRedirects.recordBaseSlugChange.mockImplementation(() => {
      order.push('redirect');
      return Promise.resolve();
    });
    prisma.book.update.mockImplementation(() => {
      order.push('write');
      return Promise.resolve({ id: 'b1', slug: 'new-slug' });
    });

    await service.update('b1', { slug: 'new-slug' });

    expect(order).toEqual(['lock', 'redirect', 'write']);
    // Чтения на пуле больше нет: слаг берётся только из запертой строки.
    expect(prisma.book.findUnique).not.toHaveBeenCalled();
    expect(slugRedirects.recordBaseSlugChange).toHaveBeenCalledWith(
      'book',
      'committed-meanwhile',
      'new-slug',
      prisma,
    );
  });

  it('writes no redirect when the locked slug already equals the requested one', async () => {
    prisma.$queryRaw.mockResolvedValue([{ slug: 'same' }]);
    prisma.book.update.mockResolvedValue({ id: 'b1', slug: 'same' });

    await service.update('b1', { slug: 'same' });

    expect(slugRedirects.recordBaseSlugChange).not.toHaveBeenCalled();
    expect(prisma.book.update).toHaveBeenCalledTimes(1);
    expect(prisma.book.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { slug: 'same' },
    });
  });

  it('answers 404, not 500, when the lock finds no book row', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(service.update('b1', { slug: 'b' })).rejects.toThrow(NotFoundException);
    expect(slugRedirects.recordBaseSlugChange).not.toHaveBeenCalled();
    expect(prisma.book.update).not.toHaveBeenCalled();
  });
});

describe('BookService.remove (LEGACY-395)', () => {
  let service: BookService;
  let adminAudit: { record: jest.Mock };
  let prisma: PrismaStub;
  let slugRedirects: {
    record: jest.Mock;
    recordBaseSlugChange: jest.Mock;
    resolve: jest.Mock;
    cleanupDeadRedirects: jest.Mock;
  };

  beforeEach(() => {
    prisma = createPrismaStub();
    adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
    slugRedirects = createSlugRedirectStub() as unknown as typeof slugRedirects;
    service = new BookService(
      prisma as unknown as PrismaService,
      createGeoBlockRuleServiceStub(),
      new RelatedTaxonomyService(prisma as unknown as PrismaService),
      slugRedirects as unknown as SlugRedirectService,
      createModeratorRolesStub(),
      // LEGACY-006: настоящий AuthorService на том же стабе prisma — добор слагов
      // по-прежнему управляется моками `authorTranslation.findMany`.
      new AuthorService(
        prisma as unknown as PrismaService,
        {} as unknown as SlugRedirectService,
        // `LEGACY-015`, пачка `T21`: писатель журнала обязателен по конструктору, но этот
        // файл удаление автора не трогает вовсе — `record` здесь не зовётся ни разу.
        { record: jest.fn() } as unknown as AdminAuditService,
      ),
      adminAudit as unknown as AdminAuditService,
    );
  });

  it('cleans up the redirect in every language when no live version holds the slug anywhere', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'karamazovy' });
    prisma.book.delete.mockResolvedValue({ id: 'b1', slug: 'karamazovy' });
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'b1' }]).mockResolvedValueOnce([]);
    // Ни одной опубликованной версии с этим слагом не осталось нигде — адрес
    // мёртв во всех языках (фоллбэк `getOverview` языконезависим).
    prisma.bookVersion.findFirst.mockResolvedValue(null);

    const res = await service.remove('b1', 'admin-1');

    expect(res.id).toBe('b1');
    expect(prisma.book.delete).toHaveBeenCalledWith({ where: { id: 'b1' } });
    expect(prisma.bookVersion.findFirst).toHaveBeenCalledWith({
      where: {
        slug: 'karamazovy',
        status: 'published',
        language: { in: Object.values(Language) },
      },
      select: { id: true },
    });
    expect(slugRedirects.cleanupDeadRedirects).toHaveBeenCalledTimes(1);
    const [entityType, deadLanguages, deadSlug] = slugRedirects.cleanupDeadRedirects.mock.calls[0];
    expect(entityType).toBe('book');
    expect(deadSlug).toBe('karamazovy');
    expect(deadLanguages).toEqual(Object.values(Language));
  });

  it('skips cleanup in every language when another live published version anywhere still holds the slug', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'karamazovy' });
    prisma.book.delete.mockResolvedValue({ id: 'b1', slug: 'karamazovy' });
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'b1' }]).mockResolvedValueOnce([]);
    // Версия другой книги в любом (здесь — английском) языке по-прежнему
    // отвечает по этому слову: `getOverview` находит её без фильтра по языку
    // и оживляет адрес сразу во всех пяти — не только в `en`.
    prisma.bookVersion.findFirst.mockResolvedValue({ id: 'other-version' });

    await service.remove('b1', 'admin-1');

    expect(slugRedirects.cleanupDeadRedirects).not.toHaveBeenCalled();
  });

  it('throws NotFoundException and cleans up nothing when the book does not exist', async () => {
    prisma.book.findUnique.mockResolvedValue(null);

    await expect(service.remove('missing', 'admin-1')).rejects.toThrow(NotFoundException);
    expect(prisma.book.delete).not.toHaveBeenCalled();
    expect(slugRedirects.cleanupDeadRedirects).not.toHaveBeenCalled();
    // `LEGACY-015`: несостоявшееся удаление журнала не касается — событие пишется
    // только на изменение состояния (инвариант модели `AdminAuditEvent`).
    expect(adminAudit.record).not.toHaveBeenCalled();
  });

  /**
   * `LEGACY-015`, пачка `T19`. Посадка на журнал удаления книги. Событие на саму
   * книгу пишется всегда, а `VERSION_DELETED` — на каждую версию, которую унёс
   * каскад: без второй половины журнал врёт ровно так, как врал до `V1` про роли
   * удалённого пользователя (решение арбитра 20.09.2026).
   */
  it('records BOOK_DELETED and VERSION_DELETED for every version the cascade takes', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'karamazovy' });
    prisma.book.delete.mockResolvedValue({ id: 'b1', slug: 'karamazovy' });
    // Версии приходят замком `lockLicenseSnapshotsByBook`, то есть через `$queryRaw`:
    // первый вызов — замок книги, второй — снимки версий.
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'b1' }]).mockResolvedValueOnce([
      {
        id: 'v-ru',
        language: 'ru',
        status: 'published',
        publishedAt: new Date('2026-09-01T00:00:00.000Z'),
        rightsLicenseIds: ['lic-A'],
        rightsLicenseCoverageStatus: 'FULL',
        rightsLicenseCheckedAt: new Date('2026-09-02T00:00:00.000Z'),
        rightsLicenseUncoveredCountryCodes: [],
      },
      {
        id: 'v-en',
        language: 'en',
        status: 'draft',
        publishedAt: null,
        rightsLicenseIds: null,
        rightsLicenseCoverageStatus: null,
        rightsLicenseCheckedAt: null,
        rightsLicenseUncoveredCountryCodes: null,
      },
    ]);
    prisma.bookVersion.findFirst.mockResolvedValue(null);

    await service.remove('b1', 'admin-1');

    expect(adminAudit.record).toHaveBeenCalledTimes(3);

    const [bookCall, ruCall, enCall] = adminAudit.record.mock.calls;
    expect(bookCall[1]).toEqual({
      action: 'BOOK_DELETED',
      targetType: 'BOOK',
      targetId: 'b1',
      actorUserId: 'admin-1',
      payload: { slug: 'karamazovy', versionCount: 2 },
    });
    expect(ruCall[1]).toEqual({
      action: 'VERSION_DELETED',
      targetType: 'BOOK_VERSION',
      targetId: 'v-ru',
      actorUserId: 'admin-1',
      // Снимок лицензий в составе — требование ревью 20.09.2026: после каскада
      // ответить, на что опиралась публикация стёртой версии, больше нечем.
      payload: {
        bookId: 'b1',
        language: 'ru',
        status: 'published',
        cascade: true,
        publishedAt: '2026-09-01T00:00:00.000Z',
        rightsLicenseIds: ['lic-A'],
        rightsLicenseCoverageStatus: 'FULL',
        rightsLicenseCheckedAt: '2026-09-02T00:00:00.000Z',
        rightsLicenseUncoveredCountryCodes: [],
      },
    });
    expect(enCall[1].targetId).toBe('v-en');
    expect(enCall[1].payload).toMatchObject({ cascade: true });
  });

  /**
   * Идентификаторы версий обязаны читаться **до** `book.delete`: после каскада
   * взять их негде, и журнал промолчал бы о каждой снесённой версии.
   */
  /**
   * Два замка — единственное, что держит список каскадных версий совпадающим с тем,
   * что реально снесёт каскад. Снять любую из двух строк при рефакторинге ничего
   * не мешает, а ни один прогон этого не замечал: e2e однопоточна, а юнит смотрел
   * только порядок чтения и удаления. Обе дыры и сама посадка — круг 2 ревью
   * 20.09.2026.
   *
   * Замок книги закрывает встречную вставку версии (через `FOR KEY SHARE`
   * по внешнему ключу), замок строк версий — встречные изменение и удаление
   * уже существующих.
   */
  it('locks the book row, then its version rows, and only then deletes', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'karamazovy' });
    const order: string[] = [];
    prisma.$queryRaw.mockImplementation((...call: unknown[]) => {
      const sql = renderSql(call);
      order.push(sql.includes('"BookVersion"') ? 'lock:versions' : 'lock:book');
      return Promise.resolve(sql.includes('"BookVersion"') ? [] : [{ id: 'b1' }]);
    });
    prisma.book.delete.mockImplementation(() => {
      order.push('delete');
      return Promise.resolve({ id: 'b1', slug: 'karamazovy' });
    });
    prisma.bookVersion.findFirst.mockResolvedValue(null);

    await service.remove('b1', 'admin-1');

    expect(order).toEqual(['lock:book', 'lock:versions', 'delete']);

    const bookLock = renderSql(prisma.$queryRaw.mock.calls[0] as unknown[]);
    expect(bookLock).toContain('"Book"');
    expect(bookLock).toContain('FOR UPDATE');

    const versionLock = renderSql(prisma.$queryRaw.mock.calls[1] as unknown[]);
    expect(versionLock).toContain('"BookVersion"');
    expect(versionLock).toContain('"bookId"');
    expect(versionLock).toContain('FOR UPDATE');
  });

  /**
   * Книгу снёс встречный запрос, пока мы ждали замка: замок вернул ноль строк.
   * Без этой ветки `book.delete` отдал бы `P2025`, а наружу ушло бы 500 вместо 404 —
   * глобального фильтра Prisma в проекте нет (находка круга 2 ревью).
   */
  it('answers 404, not 500, when the book vanished while we waited for the lock', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'karamazovy' });
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(service.remove('b1', 'admin-1')).rejects.toThrow(NotFoundException);
    expect(prisma.book.delete).not.toHaveBeenCalled();
    expect(adminAudit.record).not.toHaveBeenCalled();
  });

  /**
   * Актёр объявлен без умолчания намеренно (ревью 20.09.2026): вызов без него
   * не компилируется, и это единственная машинная гарантия, что исполнитель доехал
   * до журнала. Здесь проверяется вторая половина — `null` передан осознанно
   * (фоновый снос, скрипт), и молчать про удаление всё равно нельзя.
   */
  it('records the deletion with a null actor when the caller has none', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'karamazovy' });
    prisma.book.delete.mockResolvedValue({ id: 'b1', slug: 'karamazovy' });
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'b1' }]).mockResolvedValueOnce([]);
    prisma.bookVersion.findFirst.mockResolvedValue(null);

    await service.remove('b1', null);

    expect(adminAudit.record).toHaveBeenCalledTimes(1);
    expect(adminAudit.record.mock.calls[0][1]).toMatchObject({ actorUserId: null });
  });
});
