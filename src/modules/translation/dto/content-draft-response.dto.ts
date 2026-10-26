import { ApiProperty } from '@nestjs/swagger';
import { ContentDraftKind, ContentDraftStatus, Language } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import { LlmOperationDto } from '../../llm-worker/dto/llm-operation.dto';
import { SUMMARY_DRAFT_KINDS, SummaryDraftKind } from '../content-draft/content-draft.constants';
import { CompareContextLineDto } from './translation-compare-response.dto';

/** Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7). */

export class ContentDraftEstimateDto {
  @ApiProperty({ enum: SUMMARY_DRAFT_KINDS })
  kind!: SummaryDraftKind;

  @ApiProperty({
    type: CompareContextLineDto,
    nullable: true,
    description: 'The dossier is built first by its own operation; null - it is ready',
  })
  dossier!: CompareContextLineDto | null;

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
    description:
      'Sections of the dossier plan; null - the plan is not known yet or not a sections draft',
  })
  sections!: number | null;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Upper estimate of the draft stage calls' })
  stageUsd!: string;

  @ApiProperty({
    type: Boolean,
    description: 'The dossier plan is not ready: one section per chapter is assumed',
  })
  upperBound!: boolean;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Default operation limit: max(stage × 1.5, dossier and glossary limits)',
  })
  suggestedLimitUsd!: string;
}

export class ContentDraftSectionDto {
  @ApiProperty({ type: Number, description: 'Section number of the dossier plan' })
  number!: number;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String, description: 'Rich HTML; empty when the chapters have no text' })
  text!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'First chapter of the section in the plan; null - no such chapter in this version',
  })
  readerChapter!: number | null;

  @ApiProperty({
    type: Boolean,
    description: 'The plan chapter is not among the chapters of this version',
  })
  readerChapterMissing!: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'Names not in the dossier' })
  additions!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Question to the editor' })
  question!: string | null;
}

export class ContentDraftDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  bookVersionId!: string;

  @ApiProperty({ enum: ContentDraftKind })
  kind!: ContentDraftKind;

  @ApiProperty({
    enum: ContentDraftStatus,
    description: 'A paused operation keeps the draft building: the reason is operation.pauseReason',
  })
  status!: ContentDraftStatus;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty({ type: String, nullable: true, description: 'Code of the final refusal (failed)' })
  failedReason!: string | null;

  @ApiProperty({
    enum: ['dossier', 'glossary'],
    nullable: true,
    description:
      'What the draft waits for: the dossier or the glossary built by their own operation',
  })
  waitingFor!: 'dossier' | 'glossary' | null;

  @ApiProperty({ type: LlmOperationDto })
  operation!: LlmOperationDto;

  @ApiProperty({ type: String, nullable: true })
  model!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Sections in the plan (summary_sections); null until the dossier is ready',
  })
  plannedSections!: number | null;

  @ApiProperty({
    type: [ContentDraftSectionDto],
    nullable: true,
    description: 'Section drafts so far (summary_sections)',
  })
  sections!: ContentDraftSectionDto[] | null;

  @ApiProperty({
    type: [Number],
    description:
      'Section numbers the editor has already added with «Add section» (summary_sections)',
  })
  addedSections!: number[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Rich HTML draft (summary_full, summary_brief)',
  })
  text!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Question to the editor' })
  question!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class ContentDraftStateDto {
  @ApiProperty({
    type: ContentDraftDto,
    nullable: true,
    description: 'The latest draft of this kind that is not discarded, in any status; null - none',
  })
  draft!: ContentDraftDto | null;
}
