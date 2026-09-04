import { TagsService } from './tags.service';
import { TagLockService } from './tag-lock.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyIndexabilityService } from '../seo/indexability/taxonomy-indexability.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { Language } from '@prisma/client';

interface PrismaStub {
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
  tag: { findUnique: jest.Mock; findFirst: jest.Mock; count: jest.Mock; findMany: jest.Mock };
  tagTranslation: { findUnique: jest.Mock; create: jest.Mock };
  bookVersion: { findMany: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
  bookTag: { findFirst: jest.Mock; create: jest.Mock; delete: jest.Mock };
  bookRating: { groupBy: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  tag: { findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  tagTranslation: { findUnique: jest.fn(), create: jest.fn() },
  bookVersion: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  bookTag: { findFirst: jest.fn(), create: jest.fn(), delete: jest.fn() },
  bookRating: { groupBy: jest.fn() },
});

describe('TagsService', () => {
  let service: TagsService;
  let prisma: PrismaStub;
  let indexability: { recomputeForTerms: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (tx: PrismaStub) => unknown) => cb(prisma as unknown as PrismaStub));
    indexability = { recomputeForTerms: jest.fn().mockResolvedValue(undefined) };
    service = new TagsService(
      prisma as unknown as PrismaService,
      {
        record: jest.fn().mockResolvedValue(undefined),
        resolve: jest.fn().mockResolvedValue(null),
      } as unknown as SlugRedirectService,
      new TagLockService(prisma as unknown as PrismaService),
      indexability as unknown as TaxonomyIndexabilityService,
    );
  });

  it('versionsByTagSlug filters by effective language and falls back to base slug', async () => {
    prisma.tagTranslation.findUnique.mockResolvedValue(null);
    prisma.tag.findFirst.mockResolvedValue({ id: 't1', name: 'Tag', slug: 'tag' });
    const now = new Date();
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-en',
        bookId: 'b1',
        language: Language.en,
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'u',
        type: 'text',
        isFree: true,
        referralUrl: null,
        createdAt: now,
        updatedAt: now,
        status: 'published',
        publishedAt: now,
        seoId: undefined,
        seo: null,
      },
      {
        id: 'v-es',
        bookId: 'b1',
        language: Language.es,
        title: 'T2',
        author: 'A',
        description: 'D',
        coverImageUrl: 'u',
        type: 'text',
        isFree: true,
        referralUrl: null,
        createdAt: now,
        updatedAt: now,
        status: 'published',
        publishedAt: now,
        seoId: undefined,
        seo: null,
      },
    ]);
    prisma.bookRating.groupBy.mockResolvedValue([]);

    const res = await service.versionsByTagSlug('tag', undefined, 'es, en;q=0.8');
    expect(res.availableLanguages.sort()).toEqual([Language.en, Language.es].sort());
    expect(res.versions).toHaveLength(1);
    expect(res.versions[0].language).toBe(Language.es);
    expect(res.tag.translation).toBeNull();
  });

  describe('list projects per-language indexability', () => {
    const translation = (
      language: Language,
      slug: string,
      bookCount: number,
      autoIndexable: boolean,
    ) => ({
      language,
      name: slug,
      slug,
      description: null,
      relatedTagSlugs: null,
      relatedGenreSlugs: null,
      relatedCategorySlugs: null,
      relatedCollectionSlugs: null,
      bookCount,
      autoIndexable,
    });

    beforeEach(() => {
      prisma.$transaction = jest
        .fn()
        .mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
      prisma.tag.count.mockResolvedValue(2);
      prisma.tag.findMany.mockResolvedValue([
        {
          id: 't1',
          name: 'Adventure',
          slug: 'adventure',
          key: 'adventure',
          indexable: true,
          isVisible: true,
          sortOrder: 0,
          translations: [
            translation(Language.en, 'adventure', 7, true),
            translation(Language.es, 'aventura', 2, false),
          ],
        },
        {
          id: 't2',
          name: 'Poetry',
          slug: 'poetry',
          key: 'poetry',
          indexable: true,
          isVisible: true,
          sortOrder: 1,
          translations: [translation(Language.en, 'poetry', 9, true)],
        },
      ]);
      prisma.$queryRaw.mockResolvedValue([{ tagId: 't1', booksCount: 2 }]);
    });

    it('takes autoIndexable from the requested language, not from another one', async () => {
      const res = await service.list(1, 20, undefined, Language.es);
      const tag = res.data.find((t) => t.id === 't1');

      expect(tag?.autoIndexable).toBe(false);
      expect(tag?.langBookCount).toBe(2);
    });

    it('leaves both fields undefined when lang is not passed', async () => {
      const res = await service.list(1, 20);

      expect(res.data[0].autoIndexable).toBeUndefined();
      expect(res.data[0].langBookCount).toBeUndefined();
    });

    it('leaves both fields undefined for a tag without a translation into lang', async () => {
      const res = await service.list(1, 20, undefined, Language.es);
      const tag = res.data.find((t) => t.id === 't2');

      expect(tag?.autoIndexable).toBeUndefined();
      expect(tag?.langBookCount).toBeUndefined();
    });

    it('keeps booksCount live and exposes per-translation indexability', async () => {
      const res = await service.list(1, 20, undefined, Language.es);
      const tag = res.data.find((t) => t.id === 't1');

      expect(tag?.booksCount).toBe(2);
      // The sitemap picks a translation by language and needs the same signal there.
      expect(tag?.translations).toEqual([
        expect.objectContaining({ language: Language.en, bookCount: 7, autoIndexable: true }),
        expect.objectContaining({ language: Language.es, bookCount: 2, autoIndexable: false }),
      ]);
    });

    // LEGACY-117. Проверяется именно **отсутствие вызова** `$queryRaw`: код, который
    // зовёт raw и глотает исключение, тоже вернёт пустой список.
    it('returns an empty page without touching $queryRaw when the page is out of range', async () => {
      prisma.tag.count.mockResolvedValue(42);
      prisma.tag.findMany.mockResolvedValue([]);
      prisma.$queryRaw.mockRejectedValue(new Error('$queryRaw must not be reached'));

      const res = await service.list(99, 20, undefined, Language.es);

      expect(res.data).toEqual([]);
      expect(res.meta).toEqual({ page: 99, limit: 20, total: 42, totalPages: 3 });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  /**
   * `LEGACY-199`, второй рубеж. `PublicTagBooksQueryDto` стережёт только вход через
   * контроллер, а метод публичный: второй его зов - из кода, из админского пути,
   * из копии соседнего маршрута - ушёл бы в `skip`/`take` с чем угодно. Спека зовёт
   * сервис **напрямую**, минуя пайп, - именно так, как это сделал бы такой зов.
   */
  describe('versionsByTagLangSlug: потолок и номер страницы вторым рубежом', () => {
    beforeEach(() => {
      prisma.tagTranslation.findUnique.mockResolvedValue({
        tag: { id: 't1', name: 'Tag', slug: 'tag', isVisible: true },
        seo: null,
        description: null,
      });
      prisma.bookVersion.findMany.mockResolvedValue([]);
      // Достаточно большой, чтобы страница не попала под короткий выход
      // `skip >= total` (`LEGACY-301`) — эти кейсы про потолок и клампинг
      // page/limit, а не про сам короткий выход, у него свои тесты ниже.
      prisma.bookVersion.count.mockResolvedValue(1000);
      prisma.bookRating.groupBy.mockResolvedValue([]);
    });

    const pageArgs = (): { skip: number; take: number } =>
      prisma.bookVersion.findMany.mock.calls[0][0] as { skip: number; take: number };

    it('limit выше потолка обрезается до потолка', async () => {
      const res = await service.versionsByTagLangSlug(Language.en, 'tag', 1, 1000);

      expect(pageArgs().take).toBe(48);
      // `meta` собирается из применённого значения: иначе потребитель поделит `total`
      // на запрошенный `limit` и насчитает страницы, которых нет.
      expect(res.meta.limit).toBe(48);
    });

    it('мусорные значения не уезжают в skip и take', async () => {
      const res = await service.versionsByTagLangSlug(Language.en, 'tag', Number.NaN, Number.NaN);

      expect(pageArgs()).toEqual(expect.objectContaining({ skip: 0, take: 1 }));
      expect(res.meta.page).toBe(1);
      expect(Number.isNaN(res.meta.totalPages)).toBe(false);
    });

    it('отрицательный номер страницы не даёт отрицательный skip', async () => {
      await service.versionsByTagLangSlug(Language.en, 'tag', -5, 10);

      expect(pageArgs().skip).toBe(0);
    });
  });

  /**
   * `LEGACY-301`. `page`, ведущий за пределы выдачи тега, заставлял базу
   * отсортировать всю выборку и отбросить её целиком: `LIMIT/OFFSET` режет
   * страницу **после** сортировки, поэтому стоимость с ростом `page` не падала.
   * Образец короткого выхода — `BookService.findCards` (`LEGACY-255`).
   */
  describe('versionsByTagLangSlug: короткий выход за пределами выдачи (LEGACY-301)', () => {
    beforeEach(() => {
      prisma.tagTranslation.findUnique.mockResolvedValue({
        tag: { id: 't1', name: 'Tag', slug: 'tag', isVisible: true },
        seo: null,
        description: null,
      });
      prisma.bookRating.groupBy.mockResolvedValue([]);
    });

    it('страница за total не ходит в базу за строками — только считает total', async () => {
      prisma.bookVersion.count.mockResolvedValue(5);
      // Единственный оставшийся зов `findMany` — независимый от страницы запрос
      // `availableLanguages`; если бы страничный запрос всё же ушёл, он вернул
      // бы этот же массив и тест остался бы зелёным по случайности, поэтому
      // проверяется именно число вызовов, а не форма ответа.
      prisma.bookVersion.findMany.mockResolvedValue([]);

      const res = await service.versionsByTagLangSlug(Language.en, 'tag', 4, 2);

      expect(prisma.bookVersion.count).toHaveBeenCalledTimes(1);
      expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.bookVersion.findMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ skip: expect.any(Number), take: expect.any(Number) }),
      );
      expect(res.data).toEqual([]);
      expect(res.meta).toEqual({ page: 4, limit: 2, total: 5, totalPages: 3 });
    });

    it('страница внутри выдачи по-прежнему идёт в базу за строками', async () => {
      prisma.bookVersion.count.mockResolvedValue(5);
      prisma.bookVersion.findMany.mockResolvedValue([]);

      await service.versionsByTagLangSlug(Language.en, 'tag', 1, 2);

      expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.bookVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 2 }),
      );
    });
  });

  it('attach is idempotent and checks existence', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    prisma.tag.findUnique.mockResolvedValue({ id: 't1' });
    prisma.bookTag.findFirst.mockResolvedValue({ id: 'link1' });
    const res = await service.attach('v1', 't1');
    expect(res).toEqual({ id: 'link1' });
    expect(prisma.bookTag.create).not.toHaveBeenCalled();
  });

  it('detach is idempotent when link absent', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    const res = await service.detach('v1', 't1');
    expect(res).toEqual({ success: true });
  });

  it('detaching a tag recomputes that term, not the version', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);

    await service.detach('v1', 't1');

    expect(indexability.recomputeForTerms).toHaveBeenCalledWith([], ['t1']);
  });

  it('attaching a tag recomputes that term', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    prisma.tag.findUnique.mockResolvedValue({ id: 't1' });
    prisma.bookTag.findFirst.mockResolvedValue(null);

    await service.attach('v1', 't1');

    expect(indexability.recomputeForTerms).toHaveBeenCalledWith([], ['t1']);
  });

  it('creates a translation that is not indexable until it earns it', async () => {
    prisma.tag.findUnique.mockResolvedValue({ id: 't1' });
    prisma.tagTranslation.create = jest.fn().mockResolvedValue({ id: 'tr1' });

    await service.createTranslation('t1', {
      language: Language.en,
      name: 'Adventure',
      slug: 'adventure',
    });

    expect(prisma.tagTranslation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bookCount: 0, autoIndexable: false }),
      }),
    );
  });
});
