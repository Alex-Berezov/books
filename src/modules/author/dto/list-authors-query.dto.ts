import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../shared/dto/pagination.dto';

/**
 * `LEGACY-352`: выпадающий список авторов в форме книги брал одну страницу
 * общим потолком `PAGINATION_MAX_LIMIT` и фильтровал её на клиенте — авторы
 * за первой сотней были невидимы. Поиск переведён на сервер по образцу
 * `ListTagsDto` (`../../tags/dto/list-tags.dto.ts`).
 */
export class ListAuthorsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search by author name' })
  @IsOptional()
  @IsString()
  q?: string;
}
