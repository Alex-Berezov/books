import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Порция ручки карты разделов (F04 T10): элемент — версия, файл карты — одна страница по 50 версий
 * (≤ 50 × 200 = 10 000 адресов). Потолок свой, ниже общего `PAGINATION_MAX_LIMIT`.
 */
export const SUMMARY_SECTIONS_SITEMAP_MAX_LIMIT = 50;
/**
 * Потолок номера страницы (решение арбитра `F04 | F04-1`, края круга 4): страница — один файл карты
 * до 10 000 адресов, а 10 000 файлов на язык — 100 млн адресов, с запасом выше любой выдачи. Без
 * потолка огромный `page` уводил `skip` за пределы Prisma и отдавал 500 вместо пустой страницы.
 */
export const SUMMARY_SECTIONS_SITEMAP_MAX_PAGE = 10_000;

export class BookSummarySectionsSitemapQueryDto {
  @ApiPropertyOptional({
    type: Number,
    default: 1,
    minimum: 1,
    maximum: SUMMARY_SECTIONS_SITEMAP_MAX_PAGE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUMMARY_SECTIONS_SITEMAP_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({
    type: Number,
    default: SUMMARY_SECTIONS_SITEMAP_MAX_LIMIT,
    minimum: 1,
    maximum: SUMMARY_SECTIONS_SITEMAP_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUMMARY_SECTIONS_SITEMAP_MAX_LIMIT)
  limit?: number = SUMMARY_SECTIONS_SITEMAP_MAX_LIMIT;
}
