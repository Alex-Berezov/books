import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateBookVersionDto } from './create-book-version.dto';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
  IsInt,
  Min,
  Max,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  IsAbsoluteHttpUrl,
  IsAbsoluteHttpUrlOrRootPath,
} from '../../../shared/validators/absolute-http-url.decorator';
import { Language as PrismaLanguage, BookType as PrismaBookType } from '@prisma/client';
import {
  BookVersionCharacterDto,
  BookVersionQuoteDto,
  BookVersionSymbolDto,
} from '../../../shared/dto/book-version-json.dto';
import { FaqItemDto } from '../../../shared/dto/faq-item.dto';
import { SHORT_TEXT_MAX_LENGTH } from '../../../shared/constants/validation';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';
import {
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  SLUG_REGEX,
  SLUG_REGEX_README,
} from '../../../shared/validators/slug';

export class UpdateBookVersionDto implements Partial<CreateBookVersionDto> {
  @ApiPropertyOptional({ enum: Object.values(PrismaLanguage), example: 'es' })
  // `LEGACY-437`: колонка NOT NULL, `null` не «не менять» — пропускается только отсутствующее поле.
  @ValidateIf((_o, value) => value !== undefined)
  @IsIn(Object.values(PrismaLanguage))
  language?: PrismaLanguage;

  @ApiPropertyOptional({
    description: `Слаг версии книги. ${SLUG_REGEX_README}. Предел ${SLUG_MAX_LENGTH} символов — только у изменённого слага: текущий слаг версии принимается как есть.`,
    example: 'harry-potter',
    pattern: SLUG_PATTERN,
  })
  // `LEGACY-437`: `null` не «не менять», а запись NULL в колонку без редиректа (класс `LEGACY-062`):
  // пропускается только отсутствующее поле.
  @ValidateIf((o: UpdateBookVersionDto) => o.slug !== undefined)
  @IsString()
  // `LEGACY-437`: формат держался только формой админки и `check-slug`. Длину здесь не проверить: DTO не знает
  // текущий слаг, а неизменный слаг старой записи длиннее предела не отказ — предел у изменённого слага ставит
  // сервис (`assertChangedSlugLength`).
  @Matches(SLUG_REGEX, { message: SLUG_REGEX_README })
  slug?: string;

  @ApiPropertyOptional({ example: "Harry Potter and the Sorcerer's Stone" })
  // `LEGACY-437`: колонка NOT NULL, `null` не «не менять» — пропускается только отсутствующее поле.
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @MinLength(2)
  title?: string;

  @ApiPropertyOptional({ example: 'J.K. Rowling' })
  // `LEGACY-437`: колонка NOT NULL, `null` не «не менять» — пропускается только отсутствующее поле.
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @MaxLength(500, { message: 'Author must be at most 500 characters long' })
  author?: string;

  /**
   * Пустая строка принимается намеренно: у черновика поле можно очистить так же, как и заполнить.
   * Опубликованную версию это не касается — стирание заполненного описания или обложки у неё
   * отбивает `BookVersionService.update`, публикация без них запрещена.
   */
  @ApiPropertyOptional({ example: 'Updated description text' })
  // `null` в колонку `NOT NULL` не ложится: его отбивает валидатор, а не Prisma.
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  description?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/covers/hp1-new.jpg' })
  // Ложное условие отключает **все** валидаторы поля разом, поэтому пропускаются ровно два
  // случая: поля нет и поле пустое. Всё остальное — `null`, число, массив, объект — обязано
  // дойти до `@IsString()` и `@IsAbsoluteHttpUrl()` и получить 400, а не проскочить проверку
  // и упасть на записи в базу пятисоткой.
  @ValidateIf((_o, value) => value !== undefined && value !== '')
  @IsString()
  @IsAbsoluteHttpUrl()
  coverImageUrl?: string;

  @ApiPropertyOptional({ enum: Object.values(PrismaBookType), example: 'audio' })
  // `LEGACY-437`: колонка NOT NULL, `null` не «не менять» — пропускается только отсутствующее поле.
  @ValidateIf((_o, value) => value !== undefined)
  @IsIn(Object.values(PrismaBookType))
  type?: PrismaBookType;

  @ApiPropertyOptional({ example: false })
  // `LEGACY-437`: колонка NOT NULL, `null` не «не менять» — пропускается только отсутствующее поле.
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  isFree?: boolean;

  @ApiPropertyOptional({ example: 'https://partner.example.com/ref/456' })
  @IsOptional()
  @IsAbsoluteHttpUrl()
  referralUrl?: string;

  @ApiPropertyOptional({ example: 'HP1 — Summary (Updated)' })
  @IsOptional()
  @IsString()
  seoMetaTitle?: string;

  @ApiPropertyOptional({ example: 'New meta description text' })
  @IsOptional()
  @IsString()
  seoMetaDescription?: string;

  @ApiPropertyOptional({
    description: 'Media asset id for audio preview (short audio sample). Pass null to clear.',
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  previewMediaId?: string | null;

  @ApiPropertyOptional({
    description: 'ID основной категории книги для хлебных крошек. Pass null to clear.',
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  primaryCategoryId?: string | null;

  @ApiPropertyOptional({
    description: 'Год первой публикации книги. Pass null to clear.',
    example: 1890,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(2100)
  firstPublishedYear?: number | null;

  @ApiPropertyOptional({
    description: 'Год публикации данного издания. Pass null to clear.',
    example: 1891,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(2100)
  editionPublishedYear?: number | null;

  @ApiPropertyOptional({ description: 'Оригинальный язык книги', example: 'en', nullable: true })
  @IsOptional()
  @IsString()
  originalLanguage?: string | null;

  @ApiPropertyOptional({
    description: 'Статус авторских прав',
    example: 'public_domain',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  copyrightStatus?: string | null;

  @ApiPropertyOptional({
    description: 'Оригинальное название книги',
    example: 'The Picture of Dorian Gray',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  originalTitle?: string | null;

  @ApiPropertyOptional({
    description: 'Альтернативные названия книги',
    example: ['Dorian Gray'],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  alternativeTitles?: string[];

  @ApiPropertyOptional({
    description: 'Краткое описание книги',
    example: 'A classic story of youth...',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(SHORT_TEXT_MAX_LENGTH)
  shortDescription?: string | null;

  @ApiPropertyOptional({
    description: 'Краткое содержание книги',
    example: 'The story follows Dorian...',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  summaryShort?: string | null;

  @ApiPropertyOptional({
    type: [BookVersionSymbolDto],
    description: 'Символы в книге',
    example: [{ title: 'Portrait', description: 'Represents the soul' }],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BookVersionSymbolDto)
  symbols?: BookVersionSymbolDto[];

  @ApiPropertyOptional({
    description: 'Альт-текст обложки',
    example: 'Vintage cover art',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  coverAlt?: string | null;

  @ApiPropertyOptional({
    description:
      "Ссылка на страницу автора: абсолютный http(s) или путь от корня (`/ru/author/oscar-wilde`); `''` и `null` — «не задано»",
    example: 'https://example.com/author/oscar-wilde',
    nullable: true,
  })
  // `''` и `null` — «не задано», как было при `@IsString()` (решение арбитра 03.10.2026, `T94`).
  @ValidateIf((_o, value) => value !== undefined && value !== null && value !== '')
  @IsAbsoluteHttpUrlOrRootPath()
  authorPageUrl?: string | null;

  @ApiPropertyOptional({
    description: 'Идентификатор автора (UUID)',
    example: '123e4567-e89b-12d3-a456-426614174000',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  authorId?: string | null;

  @ApiPropertyOptional({
    type: [BookVersionCharacterDto],
    description: 'Персонажи книги',
    example: [{ name: 'Dorian Gray', description: 'Main character' }],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BookVersionCharacterDto)
  characters?: BookVersionCharacterDto[];

  @ApiPropertyOptional({
    type: [BookVersionQuoteDto],
    description: 'Цитаты из книги',
    example: [{ text: 'To live is the rarest thing in the world.', author: 'Oscar Wilde' }],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BookVersionQuoteDto)
  quotes?: BookVersionQuoteDto[];

  @ApiPropertyOptional({
    type: [FaqItemDto],
    description: 'FAQ по книге',
    example: [{ question: 'What is the genre?', answer: 'Gothic fiction' }],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaqItemDto)
  faq?: FaqItemDto[];

  @ApiPropertyOptional({ description: 'Темы книги', example: ['Art', 'Morality'], nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  themes?: string[];
}
