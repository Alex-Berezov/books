import { Language } from '@prisma/client';
import { RelatedTaxonomyService } from './related-taxonomy.service';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * WP-9, `tasks/seo-noindex/PLAN.md`.
 *
 * Четыре массива `related*Slugs` рендерились на странице тега напрямую.
 * Замер на проде 09.08.2026 по `en`: из 1039 ссылок 114 вели на несуществующий
 * термин и 622 — на закрытый `noindex`; живыми были 303.
 */
describe('RelatedTaxonomyService', () => {
  const tagRow = (slug: string, over: Record<string, unknown> = {}) => ({
    slug,
    name: `Tag ${slug}`,
    bookCount: 7,
    autoIndexable: true,
    indexable: true,
    tag: { isVisible: true, indexable: true },
    ...over,
  });

  const catRow = (slug: string, type: string, over: Record<string, unknown> = {}) => ({
    slug,
    name: `Term ${slug}`,
    bookCount: 7,
    autoIndexable: true,
    category: { isVisible: true, indexable: true, type },
    ...over,
  });

  const prismaWith = (tags: unknown[], categories: unknown[]) =>
    ({
      tagTranslation: { findMany: jest.fn().mockResolvedValue(tags) },
      categoryTranslation: { findMany: jest.fn().mockResolvedValue(categories) },
    }) as unknown as PrismaService;

  const empty = { tags: [], genres: [], categories: [], collections: [] };

  it('resolves a slug into a term with its name', async () => {
    const service = new RelatedTaxonomyService(prismaWith([tagRow('power')], []));

    const res = await service.resolve(Language.en, { ...empty, tags: ['power'] });

    expect(res.tags).toHaveLength(1);
    expect(res.tags[0]).toMatchObject({ slug: 'power', name: 'Tag power', langBookCount: 7 });
  });

  // 🔴 Половина дефекта: слаг, которому не соответствует ни один термин, давал
  // живую ссылку в 404. Отдавать его наружу незачем — ссылки быть не может.
  it('drops a slug that matches no term', async () => {
    const service = new RelatedTaxonomyService(prismaWith([], []));

    const res = await service.resolve(Language.en, { ...empty, tags: ['does-not-exist'] });

    expect(res.tags).toEqual([]);
  });

  /**
   * 🔴 Вторая половина: вердикт здесь **не выносится**. Закрытый термин
   * возвращается со своими фактами, а решение принимает фронтовый
   * `isTaxonomyLinkable` — предикат обязан остаться в одном экземпляре.
   */
  it('returns a closed term with its facts instead of filtering it here', async () => {
    const service = new RelatedTaxonomyService(
      prismaWith([tagRow('closed', { autoIndexable: false, bookCount: 1 })], []),
    );

    const res = await service.resolve(Language.en, { ...empty, tags: ['closed'] });

    expect(res.tags).toHaveLength(1);
    expect(res.tags[0]).toMatchObject({ autoIndexable: false, langBookCount: 1 });
  });

  // `LEGACY-422`, `T73`: перевод тега, закрытый собственным флагом из админки, отдаётся
  // закрытым — иначе «похожие» соседа ведут на страницу с `noindex`.
  it('closes a tag term whose translation is not indexable', async () => {
    const findTags = jest
      .fn()
      .mockResolvedValue([tagRow('open'), tagRow('shut', { indexable: false })]);
    const prisma = {
      tagTranslation: { findMany: findTags },
      categoryTranslation: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const res = await new RelatedTaxonomyService(prisma).resolve(Language.es, {
      ...empty,
      tags: ['open', 'shut'],
    });

    expect(res.tags.map((t) => [t.slug, t.indexable])).toEqual([
      ['open', true],
      ['shut', false],
    ]);
    // Без поля в `select` база его не вернёт, и `tag && undefined` закроет все теги.
    expect(findTags).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ indexable: true }) }),
    );
  });

  // `LEGACY-422`, `T81` (решение арбитра 01.10.2026): `noindex` в поле Robots `Seo` перевода
  // закрывает «похожий» термин так же, как флаги, — и тег, и категорию/жанр/коллекцию.
  it('closes a term whose SEO Robots field says noindex', async () => {
    const findTags = jest
      .fn()
      .mockResolvedValue([
        tagRow('open', { seo: { robots: 'index, follow' } }),
        tagRow('shut', { seo: { robots: 'noindex, follow' } }),
      ]);
    const findCats = jest
      .fn()
      .mockResolvedValue([
        catRow('g-open', 'genre', { seo: null }),
        catRow('g-shut', 'genre', { seo: { robots: 'NONE' } }),
      ]);
    const prisma = {
      tagTranslation: { findMany: findTags },
      categoryTranslation: { findMany: findCats },
    } as unknown as PrismaService;

    const res = await new RelatedTaxonomyService(prisma).resolve(Language.en, {
      ...empty,
      tags: ['open', 'shut'],
      genres: ['g-open', 'g-shut'],
    });

    expect(res.tags.map((t) => [t.slug, t.indexable])).toEqual([
      ['open', true],
      ['shut', false],
    ]);
    expect(res.genres.map((t) => [t.slug, t.indexable])).toEqual([
      ['g-open', true],
      ['g-shut', false],
    ]);
    for (const find of [findTags, findCats]) {
      expect(find).toHaveBeenCalledTimes(1);
      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ seo: { select: { robots: true } } }),
        }),
      );
    }
  });

  /**
   * 🔴 Категории, жанры и коллекции лежат в одной таблице и в одном пространстве
   * слагов. Слаг жанра, записанный редактором в `relatedCategorySlugs`, дал бы
   * ссылку `/en/category/...` на термин, который на самом деле жанр, — то есть
   * снова живой 404, но уже не по вине данных.
   */
  it('does not let a genre slug through as a category', async () => {
    const service = new RelatedTaxonomyService(prismaWith([], [catRow('adventure', 'genre')]));

    const res = await service.resolve(Language.en, {
      ...empty,
      categories: ['adventure'],
      genres: ['adventure'],
    });

    expect(res.categories).toEqual([]);
    expect(res.genres).toHaveLength(1);
  });

  // Порядок задаёт редактор; пересортировка молча потеряла бы его приоритет.
  it('keeps the order the editor wrote', async () => {
    const service = new RelatedTaxonomyService(prismaWith([tagRow('second'), tagRow('first')], []));

    const res = await service.resolve(Language.en, { ...empty, tags: ['first', 'second'] });

    expect(res.tags.map((t) => t.slug)).toEqual(['first', 'second']);
  });

  // Пустой вход не должен идти в базу вовсе: резолвер вызывается на каждой
  // странице тега, а большинство тегов связей не имеет.
  it('does not query the database when there is nothing to resolve', async () => {
    const prisma = prismaWith([], []);
    const service = new RelatedTaxonomyService(prisma);

    await service.resolve(Language.en, empty);

    expect((prisma.tagTranslation.findMany as jest.Mock).mock.calls).toHaveLength(0);
    expect((prisma.categoryTranslation.findMany as jest.Mock).mock.calls).toHaveLength(0);
  });
});
