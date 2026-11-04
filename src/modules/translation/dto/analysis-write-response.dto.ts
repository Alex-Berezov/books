import { ApiProperty } from '@nestjs/swagger';
import { ContentDraftStatus, Language } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import { LlmOperationDto } from '../../llm-worker/dto/llm-operation.dto';
import {
  ANALYSIS_ITEM_OUTCOMES,
  ANALYSIS_REVIEW_KINDS,
  ANALYSIS_VERDICTS,
  AnalysisVerdict,
  ANALYSIS_TARGETS,
  AnalysisItemOutcome,
  AnalysisTarget,
  STEP_FIX_CODES,
  STEP_OUTCOMES,
  STEP_SOURCES,
  StepFixCode,
  StepSource,
} from '../analysis-write/analysis-write.data';
import { QUOTE_CHECK_REASONS, QuoteCheckReason } from '../draft-quality/quote-check';
import { ANALYSIS_REMARK_CODES, AnalysisRemarkCode } from '../draft-quality/text-checks';
import { CompareContextLineDto, DossierContextLineDto } from './translation-compare-response.dto';

/**
 * Ход анализа `F07-1a` (`features/F07-analysis-autofill/tech.md` §5): старт, оценка и чтение хода.
 * Свои DTO по образцу хода пересказа, замечание и проверяющая - тоже свои: коды замечаний
 * анализа (`ANALYSIS_REMARK_CODES`), проверяющая анализа со своими кодами. Содержимое блоков
 * хода в ответ не идёт: блок читается ручкой анализа, предложения и «Accept» - `F07-1b`. Response
 * DTO - только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 */

export class AnalysisWriteEstimateDto {
  @ApiProperty({
    type: DossierContextLineDto,
    nullable: true,
    description: 'The dossier is built first by its own operation; null - it is ready',
  })
  dossier!: DossierContextLineDto | null;

  @ApiProperty({
    type: CompareContextLineDto,
    nullable: true,
    description:
      'The glossary of the version language is built first; null - ready or not needed (the version is in the dossier language)',
  })
  glossary!: CompareContextLineDto | null;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description:
      'Upper estimate of steps 1-3: each step reads the whole version text, plus the reviewer of each step, each step × 2 passes',
  })
  stageUsd!: string;

  @ApiProperty({
    type: Boolean,
    description: 'The dossier or the glossary is not ready: their size is taken from their stages',
  })
  upperBound!: boolean;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Default operation limit: max(steps × 1.5, dossier and glossary limits)',
  })
  suggestedLimitUsd!: string;
}

/**
 * Замечание хода анализа: только коды, которые ход ставит (`ANALYSIS_REMARK_CODES`, А4);
 * `SummaryWriteRemarkDto` - только пересказа (Р13).
 */
export class AnalysisWriteRemarkDto {
  @ApiProperty({ enum: ANALYSIS_REMARK_CODES })
  code!: AnalysisRemarkCode;

  @ApiProperty({ type: String, description: 'The field path and a short fragment, or the step' })
  where!: string;

  @ApiProperty({ type: String, description: 'What to fix, in English' })
  note!: string;

  @ApiProperty({ enum: ['code', 'model'] })
  by!: 'code' | 'model';
}

export class AnalysisWriteReviewDto {
  @ApiProperty({
    enum: ANALYSIS_REVIEW_KINDS,
    description:
      'answered - the reviewer model checked the step; otherwise why the model check was not done',
  })
  kind!: (typeof ANALYSIS_REVIEW_KINDS)[number];

  @ApiProperty({ type: String, nullable: true, description: 'The reviewer model (answered)' })
  model!: string | null;
}

export class AnalysisWriteFixDto {
  @ApiProperty({
    enum: STEP_FIX_CODES,
    description:
      'Fixed by code without a redo: CHAPTER_UNKNOWN - a chapter number not in the version removed; LIMIT_OUT - elements over the import limit cut; IMPORT_INVALID - a theme link to an unknown element dropped',
  })
  code!: StepFixCode;

  @ApiProperty({ type: String, description: 'Path of the field' })
  path!: string;

  @ApiProperty({ type: String })
  note!: string;
}

export class AnalysisWriteDroppedQuoteDto {
  @ApiProperty({ type: Number, enum: [1, 2, 3] })
  step!: number;

  @ApiProperty({
    type: String,
    description: 'Where the quotation was: keyQuotes.2, style.0.example…',
  })
  path!: string;

  @ApiProperty({ type: String, description: 'The text of the model' })
  text!: string;

  @ApiProperty({ type: Number, nullable: true })
  chapter!: number | null;

  @ApiProperty({
    enum: QUOTE_CHECK_REASONS,
    description:
      'QUOTE_NOT_VERBATIM: NOT_FOUND - not word for word in the chapter; NO_CHAPTER - no chapter; CHAPTER_MISSING - the chapter is not in the version',
  })
  reason!: QuoteCheckReason;
}

export class AnalysisWriteStepDto {
  @ApiProperty({ type: Number, enum: [1, 2, 3] })
  step!: number;

  @ApiProperty({
    enum: ANALYSIS_VERDICTS,
    description:
      'ok - no remarks; flags - remarks after the redo or no model check; failed - no text',
  })
  verdict!: AnalysisVerdict;

  @ApiProperty({
    type: [AnalysisWriteRemarkDto],
    description: 'Flags of the step: code checks, the reviewer model, CORE_MISSING after step 3',
  })
  remarks!: AnalysisWriteRemarkDto[];

  @ApiProperty({ type: Number, enum: [1, 2], description: '2 - the text of the one redo' })
  attempt!: number;

  @ApiProperty({ enum: STEP_OUTCOMES })
  outcome!: (typeof STEP_OUTCOMES)[number];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why the step gave no text: DRAFT_TOO_LONG, DRAFT_INVALID_RESPONSE',
  })
  failedReason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  authorModel!: string | null;

  @ApiProperty({ type: AnalysisWriteReviewDto, nullable: true })
  review!: AnalysisWriteReviewDto | null;

  @ApiProperty({
    enum: STEP_SOURCES,
    nullable: true,
    description: 'text - the whole version text; summaries - the chapter summaries of the dossier',
  })
  source!: StepSource | null;

  @ApiProperty({ type: [AnalysisWriteFixDto] })
  dropped!: AnalysisWriteFixDto[];
}

export class AnalysisWriteItemDto {
  @ApiProperty({ type: Number, description: 'Index of the block in the run' })
  index!: number;

  @ApiProperty({ enum: ANALYSIS_TARGETS, description: 'A block or a facts subfield' })
  target!: AnalysisTarget;

  @ApiProperty({ type: Number, enum: [1, 2, 3] })
  step!: number;

  @ApiProperty({ enum: ANALYSIS_VERDICTS })
  verdict!: AnalysisVerdict;

  @ApiProperty({ type: [AnalysisWriteRemarkDto] })
  remarks!: AnalysisWriteRemarkDto[];

  @ApiProperty({ type: AnalysisWriteReviewDto, nullable: true })
  review!: AnalysisWriteReviewDto | null;

  @ApiProperty({
    enum: ANALYSIS_ITEM_OUTCOMES,
    description:
      'written - in the analysis; proposed - a proposal; waiting - the write is not decided yet; accepted, discarded - the editor decided; none - not written (failedReason)',
  })
  outcome!: AnalysisItemOutcome;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'IMPORT_INVALID - the block failed the import after the redo; DRAFT_DATA_INVALID',
  })
  failedReason!: string | null;

  @ApiProperty({
    type: Boolean,
    description: 'themeKeys of step 3 in the characters or key quotations of steps 1-2',
  })
  links!: boolean;
}

export class AnalysisWriteDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  bookVersionId!: string;

  @ApiProperty({
    enum: ContentDraftStatus,
    description: 'A paused operation keeps the run building: the reason is operation.pauseReason',
  })
  status!: ContentDraftStatus;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty({ type: String, nullable: true, description: 'Code of the final refusal (failed)' })
  failedReason!: string | null;

  @ApiProperty({ enum: ['dossier', 'glossary'], nullable: true })
  waitingFor!: 'dossier' | 'glossary' | null;

  @ApiProperty({ type: LlmOperationDto })
  operation!: LlmOperationDto;

  @ApiProperty({ type: Number, description: 'Steps of the run in all (3)' })
  stepsTotal!: number;

  @ApiProperty({
    enum: ANALYSIS_TARGETS,
    isArray: true,
    description: 'Blocks the run writes directly: empty at the start on an unpublished version',
  })
  owns!: AnalysisTarget[];

  @ApiProperty({ type: [AnalysisWriteStepDto] })
  steps!: AnalysisWriteStepDto[];

  @ApiProperty({ type: [AnalysisWriteItemDto] })
  items!: AnalysisWriteItemDto[];

  @ApiProperty({ type: [AnalysisWriteDroppedQuoteDto] })
  droppedQuotes!: AnalysisWriteDroppedQuoteDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class AnalysisWriteStateDto {
  @ApiProperty({
    type: AnalysisWriteDto,
    nullable: true,
    description: 'The latest analysis run that is not discarded, in any status; null - none',
  })
  draft!: AnalysisWriteDto | null;
}
