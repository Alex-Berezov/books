import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import {
  IsEnum,
  IsString,
  MinLength,
  IsOptional,
  IsArray,
  ValidateNested,
  Matches,
  MaxLength,
  ValidateIf,
  ArrayMaxSize,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { UpdateSeoDto } from '../../seo/dto/update-seo.dto';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';
import {
  FAQ_ANSWER_MAX_LENGTH,
  FAQ_QUESTION_MAX_LENGTH,
} from '../../../shared/constants/validation';
import { IsAbsoluteHttpUrl } from '../../../shared/validators/absolute-http-url.decorator';
import {
  AUTHOR_PAGE_LIMITS,
  AuthorAdaptationDto,
  AuthorAwardDto,
  AuthorFactsDto,
  AuthorFunFactDto,
  AuthorInfluencesDto,
  AuthorNotableWorkDto,
  AuthorSourceDto,
  AuthorStartHereDto,
  AuthorTimelineEventDto,
} from './author-page-blocks.dto';

export class AuthorQuoteDto {
  @ApiProperty({ description: 'Text of the quote' })
  @IsString()
  text!: string;

  @ApiPropertyOptional({ description: 'Source of the quote' })
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Slug of the book on the site the quote is from (F02-2); `null`/empty — none',
  })
  // Обрезка краёв — как у остальных слагов блоков (`OptionalSlug`, `tech.md` §2).
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_o, value) => value !== undefined && value !== null && value !== '')
  @IsString()
  @MaxLength(AUTHOR_PAGE_LIMITS.slug)
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  bookSlug?: string | null;
}

export class AuthorFaqDto {
  @ApiProperty({ description: 'Question text', maxLength: FAQ_QUESTION_MAX_LENGTH })
  @IsString()
  @MaxLength(FAQ_QUESTION_MAX_LENGTH)
  question!: string;

  @ApiProperty({ description: 'Answer text', maxLength: FAQ_ANSWER_MAX_LENGTH })
  @IsString()
  @MaxLength(FAQ_ANSWER_MAX_LENGTH)
  answer!: string;
}

export class AuthorTranslationDto {
  @ApiProperty({ enum: Language })
  @IsEnum(Language)
  language!: Language;

  @ApiProperty({ description: 'Name of the author in this language' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({
    description: 'Author unique slug for this language',
    example: 'oscar-wilde',
    pattern: SLUG_PATTERN,
  })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiPropertyOptional({ description: 'Biography of the author in this language' })
  @IsOptional()
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  biography?: string;

  @ApiPropertyOptional({
    description: 'Wikidata URL for this language',
    example: 'https://www.wikidata.org/wiki/Q30875',
  })
  // `javascript:` в ссылке исполнился бы по клику на сайте или в админке (`LEGACY-447`).
  // `''` — «не задано», как было при `@IsString()`: пачка сужает формат адреса, а не пустое
  // значение (решение арбитра T94, `decisions-log.md` 03.10.2026).
  @ValidateIf((_o, value) => value !== undefined && value !== null && value !== '')
  @IsAbsoluteHttpUrl()
  wikidataUrl?: string;

  @ApiPropertyOptional({
    description: 'Wikipedia URL for this language',
    example: 'https://en.wikipedia.org/wiki/Oscar_Wilde',
  })
  // `''` — «не задано», как было при `@IsString()`: пачка сужает формат адреса, а не пустое
  // значение (решение арбитра T94, `decisions-log.md` 03.10.2026).
  @ValidateIf((_o, value) => value !== undefined && value !== null && value !== '')
  @IsAbsoluteHttpUrl()
  wikipediaUrl?: string;

  @ApiPropertyOptional({
    description: 'Author photo URL for this language',
    example: 'https://example.com/author.jpg',
  })
  // `''` — «не задано», как было при `@IsString()`: пачка сужает формат адреса, а не пустое
  // значение (решение арбитра T94, `decisions-log.md` 03.10.2026).
  @ValidateIf((_o, value) => value !== undefined && value !== null && value !== '')
  @IsAbsoluteHttpUrl()
  photoUrl?: string;

  @ApiPropertyOptional({ description: 'Quotes array', type: [AuthorQuoteDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHOR_PAGE_LIMITS.quotes)
  @ValidateNested({ each: true })
  @Type(() => AuthorQuoteDto)
  quotes?: AuthorQuoteDto[];

  @ApiPropertyOptional({ description: 'FAQ array', type: [AuthorFaqDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AuthorFaqDto)
  faq?: AuthorFaqDto[];

  // F02-2: блоки страницы автора. `null` или `[]` у поля верхнего уровня — «блока нет»
  // (так фронт очищает поле при импорте, T5); форма элементов — `author-page-blocks.dto.ts`.
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: AUTHOR_PAGE_LIMITS.tagline })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_o, value) => value !== undefined && value !== null && value !== '')
  @IsString()
  @MaxLength(AUTHOR_PAGE_LIMITS.tagline)
  tagline?: string | null;

  @ApiPropertyOptional({ type: AuthorFactsDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => AuthorFactsDto)
  facts?: AuthorFactsDto | null;

  @ApiPropertyOptional({ type: [AuthorNotableWorkDto], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHOR_PAGE_LIMITS.notableWorks)
  @ValidateNested({ each: true })
  @Type(() => AuthorNotableWorkDto)
  notableWorks?: AuthorNotableWorkDto[] | null;

  @ApiPropertyOptional({ type: [AuthorStartHereDto], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHOR_PAGE_LIMITS.startHere.list)
  @ValidateNested({ each: true })
  @Type(() => AuthorStartHereDto)
  startHere?: AuthorStartHereDto[] | null;

  @ApiPropertyOptional({ type: [AuthorTimelineEventDto], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHOR_PAGE_LIMITS.timeline.list)
  @ValidateNested({ each: true })
  @Type(() => AuthorTimelineEventDto)
  timeline?: AuthorTimelineEventDto[] | null;

  @ApiPropertyOptional({ type: AuthorInfluencesDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => AuthorInfluencesDto)
  influences?: AuthorInfluencesDto | null;

  @ApiPropertyOptional({ type: [AuthorAwardDto], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHOR_PAGE_LIMITS.awards)
  @ValidateNested({ each: true })
  @Type(() => AuthorAwardDto)
  awards?: AuthorAwardDto[] | null;

  @ApiPropertyOptional({ type: [AuthorAdaptationDto], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHOR_PAGE_LIMITS.adaptations)
  @ValidateNested({ each: true })
  @Type(() => AuthorAdaptationDto)
  adaptations?: AuthorAdaptationDto[] | null;

  @ApiPropertyOptional({ type: [AuthorFunFactDto], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHOR_PAGE_LIMITS.funFacts.list)
  @ValidateNested({ each: true })
  @Type(() => AuthorFunFactDto)
  funFacts?: AuthorFunFactDto[] | null;

  @ApiPropertyOptional({ type: [AuthorSourceDto], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHOR_PAGE_LIMITS.sources)
  @ValidateNested({ each: true })
  @Type(() => AuthorSourceDto)
  sources?: AuthorSourceDto[] | null;

  @ApiPropertyOptional({ description: 'Slugs of similar authors', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  similarSlugs?: string[];

  @ApiPropertyOptional({ description: 'SEO metadata for this language', type: UpdateSeoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSeoDto)
  seo?: UpdateSeoDto;
}
