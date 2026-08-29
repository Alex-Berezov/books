/* eslint-disable */
import { PublicController } from './public.controller';
import { Language as PrismaLanguage } from '@prisma/client';

describe('PublicController (unit)', () => {
  const books = { getOverview: jest.fn() } as any;
  const pages = { getPublicBySlug: jest.fn() } as any;
  const categories = { getByLangSlugWithBooks: jest.fn() } as any;
  const tags = { versionsByTagLangSlug: jest.fn() } as any;
  const authors = {
    getPublicBySlug: jest.fn(),
    listPublic: jest.fn(),
    listPublicLetters: jest.fn(),
  } as any;
  const geoIpCountry = { resolveCountry: jest.fn().mockReturnValue(null) } as any;
  const slugRedirects = { resolve: jest.fn().mockResolvedValue(null) } as any;

  const controller = new PublicController(
    books,
    pages,
    categories,
    tags,
    authors,
    geoIpCountry,
    slugRedirects,
  );

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
    const res = await controller.tagsBySlug(PrismaLanguage.pt, 'tag', {});
    expect(res).toEqual({ items: [] });
    expect(tags.versionsByTagLangSlug).toHaveBeenCalledWith(
      PrismaLanguage.pt,
      'tag',
      undefined,
      undefined,
    );
  });

  /**
   * `LEGACY-199`. Разобранные `page`/`limit` обязаны доехать до сервиса: если
   * контроллер снова начнёт брать их из голого `@Query`, DTO соберётся, проверки
   * отработают, а в сервис уйдёт сырое значение — и маршрут вернётся к 500.
   */
  it('tagsBySlug: разобранные page и limit уходят в сервис', async () => {
    tags.versionsByTagLangSlug.mockResolvedValueOnce({ items: [] });
    await controller.tagsBySlug(PrismaLanguage.pt, 'tag', { page: 3, limit: 5 });
    expect(tags.versionsByTagLangSlug).toHaveBeenCalledWith(PrismaLanguage.pt, 'tag', 3, 5);
    // Без счётчика спека зелена и на коде, где рядом с разобранным вызовом стоит второй,
    // с сырыми значениями, - а решает ответ именно он.
    expect(tags.versionsByTagLangSlug).toHaveBeenCalledTimes(1);
  });

  it('authorsList: passes the whole validated query through to listPublic', async () => {
    authors.listPublic.mockResolvedValueOnce({ data: [], meta: { total: 0 } });
    const query = {
      page: 2,
      limit: 24,
      search: 'дост',
      letter: 'Д',
      sort: 'books' as const,
      hasBooks: true,
    };

    const res = await controller.authorsList(PrismaLanguage.ru, query);

    expect(res).toEqual({ data: [], meta: { total: 0 } });
    expect(authors.listPublic).toHaveBeenCalledTimes(1);
    expect(authors.listPublic).toHaveBeenCalledWith(PrismaLanguage.ru, query);
  });

  // 🔴 Список ходит через `listPublic`, а не через `list`: последний отдаёт анониму
  // биографию, quotes, faq и весь Seo каждого перевода (`LEGACY-214`).
  it('authorsList: never reaches the admin list()', async () => {
    authors.list = jest.fn();
    authors.listPublic.mockResolvedValueOnce({ data: [], meta: {} });

    await controller.authorsList(PrismaLanguage.en, {});

    expect(authors.list).not.toHaveBeenCalled();
  });

  it('authorLetters: delegates to the alphabet index with the path language', async () => {
    authors.listPublicLetters.mockResolvedValueOnce([{ letter: 'A', count: 2 }]);

    const res = await controller.authorLetters(PrismaLanguage.en, {});

    expect(res).toEqual([{ letter: 'A', count: 2 }]);
    expect(authors.listPublicLetters).toHaveBeenCalledTimes(1);
    expect(authors.listPublicLetters).toHaveBeenCalledWith(PrismaLanguage.en, undefined);
  });

  // 🔴 Указатель стоит над отфильтрованной сеткой, и его счётчики обязаны
  // описывать её же: иначе буква говорит «12» над выдачей из двух человек.
  it('authorLetters: passes the search filter through so the counts match the grid', async () => {
    authors.listPublicLetters.mockResolvedValueOnce([]);

    await controller.authorLetters(PrismaLanguage.ru, { search: 'дост' });

    expect(authors.listPublicLetters).toHaveBeenCalledWith(PrismaLanguage.ru, 'дост');
  });

  /**
   * 🔴 Nest сопоставляет маршруты в порядке объявления. Окажись `authors/letters`
   * ниже `authors/:slug` — указатель уехал бы в поиск автора со слагом `letters`
   * и отдавал бы 404, причём молча: сборка и типы этого не видят.
   */
  it('declares authors/letters above authors/:slug', () => {
    const source = require('fs').readFileSync(__dirname + '/public.controller.ts', 'utf8');
    const letters = source.indexOf("@Get('authors/letters')");
    const bySlug = source.indexOf("@Get('authors/:slug')");

    expect(letters).toBeGreaterThan(-1);
    expect(bySlug).toBeGreaterThan(-1);
    expect(letters).toBeLessThan(bySlug);
  });
});
