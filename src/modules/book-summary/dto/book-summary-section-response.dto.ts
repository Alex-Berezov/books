import { ApiProperty } from '@nestjs/swagger';

/**
 * Ответы ручек разделов пересказа (F04 `tech.md` §4) — только Swagger, без `class-validator`
 * (`STYLE_GUIDE.md` §7). `contentDate` — дата адреса раздела: позднейшая из правки текста
 * (`updatedAt`) и смены номера (`movedAt`), T6.
 */
/** Коды предупреждений записи раздела: раздел сохранён, но ссылки на главу не будет. */
export const BOOK_SUMMARY_SECTION_WARNING_CODES = ['chapter_not_found'] as const;
export type BookSummarySectionWarningCode = (typeof BOOK_SUMMARY_SECTION_WARNING_CODES)[number];

export class BookSummarySectionWarningDto {
  @ApiProperty({ enum: BOOK_SUMMARY_SECTION_WARNING_CODES })
  code!: BookSummarySectionWarningCode;

  @ApiProperty({ type: String, description: 'Field path: "readerChapter"' })
  path!: string;

  @ApiProperty({ type: String })
  message!: string;
}

export class BookSummarySectionListItemDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: Number })
  number!: number;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: Number, nullable: true })
  readerChapter!: number | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'Last edit of the section text' })
  updatedAt!: Date;
}

export class BookSummarySectionListDto {
  @ApiProperty({ type: [BookSummarySectionListItemDto] })
  sections!: BookSummarySectionListItemDto[];
}

/** Раздел для админки — по `id`; `updatedAt` вкладка шлёт в `expectedUpdatedAt`. */
export class BookSummarySectionAdminDto extends BookSummarySectionListItemDto {
  @ApiProperty({ type: String, description: 'Rich HTML' })
  text!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Date of the section address: the later of the text edit and the number change',
  })
  contentDate!: Date;
}

export class BookSummarySectionTocItemDto {
  @ApiProperty({ type: Number })
  number!: number;

  @ApiProperty({ type: String })
  title!: string;
}

/** Публичная страница раздела — одним запросом (`product.md` §5 п.6-п.9). */
export class BookSummarySectionPageDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: Number })
  number!: number;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String, description: 'Rich HTML' })
  text!: string;

  @ApiProperty({ type: Number, nullable: true })
  readerChapter!: number | null;

  @ApiProperty({ type: Boolean, description: 'readerChapter exists in this version' })
  readerChapterExists!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Date of the section address: the later of the text edit and the number change',
  })
  contentDate!: Date;

  @ApiProperty({ type: [BookSummarySectionTocItemDto], description: 'All sections by number' })
  sections!: BookSummarySectionTocItemDto[];

  @ApiProperty({ type: Boolean, description: 'The version has a very short summary with text' })
  briefHasText!: boolean;
}

export class BookSummarySectionCreateResponseDto {
  @ApiProperty({ type: BookSummarySectionAdminDto })
  section!: BookSummarySectionAdminDto;

  @ApiProperty({ type: [BookSummarySectionListItemDto] })
  sections!: BookSummarySectionListItemDto[];

  @ApiProperty({ type: [BookSummarySectionWarningDto] })
  warnings!: BookSummarySectionWarningDto[];
}

export class BookSummarySectionUpdateResponseDto {
  @ApiProperty({ type: BookSummarySectionAdminDto })
  section!: BookSummarySectionAdminDto;

  @ApiProperty({ type: [BookSummarySectionWarningDto] })
  warnings!: BookSummarySectionWarningDto[];
}

export class BookSummarySectionsSitemapSectionDto {
  @ApiProperty({ type: Number })
  number!: number;

  @ApiProperty({ type: String, format: 'date-time', description: 'contentDate of the section' })
  lastmod!: Date;
}

/** Элемент карты разделов — версия со всеми своими разделами (T10). */
export class BookSummarySectionsSitemapItemDto {
  @ApiProperty({ type: String, description: 'Version slug' })
  slug!: string;

  @ApiProperty({ type: [BookSummarySectionsSitemapSectionDto] })
  sections!: BookSummarySectionsSitemapSectionDto[];
}
