import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, Matches, MaxLength } from 'class-validator';
import { Language } from '@prisma/client';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

/**
 * LEGACY-215: `lang` обязателен по образцу `pages/dto/check-slug-query.dto.ts`. Слаг автора
 * уникален в пределах языка (`AuthorTranslation`), а не глобально — без языка проверка
 * находит совпадение в чужом переводе и ложно блокирует свободный слаг.
 */
export class CheckSlugQueryDto {
  @ApiProperty({
    description: 'Slug to check for uniqueness',
    example: 'leo-tolstoy',
    pattern: SLUG_PATTERN,
  })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), {
    message: SLUG_REGEX_README,
  })
  @MaxLength(100, { message: 'Slug must be at most 100 characters long' })
  slug!: string;

  /**
   * Через `@IsEnum(Language)`, а не через список литералов: enum схемы — источник истины
   * (`STYLE_GUIDE.md`, «Enum-ы»). Вбитый руками список разошёлся бы с ним на первом же новом
   * языке молча — поле объявлено `Language`, и `tsc` о расхождении не скажет ничего.
   */
  @ApiProperty({
    description: 'Author translation language',
    example: 'en',
    enum: Object.values(Language),
  })
  @IsEnum(Language, { message: `Language must be one of: ${Object.values(Language).join(', ')}` })
  lang!: Language;

  /**
   * ⚠️ Без `@IsUUID`: `Author.id` — `String @id @default(uuid())`, то есть uuid только
   * по умолчанию. Сид пишет туда явный не-uuid (`prisma/seed.ts:16`,
   * `'seed-author-jk-rowling'`), и такой автор живёт в шаблонной базе e2e, в `books_test`
   * конвейера и в базе playwright-набора фронта. Проверка на uuid отвечала бы 400 на форме
   * правки этого автора вместо проверки слага.
   */
  @ApiPropertyOptional({
    description: 'Author ID to exclude from the check (when editing)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'excludeId must be at most 100 characters long' })
  excludeId?: string;
}
