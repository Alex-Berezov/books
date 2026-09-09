import { ApiPropertyOptional } from '@nestjs/swagger';
import { PublicationStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../shared/dto/pagination.dto';

/**
 * `LEGACY-371`: список CMS-страниц шлёт `search`/`status` уже давно, но
 * `findAllGrouped` разбирал только `PaginationDto` — глобальный `ValidationPipe`
 * (`forbidNonWhitelisted: true`) отбивал оба поля 400-м на каждый непустой ввод.
 *
 * Свагер-описание живёт здесь, а не `@ApiQuery` в контроллере: метаданные
 * с поля DTO и с обработчика сливаются в один параметр схемы, и вторая копия
 * списка значений разошлась бы с `@IsIn` молча.
 */
export class ListPagesQueryDto extends PaginationDto {
  /**
   * Потолок тот же, что у `search` публичного списка авторов
   * (`../../public/dto/public-authors-query.dto.ts`): терм уходит в два
   * `ILIKE '%…%'` по неиндексированным `title`/`slug`, и каждый запрос
   * считает их дважды — постранично и ради общего числа групп.
   */
  @ApiPropertyOptional({ description: 'Search by title or slug', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by publication status',
    enum: Object.values(PublicationStatus),
  })
  @IsOptional()
  @IsIn(Object.values(PublicationStatus))
  status?: PublicationStatus;
}
