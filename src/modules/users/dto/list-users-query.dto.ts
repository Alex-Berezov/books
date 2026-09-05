import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PAGINATION_MAX_LIMIT } from '../../../shared/dto/pagination.dto';

/** Значения фильтра по сотрудникам: `only` — только штат, `exclude` — без штата. */
export const USERS_STAFF_FILTERS = ['only', 'exclude'] as const;

export type UsersStaffFilter = (typeof USERS_STAFF_FILTERS)[number];

/**
 * Параметры `GET /users`. Вынесены из `users.controller.ts` 05.09.2026
 * (`LEGACY-133`) вместе с декораторами документации: без `@ApiProperty*`
 * класс уезжал в OpenAPI пустым.
 */
export class ListUsersQueryDto {
  // 🔴 Глобальный `ValidationPipe` создан без `enableImplicitConversion`, поэтому
  // в проекте конвертация поштучная: числовое поле query-DTO без `@Type(() => Number)`
  // получает из строки запроса строку, `@IsInt` отвергает её, и маршрут отвечает 400
  // на **любое** значение параметра. Образец — `src/shared/dto/pagination.dto.ts`.
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /**
   * ⚠️ Потолок берётся из `PAGINATION_MAX_LIMIT`, а не литералом: он сдвигается
   * одним местом и несимметрично — фронт уезжает первым (`LEGACY-217`), и свой
   * литерал здесь провёл бы этот сдвиг мимо админского списка.
   *
   * Класс при этом **не наследует** `PaginationDto`: у того `limit` по умолчанию
   * 10, а здесь 20, и наследование сменило бы размер страницы `GET /users` —
   * поведение, а не документацию.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: PAGINATION_MAX_LIMIT, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Search by email or name' })
  @IsOptional()
  @IsString()
  q?: string;

  /**
   * ⚠️ Проверяется только `@IsString()`, как и до переноса: `?staff=garbage`
   * доходит до сервиса и молча попадает в ветку «не only и не exclude».
   * Добавить сюда `@IsIn(USERS_STAFF_FILTERS)` значило бы поменять ответ ручки
   * с 200 на 400 — это за границами `LEGACY-133`, которая правит документацию,
   * а не валидацию. Набор значений при этом объявлен и уходит в OpenAPI, то
   * есть потребитель видит допустимые значения.
   */
  @ApiPropertyOptional({ enum: USERS_STAFF_FILTERS })
  @IsOptional()
  @IsString()
  staff?: UsersStaffFilter;
}
