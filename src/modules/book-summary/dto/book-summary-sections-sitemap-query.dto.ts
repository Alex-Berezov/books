import {
  SITEMAP_PAGE_MAX_LIMIT,
  SITEMAP_PAGE_MAX_PAGE,
  SitemapPageQueryDto,
} from '../../../shared/dto/sitemap-page-query.dto';

/**
 * Порция ручки карты разделов (F04 T10): форма одна с картой мира книги — `SitemapPageQueryDto`
 * (≤ 50 версий × 200 разделов = 10 000 адресов на файл). Имена ниже — те, на которые ссылается
 * копия потолка на фронте (`books-front/lib/sitemap/summary-sections.ts`).
 */
export const SUMMARY_SECTIONS_SITEMAP_MAX_LIMIT = SITEMAP_PAGE_MAX_LIMIT;
export const SUMMARY_SECTIONS_SITEMAP_MAX_PAGE = SITEMAP_PAGE_MAX_PAGE;

export class BookSummarySectionsSitemapQueryDto extends SitemapPageQueryDto {}
