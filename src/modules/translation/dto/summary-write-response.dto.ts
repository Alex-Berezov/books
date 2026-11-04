import { ApiProperty } from '@nestjs/swagger';
import { ContentDraftStatus, Language, LlmOperationStatus, LlmPauseReason } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import { LlmOperationDto } from '../../llm-worker/dto/llm-operation.dto';
import { DRAFT_REMARK_CODES, DraftRemarkCode } from '../draft-quality/text-checks';
import {
  ITEM_OUTCOMES,
  ITEM_TARGETS,
  ITEM_VERDICTS,
  ItemOutcome,
  ItemVerdict,
  REVIEW_KINDS,
} from '../summary-write/summary-write.data';
import { CompareContextLineDto, DossierContextLineDto } from './translation-compare-response.dto';

/**
 * Ход пересказа `F06-2` (`features/F06-summary-autofill/tech.md` §2, §6): свои DTO, ответ заготовок
 * `F05-10` не меняется (решения арбитра `F06 | F06-1`, В2; `F06 | F06-2`, Р7). Response DTO - только
 * Swagger, без `class-validator` (`STYLE_GUIDE.md` §7); тела запросов - `summary-write-request.dto.ts`.
 */

export class SummaryWriteEstimateDto {
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
    type: Number,
    nullable: true,
    description: 'Sections of the dossier plan; null - the plan is not known yet (one per chapter)',
  })
  sections!: number | null;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description:
      'Upper estimate of the whole pipeline: every section, the full and the very short summary, each text × 2 passes of the author and the reviewer',
  })
  stageUsd!: string;

  @ApiProperty({
    type: Boolean,
    description:
      'The dossier is not ready: one section per chapter, its size from the dossier and glossary stages',
  })
  upperBound!: boolean;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Default operation limit: max(pipeline × 1.5, dossier and glossary limits)',
  })
  suggestedLimitUsd!: string;
}

export class SummaryWriteRemarkDto {
  @ApiProperty({ enum: DRAFT_REMARK_CODES })
  code!: DraftRemarkCode;

  @ApiProperty({ type: String, description: 'A short fragment of the text or the part name' })
  where!: string;

  @ApiProperty({ type: String, description: 'What to fix, in English' })
  note!: string;

  @ApiProperty({ enum: ['code', 'model'] })
  by!: 'code' | 'model';
}

export class SummaryWriteReviewDto {
  @ApiProperty({
    enum: REVIEW_KINDS,
    description:
      'answered - the reviewer model checked the text; otherwise why the model check was not done',
  })
  kind!: (typeof REVIEW_KINDS)[number];

  @ApiProperty({ type: String, nullable: true, description: 'The reviewer model (answered)' })
  model!: string | null;
}

export class SummaryWriteItemDto {
  @ApiProperty({
    type: Number,
    description: 'Index of the text in the run: the path of accept, discard, regenerate',
  })
  index!: number;

  @ApiProperty({ enum: ITEM_TARGETS })
  target!: (typeof ITEM_TARGETS)[number];

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Section number of the dossier plan (section)',
  })
  number!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Section title from the chapter titles of the version (section)',
  })
  title!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Reader chapter of the section; null - not in this version',
  })
  readerChapter!: number | null;

  @ApiProperty({ type: String, description: 'Rich HTML of the text; empty when it failed' })
  html!: string;

  @ApiProperty({ type: Number, enum: [1, 2], description: '2 - the text of the one redo' })
  attempt!: number;

  @ApiProperty({
    enum: ITEM_VERDICTS,
    description:
      'ok - no remarks; flags - remarks after the redo or no model check; failed - no text',
  })
  verdict!: ItemVerdict;

  @ApiProperty({
    type: [SummaryWriteRemarkDto],
    description: 'Flags of the code checks and the reviewer model',
  })
  remarks!: SummaryWriteRemarkDto[];

  @ApiProperty({ type: SummaryWriteReviewDto, nullable: true })
  review!: SummaryWriteReviewDto | null;

  @ApiProperty({
    enum: ITEM_OUTCOMES,
    description:
      'written - in the field; proposed - a proposal (Accept writes it); waiting - waits for the section before it to get a text; accepted, discarded - the editor decided; none - not in the field and not a proposal: no text (verdict failed) or the field refused the text (failedReason SUMMARY_WRITE_REFUSED: html kept, Regenerate or write the section by hand)',
  })
  outcome!: ItemOutcome;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the text is not in the field: DRAFT_TOO_LONG, DRAFT_INVALID_RESPONSE, DRAFT_INPUT_MISSING, DRAFT_DATA_INVALID (no text); SUMMARY_WRITE_REFUSED (the field refused it)',
  })
  failedReason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  authorModel!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The last regeneration gave no text: the previous text stays, this is why',
  })
  regenFailedReason!: string | null;

  @ApiProperty({ type: Boolean, description: 'A regeneration of this text is running' })
  regenerating!: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Operation of the running regeneration',
  })
  regenOperationId!: string | null;

  @ApiProperty({
    enum: LlmOperationStatus,
    enumName: 'LlmOperationStatus',
    nullable: true,
    description: 'Status of the regeneration operation; null - no regeneration is running',
  })
  regenOperationStatus!: LlmOperationStatus | null;

  @ApiProperty({
    enum: LlmPauseReason,
    enumName: 'LlmPauseReason',
    nullable: true,
    description: 'Why the regeneration operation is paused; null - not paused',
  })
  regenPauseReason!: LlmPauseReason | null;
}

export class SummaryWriteOwnsDto {
  @ApiProperty({ type: Boolean }) sections!: boolean;
  @ApiProperty({ type: Boolean }) full!: boolean;
  @ApiProperty({ type: Boolean }) brief!: boolean;
}

export class SummaryWriteDto {
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

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Sections in the plan; null until the dossier is ready',
  })
  plannedSections!: number | null;

  @ApiProperty({
    type: Number,
    description:
      'Sections of the plan the run has a text for (written, proposed or waiting); failed sections are not counted',
  })
  sectionsDone!: number;

  @ApiProperty({
    type: SummaryWriteOwnsDto,
    description: 'Fields the run writes directly: empty at the start on an unpublished version',
  })
  owns!: SummaryWriteOwnsDto;

  @ApiProperty({ type: [SummaryWriteItemDto] })
  items!: SummaryWriteItemDto[];

  @ApiProperty({
    type: [Number],
    description:
      'Section numbers whose proposal changes the reader chapter: Accept all is refused (ACCEPT_ALL_CHAPTER_CHANGE)',
  })
  chapterChanges!: number[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class SummaryWriteStateDto {
  @ApiProperty({
    type: SummaryWriteDto,
    nullable: true,
    description: 'The latest summary run that is not discarded, in any status; null - none',
  })
  draft!: SummaryWriteDto | null;
}
