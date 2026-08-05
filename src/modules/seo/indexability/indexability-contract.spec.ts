import { Language } from '@prisma/client';
import { CategoryService } from '../../category/category.service';
import { TagsService } from '../../tags/tags.service';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * WP-7.1a — the field must actually reach the client.
 *
 * The frontend consistency tests pass on a broken contract: if `autoIndexable`
 * stops being sent, the predicate and the sitemap both fall back to the live
 * count and agree with each other while both being wrong. That is precisely how
 * У0 survived for months and ended in production advertising 2205 empty pages.
 *
 * So this asserts **presence of the key**, never its value, on every response the
 * frontend reads indexability from. Dropping the field from a `select`, a `map`
 * or a DTO turns these red — which is the only automated defence the original
 * defect has.
 */
const TRANSLATION_KEYS = ['bookCount', 'autoIndexable'] as const;

const categoryRow = {
  id: 'c1',
  name: 'Poetry',
  slug: 'poetry',
  key: 'poetry',
  type: 'genre',
  parentId: null,
  indexable: true,
  isVisible: true,
  sortOrder: 0,
  translations: [
    { language: Language.en, name: 'Poetry', slug: 'poetry', bookCount: 7, autoIndexable: true },
  ],
};

const tagRow = {
  id: 't1',
  name: 'Adventure',
  slug: 'adventure',
  key: 'adventure',
  indexable: true,
  isVisible: true,
  sortOrder: 0,
  translations: [
    {
      language: Language.en,
      name: 'Adventure',
      slug: 'adventure',
      description: null,
      relatedTagSlugs: null,
      relatedGenreSlugs: null,
      relatedCategorySlugs: null,
      relatedCollectionSlugs: null,
      bookCount: 7,
      autoIndexable: true,
    },
  ],
};

const prismaStub = () => {
  const stub = {
    $transaction: jest.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
    $queryRaw: jest.fn().mockResolvedValue([]),
    category: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([categoryRow]),
    },
    tag: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([tagRow]),
    },
  };
  return stub as unknown as PrismaService;
};

describe('indexability contract: autoIndexable reaches the client', () => {
  let categories: CategoryService;
  let tags: TagsService;

  beforeEach(() => {
    categories = new CategoryService(prismaStub());
    tags = new TagsService(prismaStub());
  });

  it.each(TRANSLATION_KEYS)(
    'GET /:lang/categories exposes %s on every translation',
    async (key) => {
      const res = await categories.list(1, 20, 'genre', Language.en);

      expect(res.data.length).toBeGreaterThan(0);
      for (const item of res.data) {
        for (const translation of item.translations) {
          expect(translation).toHaveProperty(key);
        }
      }
    },
  );

  it.each(TRANSLATION_KEYS)('GET /categories/tree exposes %s on every translation', async (key) => {
    const roots = await categories.getTree('genre', Language.en);

    expect(roots.length).toBeGreaterThan(0);
    for (const node of roots) {
      for (const translation of node.translations ?? []) {
        expect(translation).toHaveProperty(key);
      }
    }
  });

  it.each(TRANSLATION_KEYS)('GET /:lang/tags exposes %s on every translation', async (key) => {
    const res = await tags.list(1, 20, undefined, Language.en);

    expect(res.data.length).toBeGreaterThan(0);
    for (const item of res.data) {
      for (const translation of item.translations) {
        expect(translation).toHaveProperty(key);
      }
    }
  });

  it('projects autoIndexable onto the term itself when a language is requested', async () => {
    const list = await categories.list(1, 20, 'genre', Language.en);
    const tree = await categories.getTree('genre', Language.en);
    const tagList = await tags.list(1, 20, undefined, Language.en);

    expect(list.data[0]).toHaveProperty('autoIndexable');
    expect(list.data[0]).toHaveProperty('langBookCount');
    expect(tree[0]).toHaveProperty('autoIndexable');
    expect(tagList.data[0]).toHaveProperty('autoIndexable');
  });

  /**
   * The select is where the field is easiest to lose: removing it there leaves
   * every mapping and DTO untouched, so nothing else in the suite would notice.
   */
  it('asks the database for the fields it promises to return', async () => {
    const prisma = prismaStub();
    const service = new CategoryService(prisma);
    await service.getTree('genre', Language.en);

    const call = (prisma.category.findMany as unknown as jest.Mock).mock.calls[0][0] as {
      select: { translations: { select: Record<string, boolean> } };
    };
    expect(call.select.translations.select).toMatchObject({ bookCount: true, autoIndexable: true });
  });
});
