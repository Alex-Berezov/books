import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { PAGINATION_MAX_LIMIT } from '../../../shared/dto/pagination.dto';

/**
 * Параметры списка глав (`LEGACY-178`, `LEGACY-176`).
 *
 * До 13.09.2026 оба маршрута списка глав читали `page` и `limit` сырыми
 * `@Query('page')` / `@Query('limit')` и гнали их через `parseInt` — без DTO,
 * а значит и без `ValidationPipe`: `?limit=100000` уходил в `take` Prisma как
 * есть, а `?limit=abc` превращался в `NaN`. Это единственные списочные
 * маршруты проекта, которые не проходили валидацию вовсе.
 *
 * ⚠️ Режим «вернуть все главы разом» сохранён сознательно (решение владельца
 * 13.09.2026). Его ждут два потребителя в `books-front`: админский экран глав
 * (`api/endpoints/admin/chapters.ts`) и публичный `getPublicChapters`
 * (`api/endpoints/public.ts`) — оба зовут маршрут без параметров и читают весь
 * список одной страницей `{items, pagination}` (`LEGACY-379`, 23.09.2026). Обязательная пагинация здесь —
 * ломающее изменение контракта, а не ужесточение валидации, и делается
 * отдельной записью вместе с правкой фронта.
 *
 * ⚠️ Потолок применяется к **переданному** `limit` и не вводит молчаливого
 * усечения: при отсутствии параметров ответ по-прежнему полон. Тихо резать
 * выдачу потолком по умолчанию запрещает `LEGACY-098`.
 *
 * 🔴 `page` и `limit` принимаются только парой. Одиночный параметр отвергается
 * с 400, и это не придирка к форме запроса: `ChapterService.listInternal`
 * паджинирует по условию `if (page && limit)`, поэтому `?limit=2` без `page`
 * проходил бы валидацию с объявленным потолком и уходил в безлимитную ветку —
 * анониму уезжали бы все главы версии с полным `content` при HTTP 200 и без
 * признака усечения. Молча применить второе значение по умолчанию нельзя
 * по той же `LEGACY-098`: это и есть тихое усечение выдачи.
 */
export class ListChaptersQueryDto {
  @ApiPropertyOptional({
    description: 'Page number, 1-based; required together with `limit`',
    minimum: 1,
    example: 1,
  })
  @ValidateIf((o: ListChaptersQueryDto) => o.limit !== undefined || o.page !== undefined)
  @IsDefined({ message: 'page is required when limit is provided' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Page size; required together with `page`. Omit both to get every chapter at once',
    minimum: 1,
    maximum: PAGINATION_MAX_LIMIT,
    example: 20,
  })
  @ValidateIf((o: ListChaptersQueryDto) => o.page !== undefined || o.limit !== undefined)
  @IsDefined({ message: 'limit is required when page is provided' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number;
}
