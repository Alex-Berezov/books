import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Language,
  LlmOperationStatus,
  LlmPauseReason,
  TranslationChapterStatus,
  TranslationChunkStatus,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import { MONEY_DOC, MONEY_PATTERN, toMoneyString } from '../../llm/dto/llm-money';
import { LlmOperationDto } from '../../llm-worker/dto/llm-operation.dto';
import { TranslationReportFindingDto } from './translation-run-report-response.dto';
import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';

/** Блоков в правке куска не больше, чем блоков в главе разумного размера. */
const EDIT_BLOCKS_MAX = 2_000;

/** Куски главы языка запуска (`F05-7v`): `?lang=&chapter=`. */
export class TranslationChunksQueryDto {
  @ApiProperty({ enum: Language, enumName: 'Language' })
  @IsEnum(Language)
  lang!: Language;

  @ApiProperty({ type: Number, description: 'Reader chapter number of the source' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  chapter!: number;
}

/** Повтор куска заново с проверками своей операцией (`F05-7v`, шаг 1). */
export class RetryTranslationChunkDto {
  @ApiPropertyOptional({
    type: String,
    example: 'anthropic/claude-sonnet-5.5',
    description:
      'Translate model of this retry, one model without fallbacks. Default - the translate model of the run',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @ApiProperty({ ...MONEY_DOC, description: 'Limit of the retry operation' })
  @Transform(toMoneyString)
  @Matches(MONEY_PATTERN, {
    message: 'limitUsd must be a non-negative amount with up to 8 decimals',
  })
  limitUsd!: string;
}

export class EditedChunkBlockDto {
  @ApiProperty({ type: Number, description: 'Block number of the source chapter, from 1' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  n!: number;

  @ApiProperty({ type: String, description: 'Translation of the block: inline markup only' })
  @IsString()
  @MaxLength(RICH_HTML_MAX_LENGTH.body)
  text!: string;
}

/** Правка куска руками: перевод каждого переводимого блока куска (`F05-7v`, шаг 1). */
export class EditTranslationChunkDto {
  @ApiProperty({ type: () => [EditedChunkBlockDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EDIT_BLOCKS_MAX)
  @ValidateNested({ each: true })
  @Type(() => EditedChunkBlockDto)
  blocks!: EditedChunkBlockDto[];
}

/** Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7). */
export class TranslationChunkBlockDto {
  @ApiProperty({ type: Number })
  n!: number;

  @ApiProperty({ type: String, description: 'Source block, inline markup' })
  source!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Translation of the block, inline markup; empty - not translated',
  })
  translation!: string | null;
}

export class TranslationChunkRetryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  operationId!: string;

  @ApiProperty({
    type: String,
    description:
      'Stage of the retry: pending (translate), translated (checks), checked, done, flagged - before the piece is replaced; applied - the piece is replaced; failed - not replaced, reason in reason',
  })
  status!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Translate model asked for this retry; empty - the run models',
  })
  requestedModel!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Model that answered the retry' })
  model!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'failed: why the piece was not replaced (SOURCE_CHANGED, CHUNK_TOO_LONG, CHUNK_INVALID_RESPONSE, RETRY_CANCELLED - the operation was cancelled, RETRY_NOT_APPLIED - the attempt was taken off before the swap); applied: the check flag of the new translation, if any',
  })
  reason!: string | null;

  @ApiProperty({
    type: [String],
    description:
      'Paused on NO_COMPLIANT_PROVIDER (reason - the stage code, as in the run language): the models of the stage that all refused by the data policy; retry with another model. Empty otherwise',
  })
  reasonModels!: string[];

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Cost of the retry answers' })
  costUsd!: string;

  @ApiProperty({
    enum: LlmOperationStatus,
    enumName: 'LlmOperationStatus',
    nullable: true,
    description:
      'Status of the retry operation: active - going; paused - stopped on pauseReason, resume with POST /admin/llm/operations/:id/resume; cancelled, done, failed',
  })
  operationStatus!: LlmOperationStatus | null;

  @ApiProperty({ enum: LlmPauseReason, enumName: 'LlmPauseReason', nullable: true })
  pauseReason!: LlmPauseReason | null;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    nullable: true,
    description: 'Spent by the retry operation',
  })
  spentUsd!: string | null;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    nullable: true,
    description: 'Limit of the retry operation',
  })
  limitUsd!: string | null;
}

export class TranslationChunkDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: Number, description: 'Order of the piece in the chapter, from 0' })
  chunkIndex!: number;

  @ApiProperty({ type: Number })
  firstBlock!: number;

  @ApiProperty({ type: Number })
  lastBlock!: number;

  @ApiProperty({ enum: TranslationChunkStatus, enumName: 'TranslationChunkStatus' })
  status!: TranslationChunkStatus;

  @ApiProperty({ type: String, nullable: true, description: 'Code of the piece flag' })
  flagReason!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Model that translated the piece' })
  model!: string | null;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    nullable: true,
    description: 'All paid answers of the piece',
  })
  costUsd!: string | null;

  @ApiProperty({ type: Number, description: 'Translate attempts that reached a model' })
  attempts!: number;

  @ApiProperty({
    type: [String],
    description:
      'Remarks of the last failed check of the piece (why it was flagged or translated anew); empty - none',
  })
  remarks!: string[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'The piece was edited by hand: the editor answers for the text',
  })
  editedAt!: string | null;

  @ApiProperty({ type: () => TranslationChunkRetryDto, nullable: true })
  retry!: TranslationChunkRetryDto | null;

  @ApiProperty({ type: () => [TranslationChunkBlockDto] })
  blocks!: TranslationChunkBlockDto[];
}

export class TranslationChunksChapterDto {
  @ApiProperty({ enum: TranslationChapterStatus, enumName: 'TranslationChapterStatus' })
  status!: TranslationChapterStatus;

  @ApiProperty({ type: String, nullable: true })
  flagReason!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the last chapter rewrite after a retry or edit did not go through: CHAPTER_EDITED_MANUALLY, VERSION_NOT_DRAFT, DRAFT_DELETED, SOURCE_CHANGED or an assembly code',
  })
  rewriteRefusal!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Chapter of the draft',
  })
  chapterId!: string | null;

  @ApiProperty({
    type: () => [TranslationReportFindingDto],
    description:
      'Findings as in the run report; stale - found on the text before a retry or hand edit',
  })
  findings!: TranslationReportFindingDto[];
}

/** Куски главы языка запуска двумя колонками: исходник и перевод блок к блоку. */
export class TranslationChunksDto {
  @ApiProperty({ type: String, format: 'uuid' })
  runId!: string;

  @ApiProperty({ enum: Language, enumName: 'Language' })
  language!: Language;

  @ApiProperty({ type: Number })
  chapterNumber!: number;

  @ApiProperty({
    type: Boolean,
    description: 'The source chapter changed after the split: blocks may not match',
  })
  sourceChanged!: boolean;

  @ApiProperty({ type: () => TranslationChunksChapterDto, nullable: true })
  chapter!: TranslationChunksChapterDto | null;

  @ApiProperty({ type: () => [TranslationChunkDto] })
  chunks!: TranslationChunkDto[];
}

/** Повтор поставлен: операция повтора и кусок. */
export class TranslationChunkRetryStartedDto {
  @ApiProperty({ type: () => LlmOperationDto })
  operation!: LlmOperationDto;

  @ApiProperty({ type: () => TranslationChunkDto })
  chunk!: TranslationChunkDto;
}

/** Правка руками: кусок сохранён; переписана ли глава черновика и почему нет. */
export class TranslationChunkEditedDto {
  @ApiProperty({ type: () => TranslationChunkDto })
  chunk!: TranslationChunkDto;

  @ApiProperty({ type: Boolean })
  chapterRewritten!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the chapter was not rewritten (as rewriteRefusal); empty - rewritten or no draft yet',
  })
  reason!: string | null;
}
