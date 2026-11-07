import { ServiceUnavailableException } from '@nestjs/common';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import {
  BookSummarySectionsService,
  SITEMAP_NOINDEX_SEO_LIMIT,
} from './book-summary-sections.service';

/**
 * Карта разделов пересказа (F04-1): предел кандидатов `Seo` с `noindex` (решение арбитра
 * `F04 | F04-1`, шаг 7 после круга 3). Сверх предела — 503 на всю ручку, а не урезанный список:
 * урезанный открыл бы индексу книги с редакторским `noindex`. Остальное поведение ручки держит
 * `test/book-summary-sections.e2e-spec.ts` на живой базе.
 */
describe('BookSummarySectionsService.sitemap — предел noindex', () => {
  const seoRows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: i + 1, robots: 'noindex' }));

  const makeService = (rows: Array<{ id: number; robots: string }>) => {
    const prisma = {
      seo: { findMany: jest.fn().mockResolvedValue(rows) },
      bookVersion: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new BookSummarySectionsService(
      prisma as unknown as PrismaService,
      {} as ModeratorRolesService,
      {} as GeoBlockRuleService,
    );
    return { service, prisma };
  };

  it('кандидатов больше предела — 503, страница не читается', async () => {
    const { service, prisma } = makeService(seoRows(SITEMAP_NOINDEX_SEO_LIMIT + 1));
    await expect(service.sitemap('en', 1, 50)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.seo.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.seo.findMany.mock.calls[0][0]).toMatchObject({
      take: SITEMAP_NOINDEX_SEO_LIMIT + 1,
    });
    expect(prisma.bookVersion.findMany).not.toHaveBeenCalled();
    expect(prisma.bookVersion.count).not.toHaveBeenCalled();
  });

  it('ровно предел — страница читается, все кандидаты исключены', async () => {
    const { service, prisma } = makeService(seoRows(SITEMAP_NOINDEX_SEO_LIMIT));
    await expect(service.sitemap('en', 1, 50)).resolves.toMatchObject({ items: [] });
    expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(prisma.bookVersion.findMany.mock.calls[0][0])).toContain(
      `"notIn":[1,2,3`,
    );
  });
});

/**
 * Решение арбитра `T163 | LEGACY-490` (круг 2): страница раздела закрывается только блоком
 * окончённой претензии на весь мир — вызовом `assertSettledClaimAccess` **без страны**. Выборки
 * (оглавление, счётчик, карта, список закрытий) держат то же правило через
 * `worldwideSettledClaimBlockWhere`; страна в этом вызове развела бы страницу с картой сайта.
 */
describe('BookSummarySectionsService.getByNumber — претензия без страны', () => {
  it('читатель: assertSettledClaimAccess ровно раз, countryCode null, scope TEXT_READER', async () => {
    const stop = new Error('stop after claim check');
    const assertSettledClaimAccess = jest.fn().mockRejectedValue(stop);
    const db = {
      bookVersion: {
        findUnique: jest.fn().mockResolvedValue({ status: 'published', bookId: 'b1' }),
      },
    };
    const service = new BookSummarySectionsService(
      db as unknown as PrismaService,
      { isModerator: jest.fn().mockResolvedValue(false) } as unknown as ModeratorRolesService,
      { assertSettledClaimAccess } as unknown as GeoBlockRuleService,
    );

    await expect(service.getByNumber('v1', '1', undefined)).rejects.toBe(stop);
    expect(assertSettledClaimAccess).toHaveBeenCalledTimes(1);
    expect(assertSettledClaimAccess).toHaveBeenCalledWith({
      bookId: 'b1',
      bookVersionId: 'v1',
      countryCode: null,
      scope: 'TEXT_READER',
    });
  });
});
