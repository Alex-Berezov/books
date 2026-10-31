import { ApiProperty } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import {
  BookAnalysisAdaptationDto,
  BookAnalysisCharacterDto,
  BookAnalysisFactsDto,
  BookAnalysisFaqDto,
  BookAnalysisKeyQuoteDto,
  BookAnalysisMisreadingDto,
  BookAnalysisSourceDto,
  BookAnalysisStyleDto,
  BookAnalysisSymbolDto,
  BookAnalysisThemeDto,
  BookAnalysisTimelineEventDto,
} from './book-analysis-blocks.dto';

/**
 * Response DTO — только Swagger (`STYLE_GUIDE.md` §7). Белый список `tech.md` §4: блоки §3,
 * язык версии, признак ядра и даты; `null` у блока — блока нет.
 */
export class BookAnalysisResponseDto {
  @ApiProperty({ enum: Language, description: 'Language of the version' })
  language!: Language;

  @ApiProperty({
    type: Boolean,
    description: 'Core is filled (product.md §2); page and sitemap follow it',
  })
  hasCore!: boolean;

  @ApiProperty({
    type: [Number],
    description:
      'Chapter numbers of the version, ascending; chapter links are rendered only for these (empty without text)',
  })
  chapterNumbers!: number[];

  @ApiProperty({ type: BookAnalysisFactsDto, nullable: true })
  facts!: BookAnalysisFactsDto | null;

  @ApiProperty({ type: String, nullable: true })
  mainIdea!: string | null;

  @ApiProperty({ type: [BookAnalysisThemeDto], nullable: true })
  themes!: BookAnalysisThemeDto[] | null;

  @ApiProperty({ type: [BookAnalysisCharacterDto], nullable: true })
  characters!: BookAnalysisCharacterDto[] | null;

  @ApiProperty({ type: [BookAnalysisSymbolDto], nullable: true })
  symbols!: BookAnalysisSymbolDto[] | null;

  @ApiProperty({ type: [BookAnalysisKeyQuoteDto], nullable: true })
  keyQuotes!: BookAnalysisKeyQuoteDto[] | null;

  @ApiProperty({ type: String, nullable: true })
  titleMeaning!: string | null;

  @ApiProperty({ type: String, nullable: true })
  endingMeaning!: string | null;

  @ApiProperty({ type: String, nullable: true })
  context!: string | null;

  @ApiProperty({ type: [BookAnalysisTimelineEventDto], nullable: true })
  timeline!: BookAnalysisTimelineEventDto[] | null;

  @ApiProperty({ type: [BookAnalysisStyleDto], nullable: true })
  style!: BookAnalysisStyleDto[] | null;

  @ApiProperty({ type: String, nullable: true })
  reception!: string | null;

  @ApiProperty({ type: [BookAnalysisAdaptationDto], nullable: true })
  adaptations!: BookAnalysisAdaptationDto[] | null;

  @ApiProperty({ type: [BookAnalysisMisreadingDto], nullable: true })
  misreadings!: BookAnalysisMisreadingDto[] | null;

  @ApiProperty({ type: [String], nullable: true })
  discussionQuestions!: string[] | null;

  @ApiProperty({ type: [BookAnalysisFaqDto], nullable: true })
  faq!: BookAnalysisFaqDto[] | null;

  @ApiProperty({ type: [BookAnalysisSourceDto], nullable: true })
  sources!: BookAnalysisSourceDto[] | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export const BOOK_ANALYSIS_WARNING_CODES = ['chapter_not_found', 'core_incomplete'] as const;
export type BookAnalysisWarningCode = (typeof BOOK_ANALYSIS_WARNING_CODES)[number];

/** Предупреждение записи: запись сохранена (или сохранится), но что-то показано не будет. */
export class BookAnalysisWarningDto {
  @ApiProperty({ enum: BOOK_ANALYSIS_WARNING_CODES })
  code!: BookAnalysisWarningCode;

  @ApiProperty({
    type: String,
    description: 'Field path, e.g. "themes.0.chapters.1" or "keyQuotes"',
  })
  path!: string;

  @ApiProperty({ type: String })
  message!: string;
}

export class BookAnalysisSaveResponseDto {
  @ApiProperty({
    type: BookAnalysisResponseDto,
    nullable: true,
    description: 'Saved record; null on dryRun (nothing is written)',
  })
  analysis!: BookAnalysisResponseDto | null;

  @ApiProperty({ type: Boolean, description: 'Core of the merged record' })
  hasCore!: boolean;

  @ApiProperty({ type: [BookAnalysisWarningDto] })
  warnings!: BookAnalysisWarningDto[];
}

/**
 * Закрытие анализа блоком окончённой претензии (решение арбитра `F03 | F03-2`). Только то, что
 * нужно middleware фронта, чтобы закрыть адрес `/{lang}/book/{slug}/analysis` в стране блока:
 * слаги, язык, страна и срок. Ни претензии, ни причины, ни заявителя.
 */
export class BookAnalysisClaimClosureDto {
  @ApiProperty({
    type: [String],
    description: 'Slugs the page may be opened by: the book slug and the version slugs',
  })
  slugs!: string[];

  @ApiProperty({
    enum: Language,
    nullable: true,
    description:
      'Language of the closed version; the server always sets it. null is kept for compatibility and means every language of the book',
  })
  language!: Language | null;

  @ApiProperty({ type: String, nullable: true, description: 'ISO country; null — worldwide' })
  countryCode!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: Date | null;
}

export class BookAnalysisClaimClosuresResponseDto {
  @ApiProperty({ type: [BookAnalysisClaimClosureDto] })
  items!: BookAnalysisClaimClosureDto[];
}
