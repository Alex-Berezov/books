import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  PUBLIC_TAG_BOOKS_DEFAULT_LIMIT,
  PUBLIC_TAG_BOOKS_MAX_LIMIT,
} from '../../tags/tag-books-listing.constants';

/**
 * Параметры публичного списка книг тега `GET /:lang/tags/:slug/books`.
 *
 * До этой DTO оба параметра принимались голым `@Query('page') page?: number` и уходили
 * в сервис сырыми. Глобальный `ValidationPipe` приводит примитивный query-параметр
 * через `+value`, поэтому `?page=abc` давал `NaN`, а `?page=` — `0`; значение по умолчанию
 * в сигнатуре сервиса срабатывает только на `undefined` и от этого не спасает.
 * `NaN` и отрицательный `skip` уходили в Prisma, и публичный маршрут отвечал **500**
 * (проверено на проде 14.08.2026, `LEGACY-199`).
 *
 * ⚠️ Соседние `findAll` и `tagsList` того же контроллера прикрыты идиомой
 * `page ? Number(page) : N`. Она спасает от 500 случайно: `NaN` и `0` falsy, поэтому мусор
 * молча превращается в дефолт. Здесь выбран отказ: `?page=abc` — это ошибка потребителя,
 * и 400 говорит о ней, а 200 с первой страницей выдаёт её за исполненный запрос.
 */
export class PublicTagBooksQueryDto {
  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `Rows per page. Values above ${PUBLIC_TAG_BOOKS_MAX_LIMIT} are rejected with 400.`,
    minimum: 1,
    maximum: PUBLIC_TAG_BOOKS_MAX_LIMIT,
    default: PUBLIC_TAG_BOOKS_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PUBLIC_TAG_BOOKS_MAX_LIMIT)
  limit?: number = PUBLIC_TAG_BOOKS_DEFAULT_LIMIT;
}
