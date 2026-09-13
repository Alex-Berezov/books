import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsString, Matches, Min, MinLength, ValidateIf } from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

/**
 * 🔴 `LEGACY-363`. У полей на `NOT NULL`-колонках нет `@IsOptional()` — он пропустил бы
 * `null` мимо проверки типа, и `{"isVisible": null}` уронил бы Prisma пятисотым вместо
 * штатного 400. Правило и его форма — `STYLE_GUIDE.md`, §7, «Исключение — поле, за которым
 * стоит колонка `NOT NULL`»; здесь ссылка, а не копия. Решение арбитра 13.09.2026.
 */
export class CreateTagDto {
  @ApiProperty({ description: 'Tag name', example: 'Motivation' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ description: 'Tag slug', example: 'motivation', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiProperty({ description: 'Stable unique key', example: 'motivation', pattern: SLUG_PATTERN })
  @IsString()
  @MinLength(2)
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  key!: string;

  @ApiPropertyOptional({
    description: 'Whether the page is indexable by search engines',
    default: true,
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  indexable?: boolean;

  @ApiPropertyOptional({ description: 'Whether the tag is visible in public lists', default: true })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  isVisible?: boolean;

  @ApiPropertyOptional({ description: 'Sort order in lists', default: 0 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
