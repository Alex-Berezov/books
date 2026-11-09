import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { IsIsoDateTimeWithZone } from '../validators/iso-date-time-with-zone.decorator';

/**
 * Сверка записи, которая живёт одной строкой на версию (анализ, пересказ), — в query, а не в теле:
 * тело этих ручек пишется в колонки целиком или уходит в слияние, и лишнее поле попало бы в запись.
 * `expectedUpdatedAt` — `updatedAt`, который видела вкладка; запись успели изменить — 409.
 */
export class ExpectedUpdatedAtQueryDto {
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsIsoDateTimeWithZone()
  expectedUpdatedAt?: string;
}

/**
 * Сверка записи, которую можно создать этой же ручкой: `expectedAbsent=true` — вкладка видела
 * «записи нет» (решение арбитра `T173 | LEGACY-496`); строка уже есть — 409. Вместе
 * с `expectedUpdatedAt` — 400. Без обоих полей сверки нет: других клиентов у ручек нет.
 */
export class ExpectedRowQueryDto extends ExpectedUpdatedAtQueryDto {
  @ApiPropertyOptional({ enum: ['true'] })
  @IsOptional()
  @IsIn(['true'])
  expectedAbsent?: 'true';
}
