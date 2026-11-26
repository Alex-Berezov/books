import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { Language } from '@prisma/client';
import {
  BOOK_ANALYSIS_ROLES,
  BookAnalysisFaqDto,
  BookAnalysisSourceDto,
  type BookAnalysisRole,
} from '../../book-analysis/dto/book-analysis-blocks.dto';
import { Trim } from '../../../shared/validators/trim.decorator';
import {
  isAbsent,
  Key,
  Nested,
  NestedList,
  OptionalText,
  RequiredText,
} from '../../../shared/validators/block-fields.decorator';
import {
  BOOK_WORLD_IMPORT_TYPES,
  BOOK_WORLD_KEY_REGEX,
  BOOK_WORLD_LIMITS,
  BookWorldAdaptationDto,
  BookWorldArcDto,
  BookWorldChapterExclusionDto,
  BookWorldCompareDto,
  BookWorldProfileDto,
  BookWorldQuoteDto,
  BookWorldRelationDto,
  BookWorldSceneDto,
  WIKIDATA_ID_MAX,
  WIKIDATA_ID_REGEX,
  WORLD_PLACE_KINDS,
  type BookWorldImportType,
  type WorldPlaceKind,
} from './book-world-blocks.dto';

const trimEach = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? (value as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : v))
    : value;

/**
 * Сущность в JSON импорта (`tech.md` §3): плоский объект, в базе блоки лежат в `blocks`
 * (решение арбитра `F08 | F08-1` R7). Слияние как у анализа: поля нет — прежнее; `null`, `''`
 * или `[]` — очищено; пришедший список заменяет прежний целиком. `name` обязателен у новой сущности.
 * `critique`, `prototypes`, `adaptations` — только при `sources` (на слитой записи, `world-refs.ts`).
 */
export class BookWorldEntityInputDto {
  @ApiProperty({ pattern: BOOK_WORLD_KEY_REGEX.source })
  @Key()
  key!: string;

  @ApiProperty({
    enum: BOOK_WORLD_IMPORT_TYPES,
    description:
      'character, pair (F08-8c) or place (F08-12a); other entity types come with their own batches. ' +
      'A pair key is {a}--{b}: two character keys of the version in alphabetical order',
  })
  @IsIn(BOOK_WORLD_IMPORT_TYPES, {
    message: '$property must be character, pair or place (other types are not supported yet)',
  })
  type!: BookWorldImportType;

  @ApiPropertyOptional({
    type: String,
    maxLength: BOOK_WORLD_LIMITS.name,
    description: 'Required for a new entity',
  })
  @IsOptional()
  @RequiredText(BOOK_WORLD_LIMITS.name)
  name?: string | null;

  @ApiPropertyOptional({ enum: BOOK_ANALYSIS_ROLES, nullable: true })
  @IsOptional()
  @IsIn(BOOK_ANALYSIS_ROLES)
  role?: BookAnalysisRole | null;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description: 'Name forms for mention search (F08-2)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BOOK_WORLD_LIMITS.aliases)
  @Transform(trimEach)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(BOOK_WORLD_LIMITS.name, { each: true })
  aliases?: string[] | null;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description:
      'Name forms excluded from mention search: false matches with ordinary words (F08-2)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BOOK_WORLD_LIMITS.aliases)
  @Transform(trimEach)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(BOOK_WORLD_LIMITS.name, { each: true })
  aliasExclusions?: string[] | null;

  @ApiPropertyOptional({
    type: [BookWorldChapterExclusionDto],
    nullable: true,
    description:
      'Chapters where a name form is not counted: namesakes sharing the form (F08-8a). ' +
      'Only this form, only these chapters; a form that is not searched or a chapter not in the version has no effect',
  })
  @NestedList(() => BookWorldChapterExclusionDto, BOOK_WORLD_LIMITS.chapterExclusions)
  aliasChapterExclusions?: BookWorldChapterExclusionDto[] | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_WORLD_LIMITS.short })
  @OptionalText(BOOK_WORLD_LIMITS.short)
  short?: string | null;

  @ApiPropertyOptional({ type: BookWorldProfileDto, nullable: true })
  @Nested(() => BookWorldProfileDto)
  profile?: BookWorldProfileDto | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_WORLD_LIMITS.appearance })
  @OptionalText(BOOK_WORLD_LIMITS.appearance)
  appearance?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_WORLD_LIMITS.character })
  @OptionalText(BOOK_WORLD_LIMITS.character)
  character?: string | null;

  @ApiPropertyOptional({ type: BookWorldArcDto, nullable: true })
  @Nested(() => BookWorldArcDto)
  arc?: BookWorldArcDto | null;

  @ApiPropertyOptional({ type: [BookWorldSceneDto], nullable: true })
  @NestedList(() => BookWorldSceneDto, BOOK_WORLD_LIMITS.scenes)
  scenes?: BookWorldSceneDto[] | null;

  @ApiPropertyOptional({ type: [BookWorldRelationDto], nullable: true })
  @NestedList(() => BookWorldRelationDto, BOOK_WORLD_LIMITS.relations)
  relations?: BookWorldRelationDto[] | null;

  @ApiPropertyOptional({ type: [BookWorldQuoteDto], nullable: true })
  @NestedList(() => BookWorldQuoteDto, BOOK_WORLD_LIMITS.quotes)
  quotes?: BookWorldQuoteDto[] | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_WORLD_LIMITS.critique })
  @OptionalText(BOOK_WORLD_LIMITS.critique)
  critique?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_WORLD_LIMITS.prototypes })
  @OptionalText(BOOK_WORLD_LIMITS.prototypes)
  prototypes?: string | null;

  @ApiPropertyOptional({ type: [BookWorldAdaptationDto], nullable: true })
  @NestedList(() => BookWorldAdaptationDto, BOOK_WORLD_LIMITS.adaptations)
  adaptations?: BookWorldAdaptationDto[] | null;

  @ApiPropertyOptional({
    type: [BookWorldCompareDto],
    nullable: true,
    description: 'Pairs only (F08-8c): comparison table, at least 4 rows for the page core',
  })
  @NestedList(() => BookWorldCompareDto, BOOK_WORLD_LIMITS.compare)
  compare?: BookWorldCompareDto[] | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: BOOK_WORLD_LIMITS.mediumText,
    description: 'Pairs only: what binds the two characters',
  })
  @OptionalText(BOOK_WORLD_LIMITS.mediumText)
  bonds?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: BOOK_WORLD_LIMITS.mediumText,
    description: 'Pairs only: what sets the two characters apart',
  })
  @OptionalText(BOOK_WORLD_LIMITS.mediumText)
  differences?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: BOOK_WORLD_LIMITS.mediumText,
    description: 'Pairs only: conclusion of the comparison; required for the page core',
  })
  @OptionalText(BOOK_WORLD_LIMITS.mediumText)
  conclusion?: string | null;

  @ApiPropertyOptional({
    enum: WORLD_PLACE_KINDS,
    nullable: true,
    description: 'Places only (F08-12a): real or fictional; required for the page core',
  })
  @Trim()
  @ValidateIf((_o, value) => !isAbsent(value))
  @IsIn(WORLD_PLACE_KINDS)
  kind?: WorldPlaceKind | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: BOOK_WORLD_LIMITS.location,
    description: 'Places only: where the place is, as text',
  })
  @OptionalText(BOOK_WORLD_LIMITS.location)
  location?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: BOOK_WORLD_LIMITS.significance,
    description: 'Places only: what the place means in the book; required for the page core',
  })
  @OptionalText(BOOK_WORLD_LIMITS.significance)
  significance?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: BOOK_WORLD_LIMITS.description,
    description: 'Places only: how the place looks in the text',
  })
  @OptionalText(BOOK_WORLD_LIMITS.description)
  description?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: WIKIDATA_ID_REGEX.source,
    description:
      'Places only, kind real: Wikidata item (Q90). The server reads the coordinates (P625) ' +
      'from Wikidata and checks the label against the name; coordinates are never taken from input',
  })
  @Trim()
  @ValidateIf((_o, value) => !isAbsent(value))
  @IsString()
  @MaxLength(WIKIDATA_ID_MAX)
  @Matches(WIKIDATA_ID_REGEX)
  wikidataId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: BOOK_WORLD_LIMITS.imageBrief,
    description:
      'Characters and places (F08-12b): illustration brief for the editors (English, with the book title ' +
      'and author; a character by Appearance, a place 16:9 by Description); editor-only, never in the ' +
      'public entity (F08-11d-2)',
  })
  @OptionalText(BOOK_WORLD_LIMITS.imageBrief)
  imageBrief?: string | null;

  /**
   * Только для записи ходом «Write World»: отпечаток основы ТЗ («Внешности» героя, «Описания» места), по которой модель написала ТЗ
   * (решение `F08 | F08-11d-2`). Без декораторов — в теле запроса это лишнее поле, 400 whitelist.
   */
  declare imageBriefFor?: string | null;

  @ApiPropertyOptional({ type: [BookAnalysisFaqDto], nullable: true })
  @NestedList(() => BookAnalysisFaqDto, BOOK_WORLD_LIMITS.faq)
  faq?: BookAnalysisFaqDto[] | null;

  @ApiPropertyOptional({ type: [BookAnalysisSourceDto], nullable: true })
  @NestedList(() => BookAnalysisSourceDto, BOOK_WORLD_LIMITS.sources)
  sources?: BookAnalysisSourceDto[] | null;
}

/**
 * Тело `PUT versions/:bookVersionId/world` — JSON импорта на язык версии. Сущность, которой нет
 * в теле, не трогается и не удаляется (удаление — `DELETE .../world/:key`).
 */
export class UpdateBookWorldDto {
  @ApiProperty({ enum: Language, description: 'Must equal the language of the version' })
  @IsIn(Object.values(Language))
  language!: Language;

  @ApiProperty({ type: [BookWorldEntityInputDto] })
  @IsArray()
  @ArrayMaxSize(BOOK_WORLD_LIMITS.entities)
  @ValidateNested({ each: true })
  @Type(() => BookWorldEntityInputDto)
  entities!: BookWorldEntityInputDto[];
}

/** Тело `PUT versions/:bookVersionId/world/:key`: одна сущность; ключ в теле необязателен и равен адресу. */
export class UpdateBookWorldEntityDto extends OmitType(BookWorldEntityInputDto, ['key'] as const) {
  @ApiProperty({ enum: Language, description: 'Must equal the language of the version' })
  @IsIn(Object.values(Language))
  language!: Language;

  @ApiPropertyOptional({
    pattern: BOOK_WORLD_KEY_REGEX.source,
    description: 'Optional; must equal the key in the path',
  })
  @IsOptional()
  @Key()
  key?: string;
}
