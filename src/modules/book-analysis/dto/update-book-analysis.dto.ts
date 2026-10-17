import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Language } from '@prisma/client';
import {
  BOOK_ANALYSIS_LIMITS,
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
  Nested,
  NestedList,
  OptionalText,
} from './book-analysis-blocks.dto';

/**
 * Тело `PUT versions/:bookVersionId/analysis` — JSON импорта на язык версии (`tech.md` §3).
 * Слияние (T6): ключа нет — блок не трогается; `null`, `''` или `[]` — блок очищается; пришедший
 * список заменяет прежний целиком. Админка шлёт всю запись (решение А4).
 */
export class UpdateBookAnalysisDto {
  @ApiProperty({ enum: Language, description: 'Must equal the language of the version' })
  @IsIn(Object.values(Language))
  language!: Language;

  @ApiPropertyOptional({ type: BookAnalysisFactsDto, nullable: true })
  @Nested(() => BookAnalysisFactsDto)
  facts?: BookAnalysisFactsDto | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_ANALYSIS_LIMITS.mainIdea })
  @OptionalText(BOOK_ANALYSIS_LIMITS.mainIdea)
  mainIdea?: string | null;

  @ApiPropertyOptional({ type: [BookAnalysisThemeDto], nullable: true })
  @NestedList(() => BookAnalysisThemeDto, BOOK_ANALYSIS_LIMITS.themes)
  themes?: BookAnalysisThemeDto[] | null;

  @ApiPropertyOptional({ type: [BookAnalysisCharacterDto], nullable: true })
  @NestedList(() => BookAnalysisCharacterDto, BOOK_ANALYSIS_LIMITS.characters)
  characters?: BookAnalysisCharacterDto[] | null;

  @ApiPropertyOptional({ type: [BookAnalysisSymbolDto], nullable: true })
  @NestedList(() => BookAnalysisSymbolDto, BOOK_ANALYSIS_LIMITS.symbols)
  symbols?: BookAnalysisSymbolDto[] | null;

  @ApiPropertyOptional({ type: [BookAnalysisKeyQuoteDto], nullable: true })
  @NestedList(() => BookAnalysisKeyQuoteDto, BOOK_ANALYSIS_LIMITS.keyQuotes)
  keyQuotes?: BookAnalysisKeyQuoteDto[] | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_ANALYSIS_LIMITS.longText })
  @OptionalText(BOOK_ANALYSIS_LIMITS.longText)
  titleMeaning?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_ANALYSIS_LIMITS.longText })
  @OptionalText(BOOK_ANALYSIS_LIMITS.longText)
  endingMeaning?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_ANALYSIS_LIMITS.longText })
  @OptionalText(BOOK_ANALYSIS_LIMITS.longText)
  context?: string | null;

  @ApiPropertyOptional({ type: [BookAnalysisTimelineEventDto], nullable: true })
  @NestedList(() => BookAnalysisTimelineEventDto, BOOK_ANALYSIS_LIMITS.timeline)
  timeline?: BookAnalysisTimelineEventDto[] | null;

  @ApiPropertyOptional({ type: [BookAnalysisStyleDto], nullable: true })
  @NestedList(() => BookAnalysisStyleDto, BOOK_ANALYSIS_LIMITS.style)
  style?: BookAnalysisStyleDto[] | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_ANALYSIS_LIMITS.longText })
  @OptionalText(BOOK_ANALYSIS_LIMITS.longText)
  reception?: string | null;

  @ApiPropertyOptional({ type: [BookAnalysisAdaptationDto], nullable: true })
  @NestedList(() => BookAnalysisAdaptationDto, BOOK_ANALYSIS_LIMITS.adaptations)
  adaptations?: BookAnalysisAdaptationDto[] | null;

  @ApiPropertyOptional({ type: [BookAnalysisMisreadingDto], nullable: true })
  @NestedList(() => BookAnalysisMisreadingDto, BOOK_ANALYSIS_LIMITS.misreadings)
  misreadings?: BookAnalysisMisreadingDto[] | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BOOK_ANALYSIS_LIMITS.discussionQuestions)
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? (value as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : v))
      : value,
  )
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(BOOK_ANALYSIS_LIMITS.question, { each: true })
  discussionQuestions?: string[] | null;

  @ApiPropertyOptional({ type: [BookAnalysisFaqDto], nullable: true })
  @NestedList(() => BookAnalysisFaqDto, BOOK_ANALYSIS_LIMITS.faq)
  faq?: BookAnalysisFaqDto[] | null;

  @ApiPropertyOptional({ type: [BookAnalysisSourceDto], nullable: true })
  @NestedList(() => BookAnalysisSourceDto, BOOK_ANALYSIS_LIMITS.sources)
  sources?: BookAnalysisSourceDto[] | null;
}
