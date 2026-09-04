import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PAGINATION_MAX_LIMIT } from '../../../shared/dto/pagination.dto';

/**
 * Параметры публичного списка тегов `GET /:lang/tags`.
 *
 * До этой DTO оба параметра принимались голым `@Query('page') page?: number` и
 * идиомой `page ? Number(page) : N`. Глобальный `ValidationPipe` приводит примитивный
 * query-параметр через `+value`, поэтому `?page=abc` давал `NaN`, а `?page=` — `0`;
 * оба falsy, и идиома молча подставляла дефолт вместо отказа (`LEGACY-298`).
 *
 * Потолок — не свой, а `PAGINATION_MAX_LIMIT`: это тот же потолок, что уже стоит на
 * административном зеркале того же `TagsService.list` (`GET /tags`, через
 * `ListTagsDto extends PaginationDto`).
 */
export class PublicTagsQueryDto {
  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `Tags per page. Values above ${PAGINATION_MAX_LIMIT} are rejected with 400.`,
    minimum: 1,
    maximum: PAGINATION_MAX_LIMIT,
    default: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number = 50;
}
