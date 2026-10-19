import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  RICH_HTML_MAX_LENGTH,
  RichHtml,
  RichHtmlHasText,
} from '../../../shared/validators/rich-html.decorator';
import { Trim } from '../../../shared/validators/trim.decorator';

/** Пределы раздела пересказа (F04 `tech.md` §3). */
export const SUMMARY_SECTION_LIMITS = {
  title: 200,
  readerChapter: 10_000,
  sectionsPerVersion: 200,
} as const;

/**
 * Общие поля записи раздела (F04 `tech.md` §3-§4). Номера в теле нет: его ставит сервис (T4).
 * `title` — простой текст без тегов, `text` — rich HTML с видимым текстом.
 */
export class BookSummarySectionTextDto {
  @ApiProperty({ type: String, maxLength: SUMMARY_SECTION_LIMITS.title })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUMMARY_SECTION_LIMITS.title)
  @Matches(/^[^<>]*$/, { message: 'title must be plain text without tags' })
  title!: string;

  @ApiProperty({ type: String, description: 'Rich HTML with visible text' })
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  @RichHtmlHasText()
  text!: string;
}

/** Описание поля главы читалки — одно на добавление и правку. */
export const READER_CHAPTER_API = {
  type: Number,
  nullable: true,
  minimum: 1,
  maximum: SUMMARY_SECTION_LIMITS.readerChapter,
  description: 'Reader chapter for the "Read this chapter" link; a missing chapter is a warning',
} as const;

/** Добавление раздела: глава читалки необязательна (`null` или нет ключа — без главы). */
export class CreateBookSummarySectionDto extends BookSummarySectionTextDto {
  @ApiPropertyOptional(READER_CHAPTER_API)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUMMARY_SECTION_LIMITS.readerChapter)
  readerChapter?: number | null;
}
