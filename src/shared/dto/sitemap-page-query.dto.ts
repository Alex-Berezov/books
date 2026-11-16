import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Порция ручек карты сайта (разделы пересказа F04 T10, мир книги F08-3): элемент — версия, файл
 * карты — одна страница по 50 версий. Потолок свой, ниже общего `PAGINATION_MAX_LIMIT`. Одна форма
 * на обе карты: фронтовый `readCompletePage` читает их одним приёмом.
 */
export const SITEMAP_PAGE_MAX_LIMIT = 50;
/**
 * Потолок номера страницы (решение арбитра `F04 | F04-1`, края круга 4): 10 000 файлов на язык — с
 * запасом выше любой выдачи. Без потолка огромный `page` уводил `skip` за пределы Prisma и отдавал
 * 500 вместо пустой страницы.
 */
export const SITEMAP_PAGE_MAX_PAGE = 10_000;

export class SitemapPageQueryDto {
  @ApiPropertyOptional({ type: Number, default: 1, minimum: 1, maximum: SITEMAP_PAGE_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SITEMAP_PAGE_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({
    type: Number,
    default: SITEMAP_PAGE_MAX_LIMIT,
    minimum: 1,
    maximum: SITEMAP_PAGE_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SITEMAP_PAGE_MAX_LIMIT)
  limit?: number = SITEMAP_PAGE_MAX_LIMIT;
}
