import { ApiProperty } from '@nestjs/swagger';
import { Language, TranslationRunLanguageStatus } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import { LlmOperationDto } from '../../llm-worker/dto/llm-operation.dto';
import { CompareContextLineDto } from './translation-compare-response.dto';
import { TranslationRunStageModelsDto } from './translation-run-request.dto';

/**
 * Этап языка (`product.md` §2.3): строится досье, строится глоссарий, перевод кусков (с нарезкой
 * главы), проверка, сборка глав и полей версии (`F05-6`); у закончившего - его статус.
 */
export const TRANSLATION_RUN_STAGES = [
  'dossier',
  'glossary',
  'translate',
  'check',
  'assemble',
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
      'Code of the last stop of this language: a pause reason or a step failure code (LLM_PROVIDER_ERROR, DOSSIER_STALE, DOSSIER_LIMIT_TOO_LOW - the run limit left is lower than the dossier or glossary limit, amount in reasonUsd...). A failed language: METADATA_INVALID, METADATA_TOO_LONG, VERSION_EXISTS, CREATE_REJECTED (text in reasonText), DRAFT_DELETED, NO_CHAPTERS_WRITTEN (no chapter could go to the draft), DOSSIER_STALE (the source changed while another language was writing its draft)',
  })
  reason!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Text of the service that refused to create the draft version (reason CREATE_REJECTED), up to 300 characters; empty otherwise',
  })
  reasonText!: string | null;

  @ApiProperty({
    type: [String],
    description:
      'Models that all refused by the data policy (NO_COMPLIANT_PROVIDER): pick another one in stageModels; empty otherwise',
  })
  reasonModels!: string[];

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    nullable: true,
    description:
      'Reason DOSSIER_LIMIT_TOO_LOW: the run limit with which the dossier or glossary operation fits (spent + reserved + its limit); resume with a run limit not lower than it. Empty otherwise',
  })
  reasonUsd!: string | null;

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

  @ApiProperty({
    type: Number,
    description: 'Chapters with a flag (seams, final check, not written): details in the report',
  })
  flaggedChapters!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  glossaryId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Paused dossier or glossary operation this language waits for (DOSSIER_PAUSED)',
  })
  blockedByOperationId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Draft version this language writes into; empty before its creation or after its deletion. Stage assemble with a draft - chapters go into the draft',
  })
  draftVersionId!: string | null;
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

  @ApiProperty({
    type: () => [LlmOperationDto],
    description:
      'Dossier and glossary operations of this run, and the paused ones its languages wait for (blockedByOperationId): own limit and spent, cancel and resume via /admin/llm/operations/:id; the run operation itself is not here',
  })
  operations!: LlmOperationDto[];

  @ApiProperty({ type: () => [TranslationRunLanguageDto] })
  languages!: TranslationRunLanguageDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

/** Строка запуска в списке книги: без хода по языкам - он в `GET /admin/translation-runs/:id`. */
export class TranslationRunListItemDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid', description: 'Translation source version' })
  bookVersionId!: string;

  @ApiProperty({ enum: Language, enumName: 'Language' })
  sourceLanguage!: Language;

  @ApiProperty({ enum: Language, enumName: 'Language', isArray: true })
  languages!: Language[];

  @ApiProperty({
    type: () => TranslationRunStageModelsDto,
    description: 'Stage models of this run over its snapshot',
  })
  stageModels!: TranslationRunStageModelsDto;

  @ApiProperty({
    type: () => LlmOperationDto,
    description: 'Status, pause reason, spent and limit of the run',
  })
  operation!: LlmOperationDto;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class TranslationRunLanguageEstimateDto {
  @ApiProperty({ enum: Language, enumName: 'Language' })
  language!: Language;

  @ApiProperty({
    type: () => CompareContextLineDto,
    nullable: true,
    description:
      'The glossary of this language is built first under its own operation; null - ready or building',
  })
  glossary!: CompareContextLineDto | null;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Contested joints by the split stage' })
  splitUsd!: string;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Upper estimate: one call per piece' })
  translateUsd!: string;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description:
      'Upper estimate: one meaning check per piece and one per joint of pieces by a model of another family than the translator (no such model - 409 CHECK_MODEL_SAME_FAMILY)',
  })
  checkUsd!: string;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description:
      'Upper estimate: one final check call per chapter by a model of another family than the translator (no such model - 409 CHECK_MODEL_SAME_FAMILY)',
  })
  finalCheckUsd!: string;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description:
      'Upper estimate: one call of the metadata stage (title, description, author, chapter titles)',
  })
  metadataUsd!: string;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Split, translate, check, final check and metadata of this language',
  })
  totalUsd!: string;
}

export class TranslationRunEstimateDto {
  @ApiProperty({ type: String, description: 'Translate model of the estimate' })
  translateModel!: string;

  @ApiProperty({ type: Number, description: 'Source chapters with text to translate' })
  chapters!: number;

  @ApiProperty({ type: Number, description: 'Pieces by code boundaries, per language' })
  chunks!: number;

  @ApiProperty({
    type: () => CompareContextLineDto,
    nullable: true,
    description:
      'The dossier is built first under its own operation (also a stale one); null - fresh and ready, or building',
  })
  dossier!: CompareContextLineDto | null;

  @ApiProperty({ type: () => [TranslationRunLanguageEstimateDto] })
  languages!: TranslationRunLanguageEstimateDto[];

  @ApiProperty({
    type: Boolean,
    description:
      'Translation estimates include an upper bound for a dossier and glossary not built yet',
  })
  upperBound!: boolean;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'All languages: split, translate and check' })
  translationsUsd!: string;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Translations plus the dossier and glossaries built first',
  })
  totalUsd!: string;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description:
      'The run limit cannot be lower: suggested limits of the dossier and glossaries built first',
  })
  minLimitUsd!: string;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Default run limit (LlmBudget.defaultRunLimitUsd)',
  })
  defaultLimitUsd!: string;

  @ApiProperty({
    type: [Number],
    description:
      'Source chapters at 80% of the chapter length limit or longer (R8): a translation may not fit',
  })
  nearLimitChapters!: number[];
}
