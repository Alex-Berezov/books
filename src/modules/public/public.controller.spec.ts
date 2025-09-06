/* eslint-disable */
import { PublicController } from './public.controller';
import { Language as PrismaLanguage } from '@prisma/client';

describe('PublicController (unit)', () => {
  const books = { getOverview: jest.fn() } as any;
  const pages = { getPublicBySlug: jest.fn() } as any;
  const categories = { getByLangSlugWithBooks: jest.fn() } as any;
  const tags = { versionsByTagLangSlug: jest.fn() } as any;

  const controller = new PublicController(books, pages, categories, tags);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('overview: uses path language (ignores query/header for language), passes header to service', async () => {
    books.getOverview.mockResolvedValueOnce({ ok: true });
    const res = await controller.overview(PrismaLanguage.en, 'some-slug', 'es', 'es-ES,fr;q=0.9');
    expect(res).toEqual({ ok: true });
    expect(books.getOverview).toHaveBeenCalledWith(
      'some-slug',
      PrismaLanguage.en,
      'es-ES,fr;q=0.9',
    );
  });

  it('getPage: delegates to pages with path language', async () => {
    pages.getPublicBySlug.mockResolvedValueOnce({ page: 1 });
    const res = await controller.getPage(PrismaLanguage.fr, 'p-slug');
    expect(res).toEqual({ page: 1 });
    expect(pages.getPublicBySlug).toHaveBeenCalledWith('p-slug', PrismaLanguage.fr);
  });

  it('categoriesBySlug: delegates to category service with path language', async () => {
    categories.getByLangSlugWithBooks.mockResolvedValueOnce({ items: [] });
    const res = await controller.categoriesBySlug(PrismaLanguage.es, 'cat');
    expect(res).toEqual({ items: [] });
    expect(categories.getByLangSlugWithBooks).toHaveBeenCalledWith(PrismaLanguage.es, 'cat');
  });

  it('tagsBySlug: delegates to tags service with path language', async () => {
    tags.versionsByTagLangSlug.mockResolvedValueOnce({ items: [] });
    const res = await controller.tagsBySlug(PrismaLanguage.pt, 'tag');
    expect(res).toEqual({ items: [] });
    expect(tags.versionsByTagLangSlug).toHaveBeenCalledWith(PrismaLanguage.pt, 'tag');
  });
});
