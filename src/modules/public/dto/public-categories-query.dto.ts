import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { CategoryType } from '@prisma/client';

/**
 * Потолок публичной выдачи терминов (LEGACY-056).
 *
 * 200, а не 100, намеренно: при закрытии LEGACY-065 sitemap придётся снимать с
 * админского маршрута, и его новым источником станет этот. Категорий 133 — при
 * потолке 100 «всё влезло в один запрос» перестало бы быть правдой молча, то есть
 * тот же дефект зашёл бы с другой стороны.
 */
export const PUBLIC_CATEGORIES_MAX_LIMIT = 200;

/** Дефолт менять нельзя без разбора: на нём сидят пять витрин, не просящих страниц. */
export const PUBLIC_CATEGORIES_DEFAULT_LIMIT = 50;

/**
 * До появления этой DTO у маршрута не было ни одного проверяемого параметра:
 * `page`/`limit` не принимались вовсе, а `?type=garbage` роняло публичный
 * маршрут в 500 — глобальный `ValidationPipe` не действует на голый
 * `@Query('type') type?: string`.
 *
 * Параметра `search` здесь нет **намеренно**. Поиск по категориям не реализован
 * в сервисе (в отличие от тегов), а раньше `?search=` молча отбрасывался и со
 * стороны выглядел работающим фильтром. С `forbidNonWhitelisted: true`
 * отсутствие поля даёт 400 — честное «такого параметра нет».
 */
export class PublicCategoriesQueryDto {
  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `Rows per page. Values above ${PUBLIC_CATEGORIES_MAX_LIMIT} are capped, and meta.limit reports the applied value.`,
    minimum: 1,
    default: PUBLIC_CATEGORIES_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = PUBLIC_CATEGORIES_DEFAULT_LIMIT;

  @ApiPropertyOptional({ enum: CategoryType, description: 'Filter by term type' })
  @IsOptional()
  @IsEnum(CategoryType)
  type?: CategoryType;
}
