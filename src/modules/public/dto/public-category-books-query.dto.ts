import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PAGINATION_MAX_LIMIT } from '../../../shared/dto/pagination.dto';

/**
 * Параметры публичного списка книг категории `GET /:lang/categories/:slug/books` (`LEGACY-377`).
 *
 * Свой класс, а не `PaginationDto`: у того `page`/`limit` описаны `@ApiProperty`, и схема
 * объявляла бы необязательные параметры обязательными. Потолок — общий `PAGINATION_MAX_LIMIT`.
 */
export class PublicCategoryBooksQueryDto {
  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `Books per page. Values above ${PAGINATION_MAX_LIMIT} are rejected with 400.`,
    minimum: 1,
    maximum: PAGINATION_MAX_LIMIT,
    default: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number = 10;
}
