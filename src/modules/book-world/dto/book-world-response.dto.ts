import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language, WorldEntityType } from '@prisma/client';
import {
  BOOK_ANALYSIS_ROLES,
  BookAnalysisFaqDto,
  BookAnalysisSourceDto,
  type BookAnalysisRole,
} from '../../book-analysis/dto/book-analysis-blocks.dto';
import {
  BookWorldAdaptationDto,
  BookWorldArcDto,
  BookWorldProfileDto,
  BookWorldQuoteDto,
  BookWorldRelationDto,
  BookWorldSceneDto,
} from './book-world-blocks.dto';

/**
 * Response DTO — только Swagger (`STYLE_GUIDE.md` §7). Один тип ответа на редактора и читателя
 * (`tech.md` §3, риск R3): служебное — только в `editor`, которого у читателя нет вовсе.
 */
export class BookWorldEditorDto {
  @ApiProperty({ type: Boolean })
  isVisible!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  autoTextAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'First time on the site; after it the entity cannot be deleted',
  })
  firstPublishedAt!: Date | null;

  @ApiProperty({
    type: [String],
    description: 'Core parts still missing (world-core.ts), e.g. "quotes", "mentions"',
  })
  missing!: string[];
}

export class BookWorldEntitySummaryDto {
  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ enum: WorldEntityType, enumName: 'WorldEntityType' })
  type!: WorldEntityType;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ enum: BOOK_ANALYSIS_ROLES, nullable: true })
  role!: BookAnalysisRole | null;

  @ApiProperty({ type: String, nullable: true })
  short!: string | null;

  @ApiProperty({ type: Boolean, description: 'Core of the entity is filled (product.md §3)' })
  hasCore!: boolean;

  @ApiProperty({ type: Boolean })
  isIndexable!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({
    type: BookWorldEditorDto,
    description: 'Editors only; absent for readers',
  })
  editor?: BookWorldEditorDto;
}

export class BookWorldListResponseDto {
  @ApiProperty({ enum: Language, description: 'Language of the version' })
  language!: Language;

  @ApiProperty({
    type: [BookWorldEntitySummaryDto],
    description: 'Readers: public entities only; editors: every entity of the version',
  })
  entities!: BookWorldEntitySummaryDto[];
}

/**
 * Посчитанное присутствие по главам (`F08-2`); в F08-1 только читается. Наружу — только эти поля
 * (белый список `readMentions`): счёт по главам и совместное присутствие добавит пачка подсчёта.
 */
export class BookWorldMentionsDto {
  @ApiProperty({ type: [Number], description: 'Chapters the entity is found in, ascending' })
  chapters!: number[];

  @ApiProperty({ type: Number, nullable: true, description: 'First chapter it is found in' })
  first!: number | null;
}

export class BookWorldEntityDto extends BookWorldEntitySummaryDto {
  @ApiProperty({ type: [String], nullable: true })
  aliases!: string[] | null;

  @ApiProperty({ type: BookWorldProfileDto, nullable: true })
  profile!: BookWorldProfileDto | null;

  @ApiProperty({ type: String, nullable: true })
  appearance!: string | null;

  @ApiProperty({ type: String, nullable: true })
  character!: string | null;

  @ApiProperty({ type: BookWorldArcDto, nullable: true })
  arc!: BookWorldArcDto | null;

  @ApiProperty({ type: [BookWorldSceneDto], nullable: true })
  scenes!: BookWorldSceneDto[] | null;

  @ApiProperty({ type: [BookWorldRelationDto], nullable: true })
  relations!: BookWorldRelationDto[] | null;

  @ApiProperty({ type: [BookWorldQuoteDto], nullable: true })
  quotes!: BookWorldQuoteDto[] | null;

  @ApiProperty({ type: String, nullable: true })
  critique!: string | null;

  @ApiProperty({ type: String, nullable: true })
  prototypes!: string | null;

  @ApiProperty({ type: [BookWorldAdaptationDto], nullable: true })
  adaptations!: BookWorldAdaptationDto[] | null;

  @ApiProperty({ type: [BookAnalysisFaqDto], nullable: true })
  faq!: BookAnalysisFaqDto[] | null;

  @ApiProperty({ type: [BookAnalysisSourceDto], nullable: true })
  sources!: BookAnalysisSourceDto[] | null;

  @ApiProperty({ type: BookWorldMentionsDto, nullable: true })
  mentions!: BookWorldMentionsDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class BookWorldEntityResponseDto {
  @ApiProperty({ enum: Language, description: 'Language of the version' })
  language!: Language;

  @ApiProperty({
    type: [Number],
    description:
      'Chapter numbers of the version, ascending; chapter links are rendered only for these (empty without text)',
  })
  chapterNumbers!: number[];

  @ApiProperty({ type: BookWorldEntityDto })
  entity!: BookWorldEntityDto;
}

export const BOOK_WORLD_WARNING_CODES = ['core_incomplete'] as const;
export type BookWorldWarningCode = (typeof BOOK_WORLD_WARNING_CODES)[number];

/** Предупреждение записи: сущность сохранена (или сохранится), но страницы у неё не будет. */
export class BookWorldWarningDto {
  @ApiProperty({ enum: BOOK_WORLD_WARNING_CODES })
  code!: BookWorldWarningCode;

  @ApiProperty({
    type: String,
    description: 'Field path, e.g. "entities.0.quotes" or "mentions"',
  })
  path!: string;

  @ApiProperty({ type: String })
  message!: string;
}

export class BookWorldSavedEntityDto {
  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: Boolean, description: 'The entity did not exist before this save' })
  created!: boolean;

  @ApiProperty({ type: Boolean, description: 'Core of the merged entity' })
  hasCore!: boolean;

  @ApiProperty({ type: [BookWorldWarningDto] })
  warnings!: BookWorldWarningDto[];
}

export class BookWorldSaveResponseDto {
  @ApiProperty({
    type: BookWorldListResponseDto,
    nullable: true,
    description: 'Every entity of the version after the save; null on dryRun (nothing is written)',
  })
  world!: BookWorldListResponseDto | null;

  @ApiProperty({
    type: [BookWorldSavedEntityDto],
    description: 'Entities of the body, in body order',
  })
  entities!: BookWorldSavedEntityDto[];
}

export class BookWorldEntitySaveResponseDto {
  @ApiProperty({
    type: BookWorldEntityDto,
    nullable: true,
    description: 'Saved entity; null on dryRun (nothing is written)',
  })
  entity!: BookWorldEntityDto | null;

  @ApiProperty({ type: Boolean, description: 'Core of the merged entity' })
  hasCore!: boolean;

  @ApiProperty({ type: [BookWorldWarningDto] })
  warnings!: BookWorldWarningDto[];
}
