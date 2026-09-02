import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsInt, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Потолок `limit` общего DTO пагинации.
 *
 * Вынесен константой, чтобы посадка читала то же число, что и декоратор:
 * `test/admin-authors.e2e-spec.ts` импортирует её и строит границы от неё,
 * а не от литералов. Сдвиг потолка красит там ровно тот кейс, который перестал
 * быть верным, а не соседний.
 */
export const PAGINATION_MAX_LIMIT = 100;

export class PaginationDto {
  @ApiProperty({ description: 'Page number', example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /**
   * Потолок размера страницы для **всех** списков на этом DTO (`LEGACY-217`).
   *
   * Сотня - принятое в проекте значение: с ней стоят двенадцать собственных
   * списочных DTO литеральным `@Max(100)` и ещё несколько через свою именованную
   * константу. Отступления заданы своими DTO и этого потолка не видят
   * (`book-cards-query.dto.ts` - 48).
   *
   * До 02.09.2026 потолка не было вовсе, и `?limit=100000` проходил валидацию,
   * уезжая в `take` Prisma как есть. Ставить его позже дороже, чем сразу:
   * к этому дню на ручках уже успели появиться потребители, просившие тысячу
   * (`LEGACY-076`, и то же предупреждение в `admin-comments.dto.ts`).
   *
   * ⚠️ Потолок **сужает уже работающий контракт**, поэтому выкат несимметричен:
   * `books-front` уезжает первым. Обратный порядок отдаёт 400 карте сайта
   * (секция тегов) и двум админским экранам авторов - разбор в `LEGACY-217`.
   */
  @ApiProperty({
    description: 'Number of records per page',
    example: 10,
    default: 10,
    maximum: PAGINATION_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number = 10;
}
