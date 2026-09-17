import { ApiPropertyOptional } from '@nestjs/swagger';
import { PAGINATION_MAX_LIMIT, PaginationDto } from './pagination.dto';

/**
 * Страница вложенного админского списка (претензии версии и книги, лицензии профиля, `LEGACY-377`):
 * валидаторы и потолок наследуются от `PaginationDto`, здесь только необязательность в схеме
 * (`LEGACY-403`) и размер страницы по умолчанию.
 *
 * ⚠️ До 17.09.2026 эти маршруты отдавали весь список, теперь без query - первые 20. Контракт
 * сужен, поэтому выкат несимметричен: `books-front` уезжает первым (панель претензий версии
 * просит страницу по потолку и показывает неполноту). Обратный порядок отдаёт старой панели
 * 20 претензий из N без сигнала.
 */
export class ChildListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  declare page: number;

  @ApiPropertyOptional({
    description: `Records per page. Values above ${PAGINATION_MAX_LIMIT} are rejected with 400.`,
    minimum: 1,
    maximum: PAGINATION_MAX_LIMIT,
    default: 20,
    example: 20,
  })
  limit: number = 20;
}

export interface ChildListPage {
  page: number;
  limit: number;
}
