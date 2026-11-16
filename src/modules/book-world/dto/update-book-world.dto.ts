import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
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
import {
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
  BookWorldProfileDto,
  BookWorldQuoteDto,
  BookWorldRelationDto,
  BookWorldSceneDto,
  type BookWorldImportType,
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
    description: 'Only character for now; other entity types come with their own batches',
  })
  @IsIn(BOOK_WORLD_IMPORT_TYPES, {
    message: '$property must be character (other types are not supported yet)',
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
