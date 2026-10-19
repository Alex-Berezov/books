import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { applyDecorators } from '@nestjs/common';
import { IsAbsoluteHttpsUrl } from '../../../shared/validators/absolute-http-url.decorator';
import { Trim } from '../../../shared/validators/trim.decorator';

/**
 * Блоки анализа книги (F03-1). Форма — `books-app-docs/features/F03-book-analysis/tech.md` §3,
 * та же форма — JSON импорта и промпт `prompts/book-analysis.md` (T5). Лимиты — решение арбитра А6
 * (`decisions-log.md`, метка `F03 | F03-1`). Зеркало на фронте — `books-front/lib/admin/book-analysis-blocks.ts`:
 * правка числа здесь правится и там, и в промпте.
 *
 * Строки обрезаются по краям; пустая строка у необязательного поля — «нет значения», у обязательного —
 * отказ (тот же предикат «заполнено», что у ядра: `book-analysis-core.ts`, решение А9).
 * Перекрёстные ссылки ключей проверяются не здесь, а на слитой записи (`book-analysis-refs.ts`).
 */
export const BOOK_ANALYSIS_LIMITS = {
  themes: 8,
  characters: 20,
  keyQuotes: 12,
  relations: 6,
  symbols: 10,
  themeQuotes: 3,
  timeline: 20,
  style: 10,
  adaptations: 10,
  misreadings: 8,
  discussionQuestions: 12,
  faq: 10,
  sources: 15,
  // Номера глав у одной темы или символа: «где звучит» — не перечень всей книги.
  chapters: 100,
  themeKeys: 8,
  mainIdea: 600,
  interpretation: 3000,
  quote: 500,
  // Длинные тексты блоков (смысл названия и финала, контекст, восприятие) — как толкование.
  longText: 3000,
  // Описание героя, объяснение приёма, отличия экранизации, разбор ошибки.
  mediumText: 1500,
  // Название, имя, подпись, факт карточки — как `title` у автора (F02).
  title: 300,
  label: 100,
  question: 500,
  year: 40,
  chapter: 10_000,
  adaptationYear: { min: 1800, max: 2100 },
} as const;

/** Ключ темы или героя: на него ссылаются `themeKeys`, `speakerKey`, `relations[].to`. */
export const BOOK_ANALYSIS_KEY_REGEX = /^[a-z0-9-]{1,60}$/;

export const BOOK_ANALYSIS_ROLES = ['main', 'secondary', 'minor'] as const;
export type BookAnalysisRole = (typeof BOOK_ANALYSIS_ROLES)[number];

export const BOOK_ANALYSIS_TIMELINE_KINDS = ['author', 'epoch', 'book'] as const;
export type BookAnalysisTimelineKind = (typeof BOOK_ANALYSIS_TIMELINE_KINDS)[number];

export const BOOK_ANALYSIS_ADAPTATION_KINDS = ['film', 'series', 'stage', 'other'] as const;
export type BookAnalysisAdaptationKind = (typeof BOOK_ANALYSIS_ADAPTATION_KINDS)[number];

const isAbsent = (value: unknown) => value === undefined || value === null || value === '';

/** Обязательная непустая (после обрезки) строка с пределом длины. */
const RequiredText = (max: number) =>
  applyDecorators(Trim(), IsString(), IsNotEmpty(), MaxLength(max));

/** Необязательная строка: `undefined`, `null` и `''` (в том числе из пробелов) — «нет значения». */
export const OptionalText = (max: number) =>
  applyDecorators(
    Trim(),
    ValidateIf((_o, value) => !isAbsent(value)),
    IsString(),
    MaxLength(max),
  );

const Key = () =>
  applyDecorators(
    Trim(),
    IsString(),
    Matches(BOOK_ANALYSIS_KEY_REGEX, { message: '$property must match ^[a-z0-9-]{1,60}$' }),
  );

const OptionalChapter = () =>
  applyDecorators(IsOptional(), IsInt(), Min(1), Max(BOOK_ANALYSIS_LIMITS.chapter));

const ChapterList = () =>
  applyDecorators(
    IsOptional(),
    IsArray(),
    ArrayMaxSize(BOOK_ANALYSIS_LIMITS.chapters),
    IsInt({ each: true }),
    Min(1, { each: true }),
    Max(BOOK_ANALYSIS_LIMITS.chapter, { each: true }),
  );

const KeyList = () =>
  applyDecorators(
    IsOptional(),
    IsArray(),
    ArrayMaxSize(BOOK_ANALYSIS_LIMITS.themeKeys),
    IsString({ each: true }),
    Matches(BOOK_ANALYSIS_KEY_REGEX, {
      each: true,
      message: '$property must contain keys matching ^[a-z0-9-]{1,60}$',
    }),
  );

export const NestedList = (cls: () => new () => object, max: number) =>
  applyDecorators(
    IsOptional(),
    IsArray(),
    ArrayMaxSize(max),
    ValidateNested({ each: true }),
    Type(cls),
  );

export const Nested = (cls: () => new () => object) =>
  applyDecorators(IsOptional(), ValidateNested(), Type(cls));

export class BookAnalysisFactsDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(BOOK_ANALYSIS_LIMITS.title)
  genre?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(BOOK_ANALYSIS_LIMITS.title)
  movement?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(BOOK_ANALYSIS_LIMITS.title)
  writtenYears?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(BOOK_ANALYSIS_LIMITS.title)
  settingPlace?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(BOOK_ANALYSIS_LIMITS.title)
  settingTime?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(BOOK_ANALYSIS_LIMITS.title)
  narrator?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(BOOK_ANALYSIS_LIMITS.title)
  structure?: string | null;
}

/** Цитата из книги: текст и номер главы версии (ссылка в читалку — только на существующую главу, T4). */
export class BookAnalysisQuoteDto {
  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.quote })
  @RequiredText(BOOK_ANALYSIS_LIMITS.quote)
  text!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1 })
  @OptionalChapter()
  chapter?: number | null;
}

export class BookAnalysisThemeQuoteDto extends BookAnalysisQuoteDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_ANALYSIS_LIMITS.quote })
  @OptionalText(BOOK_ANALYSIS_LIMITS.quote)
  comment?: string | null;
}

export class BookAnalysisThemeDto {
  @ApiProperty({ pattern: BOOK_ANALYSIS_KEY_REGEX.source })
  @Key()
  key!: string;

  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.title })
  @RequiredText(BOOK_ANALYSIS_LIMITS.title)
  title!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: BOOK_ANALYSIS_LIMITS.interpretation,
  })
  @OptionalText(BOOK_ANALYSIS_LIMITS.interpretation)
  interpretation?: string | null;

  @ApiPropertyOptional({ type: [Number] })
  @ChapterList()
  chapters?: number[] | null;

  @ApiPropertyOptional({ type: [BookAnalysisThemeQuoteDto] })
  @NestedList(() => BookAnalysisThemeQuoteDto, BOOK_ANALYSIS_LIMITS.themeQuotes)
  quotes?: BookAnalysisThemeQuoteDto[] | null;
}

export class BookAnalysisArcDto {
  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.title })
  @RequiredText(BOOK_ANALYSIS_LIMITS.title)
  from!: string;

  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.title })
  @RequiredText(BOOK_ANALYSIS_LIMITS.title)
  to!: string;
}

export class BookAnalysisRelationDto {
  @ApiProperty({
    pattern: BOOK_ANALYSIS_KEY_REGEX.source,
    description: 'Key of a main or secondary character',
  })
  @Key()
  to!: string;

  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.label })
  @RequiredText(BOOK_ANALYSIS_LIMITS.label)
  label!: string;
}

export class BookAnalysisCharacterDto {
  @ApiProperty({ pattern: BOOK_ANALYSIS_KEY_REGEX.source })
  @Key()
  key!: string;

  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.title })
  @RequiredText(BOOK_ANALYSIS_LIMITS.title)
  name!: string;

  @ApiProperty({ enum: BOOK_ANALYSIS_ROLES })
  @IsIn(BOOK_ANALYSIS_ROLES)
  role!: BookAnalysisRole;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_ANALYSIS_LIMITS.mediumText })
  @OptionalText(BOOK_ANALYSIS_LIMITS.mediumText)
  description?: string | null;

  @ApiPropertyOptional({ type: BookAnalysisArcDto, nullable: true })
  @Nested(() => BookAnalysisArcDto)
  arc?: BookAnalysisArcDto | null;

  @ApiPropertyOptional({ type: BookAnalysisQuoteDto, nullable: true })
  @Nested(() => BookAnalysisQuoteDto)
  quote?: BookAnalysisQuoteDto | null;

  @ApiPropertyOptional({ type: [String] })
  @KeyList()
  themeKeys?: string[] | null;

  @ApiPropertyOptional({ type: [BookAnalysisRelationDto] })
  @NestedList(() => BookAnalysisRelationDto, BOOK_ANALYSIS_LIMITS.relations)
  relations?: BookAnalysisRelationDto[] | null;
}

export class BookAnalysisSymbolDto {
  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.title })
  @RequiredText(BOOK_ANALYSIS_LIMITS.title)
  title!: string;

  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.interpretation })
  @RequiredText(BOOK_ANALYSIS_LIMITS.interpretation)
  interpretation!: string;

  @ApiPropertyOptional({ type: [Number] })
  @ChapterList()
  chapters?: number[] | null;

  @ApiPropertyOptional({ type: BookAnalysisQuoteDto, nullable: true })
  @Nested(() => BookAnalysisQuoteDto)
  quote?: BookAnalysisQuoteDto | null;
}

export class BookAnalysisKeyQuoteDto {
  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.quote })
  @RequiredText(BOOK_ANALYSIS_LIMITS.quote)
  text!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1 })
  @OptionalChapter()
  chapter?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, pattern: BOOK_ANALYSIS_KEY_REGEX.source })
  @Trim()
  @ValidateIf((_o, value) => !isAbsent(value))
  @Key()
  speakerKey?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @KeyList()
  themeKeys?: string[] | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: BOOK_ANALYSIS_LIMITS.interpretation,
  })
  @OptionalText(BOOK_ANALYSIS_LIMITS.interpretation)
  interpretation?: string | null;
}

export class BookAnalysisTimelineEventDto {
  @ApiProperty({
    maxLength: BOOK_ANALYSIS_LIMITS.year,
    description: 'Year or period, e.g. "1866" or "1860s"',
  })
  @RequiredText(BOOK_ANALYSIS_LIMITS.year)
  year!: string;

  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.title })
  @RequiredText(BOOK_ANALYSIS_LIMITS.title)
  event!: string;

  @ApiProperty({ enum: BOOK_ANALYSIS_TIMELINE_KINDS })
  @IsIn(BOOK_ANALYSIS_TIMELINE_KINDS)
  kind!: BookAnalysisTimelineKind;
}

export class BookAnalysisStyleDto {
  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.title })
  @RequiredText(BOOK_ANALYSIS_LIMITS.title)
  device!: string;

  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.mediumText })
  @RequiredText(BOOK_ANALYSIS_LIMITS.mediumText)
  explanation!: string;

  @ApiPropertyOptional({ type: BookAnalysisQuoteDto, nullable: true })
  @Nested(() => BookAnalysisQuoteDto)
  example?: BookAnalysisQuoteDto | null;
}

export class BookAnalysisAdaptationDto {
  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.title })
  @RequiredText(BOOK_ANALYSIS_LIMITS.title)
  title!: string;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(BOOK_ANALYSIS_LIMITS.adaptationYear.min)
  @Max(BOOK_ANALYSIS_LIMITS.adaptationYear.max)
  year?: number | null;

  @ApiProperty({ enum: BOOK_ANALYSIS_ADAPTATION_KINDS })
  @IsIn(BOOK_ANALYSIS_ADAPTATION_KINDS)
  kind!: BookAnalysisAdaptationKind;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_ANALYSIS_LIMITS.mediumText })
  @OptionalText(BOOK_ANALYSIS_LIMITS.mediumText)
  differences?: string | null;
}

export class BookAnalysisMisreadingDto {
  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.question })
  @RequiredText(BOOK_ANALYSIS_LIMITS.question)
  myth!: string;

  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.mediumText })
  @RequiredText(BOOK_ANALYSIS_LIMITS.mediumText)
  explanation!: string;
}

export class BookAnalysisFaqDto {
  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.question })
  @RequiredText(BOOK_ANALYSIS_LIMITS.question)
  question!: string;

  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.longText })
  @RequiredText(BOOK_ANALYSIS_LIMITS.longText)
  answer!: string;
}

export class BookAnalysisSourceDto {
  @ApiProperty({ maxLength: BOOK_ANALYSIS_LIMITS.title })
  @RequiredText(BOOK_ANALYSIS_LIMITS.title)
  title!: string;

  @ApiProperty({ description: 'Absolute https URL' })
  @Trim()
  @IsNotEmpty()
  @IsAbsoluteHttpsUrl()
  url!: string;
}
