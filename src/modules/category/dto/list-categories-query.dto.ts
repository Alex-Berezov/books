import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CategoryType, Language } from '@prisma/client';
import { PAGINATION_MAX_LIMIT } from '../../../shared/dto/pagination.dto';

/**
 * Параметры `GET /admin/categories` — до 23.09.2026 тем же DTO отвечал ещё
 * и безъязыкий `GET /categories` (снят пачкой `W6`, `LEGACY-387`), где `page`/`limit`
 * раньше шли голым `@Query('page', new DefaultValuePipe(1), ParseIntPipe)` без верхней
 * границы вовсе: `?limit=100000` проходил приведение типа и уезжал в `take` Prisma
 * как есть (`LEGACY-298`, схлопнута сюда `LEGACY-353`).
 *
 * Потолок — `PAGINATION_MAX_LIMIT`, тот же, что уже стоит на административном
 * `GET /books` и `GET /admin/tags`. Карта сайта раньше ходила тем же `CategoryService.list`
 * через этот DTO одним `limit=1000` (`LEGACY-298`) — с 22.09.2026 (`W6`) она читает
 * публичный `GET /:lang/categories` (`PublicCategoriesQueryDto`, свой потолок) листая
 * страницы, и этого DTO больше не касается.
 *
 * `type`/`lang` получили `@IsEnum` при заведении DTO (найдено ревью): без него
 * `?type=garbage` уезжал бы в `where` Prisma и падал `PrismaClientValidationError`
 * (500), а `?lang=xx` — в сырой `${lang}::"Language"` внутри `$queryRaw` и падал
 * бы кодом Postgres 22P02 (тоже 500) — ровно тот класс дефекта, что уже закрыт
 * тем же декоратором на соседнем `/:lang/categories` (`public-categories-query.dto.ts`,
 * `LEGACY-056`).
 */
export class ListCategoriesQueryDto {
  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `Rows per page. Values above ${PAGINATION_MAX_LIMIT} are rejected with 400.`,
    minimum: 1,
    maximum: PAGINATION_MAX_LIMIT,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: CategoryType, description: 'Filter by category type' })
  @IsOptional()
  @IsEnum(CategoryType)
  type?: CategoryType;

  @ApiPropertyOptional({ enum: Language, description: 'Filter by language' })
  @IsOptional()
  @IsEnum(Language)
  lang?: Language;
}
