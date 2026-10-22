import { ApiProperty } from '@nestjs/swagger';
import { Language, TranslationRunLanguageStatus } from '@prisma/client';
import { LlmOperationDto } from '../../llm-worker/dto/llm-operation.dto';
import { TranslationRunStageModelsDto } from './translation-run-request.dto';

/**
 * Этап языка (`product.md` §2.3): строится досье, строится глоссарий, перевод кусков (с нарезкой
 * главы); у закончившего - его статус.
 */
export const TRANSLATION_RUN_STAGES = [
  'dossier',
  'glossary',
  'translate',
  'done',
  'failed',
  'cancelled',
] as const;
export type TranslationRunStage = (typeof TRANSLATION_RUN_STAGES)[number];

/** Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7). */
export class TranslationRunLanguageDto {
  @ApiProperty({ enum: Language, enumName: 'Language' })
  language!: Language;

  @ApiProperty({ enum: TranslationRunLanguageStatus, enumName: 'TranslationRunLanguageStatus' })
  status!: TranslationRunLanguageStatus;

  @ApiProperty({ enum: TRANSLATION_RUN_STAGES })
  stage!: TranslationRunStage;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Code of the last stop of this language: a pause reason or a step failure code (LLM_PROVIDER_ERROR, DOSSIER_STALE...)',
  })
  reason!: string | null;

  @ApiProperty({
    type: [String],
    description:
      'Models that all refused by the data policy (NO_COMPLIANT_PROVIDER): pick another one in stageModels; empty otherwise',
  })
  reasonModels!: string[];

  @ApiProperty({ type: Number, nullable: true, description: 'Reader chapter being translated' })
  chapterNumber!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: '«Chapter N of M»: N, from 1' })
  chapterPosition!: number | null;

  @ApiProperty({ type: Number, description: '«Chapter N of M»: M' })
  chaptersTotal!: number;

  @ApiProperty({ type: Number, description: 'Closed pieces of the current chapter' })
  chunksDone!: number;

  @ApiProperty({ type: Number, description: 'Pieces of the current chapter; 0 before its split' })
  chunksTotal!: number;

  @ApiProperty({ type: Number })
  flaggedChunks!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  glossaryId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Paused dossier or glossary operation this language waits for (DOSSIER_PAUSED)',
  })
  blockedByOperationId!: string | null;
}

export class TranslationRunDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid', description: 'Translation source version' })
  bookVersionId!: string;

  @ApiProperty({ enum: Language, enumName: 'Language' })
  sourceLanguage!: Language;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  dossierId!: string | null;

  @ApiProperty({
    type: () => TranslationRunStageModelsDto,
    description: 'Stage models of this run over its snapshot',
  })
  stageModels!: TranslationRunStageModelsDto;

  @ApiProperty({
    type: () => LlmOperationDto,
    description: 'Progress and pause live here: status, pauseReason, spent and limit',
  })
  operation!: LlmOperationDto;

  @ApiProperty({ type: () => [TranslationRunLanguageDto] })
  languages!: TranslationRunLanguageDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}
