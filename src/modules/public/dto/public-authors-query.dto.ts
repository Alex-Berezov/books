import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PUBLIC_AUTHORS_DEFAULT_LIMIT,
  PUBLIC_AUTHORS_MAX_LIMIT,
  PUBLIC_AUTHORS_SORTS,
  type PublicAuthorsSort,
} from '../../author/author-listing.constants';

/**
 * Разбор булева параметра строки запроса.
 *
 * ⚠️ Возвращает исходное значение, когда оно не похоже ни на да, ни на нет.
 * Так `@IsBoolean` увидит строку и отдаст 400. Привычная форма
 * `value === 'true'` схлопывает `?hasBooks=1` и `?hasBooks=yes` в молчаливый
 * `false` — читатель просил фильтр, получил его отсутствие и никакой ошибки.
 */
const TRUTHY = ['true', '1', 'yes'];
const FALSY = ['false', '0', 'no'];

function parseQueryBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;

  const normalized = value.trim().toLowerCase();
  if (TRUTHY.includes(normalized)) return true;
  if (FALSY.includes(normalized)) return false;
  return value;
}

/**
 * Параметры публичного списка авторов `GET /:lang/authors`.
 *
 * До этой DTO у маршрута было ровно два параметра, и оба принимались голым
 * `@Query('page') page?: number` с ручным `Number()`. Глобальный `ValidationPipe`
 * на такой параметр не действует вовсе, поэтому `?page=garbage` уходил в сервис
 * как `NaN`.
 *
 * Потолок `limit` — жёсткий: `@Max` здесь плюс `Math.min` в сервисе вторым рубежом.
 * Почему отказ, а не молчаливое усечение, разобрано в `PUBLIC_AUTHORS_MAX_LIMIT`:
 * усечённый список тихо выкидывает живую языковую альтернативу из hreflang
 * авторских страниц, а отказ читается как «язык неизвестен» и её сохраняет.
 */
export class PublicAuthorsQueryDto {
  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `Rows per page. Values above ${PUBLIC_AUTHORS_MAX_LIMIT} are rejected with 400; meta.limit reports the applied value.`,
    minimum: 1,
    default: PUBLIC_AUTHORS_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PUBLIC_AUTHORS_MAX_LIMIT)
  limit?: number = PUBLIC_AUTHORS_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    description: 'Case-insensitive substring of the author name in the path language.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  /**
   * ⚠️ Здесь проверяется только форма — один символ либо `#`. Принадлежность
   * алфавиту проверяет сервис: алфавит зависит от языка пути, а DTO о нём
   * не знает. Без второй проверки `?letter=W` на `/ru/` отдавал бы 200
   * с пустым списком вместо 400, да ещё и оседал в общем кэше на пять минут.
   */
  @ApiPropertyOptional({
    description:
      'Single letter of the path language alphabet, or "#" for names that start with neither. Diacritics fold into the base letter: "É" is listed under "E". A letter outside the path language alphabet is rejected with 400.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(#|\p{L})$/u, {
    message: 'letter must be a single letter or "#"',
  })
  letter?: string;

  @ApiPropertyOptional({
    description: '"name" — alphabetical (default). "books" — most published books first.',
    enum: PUBLIC_AUTHORS_SORTS,
    default: 'name',
  })
  @IsOptional()
  @IsIn(PUBLIC_AUTHORS_SORTS)
  sort?: PublicAuthorsSort = 'name';

  @ApiPropertyOptional({
    description:
      'Drop authors with no published book in the path language. Default false — the hub asks for it, the homepage and the sitemap do not.',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean({ message: 'hasBooks must be one of: true, false, 1, 0, yes, no' })
  hasBooks?: boolean = false;
}

/**
 * Параметры ручки букв `GET /:lang/authors/letters`.
 *
 * Отдельный класс, а не переиспользованный `PublicAuthorsQueryDto`: у ручки
 * букв нет ни страниц, ни сортировки, ни `hasBooks` (он там всегда включён),
 * а с `forbidNonWhitelisted: true` лишнее поле в DTO означало бы, что маршрут
 * молча принимает параметр, который ни на что не влияет.
 */
export class PublicAuthorLettersQueryDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive substring of the author name in the path language.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
