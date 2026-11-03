import { ApiProperty } from '@nestjs/swagger';
import { ContentDraftStatus, Language } from '@prisma/client';
import {
  BookAnalysisCharacterDto,
  BookAnalysisFactsDto,
  BookAnalysisKeyQuoteDto,
  BookAnalysisStyleDto,
} from '../../book-analysis/dto/book-analysis-blocks.dto';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import { LlmOperationDto } from '../../llm-worker/dto/llm-operation.dto';
import {
  CONTENT_DRAFT_KINDS,
  DraftKind,
  DROPPED_QUOTE_REASONS,
  DroppedQuoteReason,
} from '../content-draft/content-draft.constants';
import { DossierMotifDto } from './dossier-data.dto';
import { CompareContextLineDto, DossierContextLineDto } from './translation-compare-response.dto';

/** Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7). */

export class ContentDraftEstimateDto {
  @ApiProperty({ enum: CONTENT_DRAFT_KINDS })
  kind!: DraftKind;

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

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Upper estimate of the draft stage calls' })
  stageUsd!: string;

  @ApiProperty({
    type: Boolean,
    description:
      'The dossier is not ready: its size is assumed from the dossier and glossary stages',
  })
  upperBound!: boolean;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Default operation limit: max(stage × 1.5, dossier and glossary limits)',
  })
  suggestedLimitUsd!: string;
}

/**
 * JSON импорта вкладки Analysis (`F05-11`, `tech.md` §2б): только эти ключи; ключа нет - импорт
 * блок не трогает. Блоки - те же классы, что у ответа анализа.
 */
export class ContentDraftAnalysisDto {
  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty({ type: BookAnalysisFactsDto, required: false })
  facts?: BookAnalysisFactsDto;

  @ApiProperty({ type: [BookAnalysisCharacterDto], required: false })
  characters?: BookAnalysisCharacterDto[];

  @ApiProperty({ type: [BookAnalysisKeyQuoteDto], required: false })
  keyQuotes?: BookAnalysisKeyQuoteDto[];

  @ApiProperty({ type: [BookAnalysisStyleDto], required: false })
  style?: BookAnalysisStyleDto[];
}

/** Цитата заготовки Analysis, выкинутая проверкой дословности (решение арбитра `F05 | F05-11`, Р9). */
export class ContentDraftDroppedQuoteDto {
  @ApiProperty({
    type: String,
    description: 'keyQuotes, characters.<key>.quote or style.<index>.example',
  })
  path!: string;

  @ApiProperty({ type: String })
  text!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Chapter given by the model' })
  chapter!: number | null;

  @ApiProperty({
    enum: DROPPED_QUOTE_REASONS,
    description:
      'NOT_FOUND: not word for word within one paragraph of the chapter; NO_CHAPTER: no chapter given; CHAPTER_MISSING: the version has no such chapter; OVER_LIMIT: verified, but over the import limit together with the saved quotes',
  })
  reason!: DroppedQuoteReason;
}

export class ContentDraftDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  bookVersionId!: string;

  /**
   * Только `analysis`: ход `summary_write` (`F06`) отдают свои ручки (решение `F06 | F06-1`, В2),
   * пошаговые виды Summary сняты (`F06 | F06-3`, А2).
   */
  @ApiProperty({ enum: CONTENT_DRAFT_KINDS })
  kind!: DraftKind;

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
    type: ContentDraftAnalysisDto,
    nullable: true,
    description:
      'Analysis import JSON (analysis): language, facts, characters, keyQuotes, style only; built over the saved analysis',
  })
  analysis!: ContentDraftAnalysisDto | null;

  @ApiProperty({
    type: [ContentDraftDroppedQuoteDto],
    description: 'Quotes thrown away by the word-for-word check',
  })
  droppedQuotes!: ContentDraftDroppedQuoteDto[];

  @ApiProperty({
    type: [DossierMotifDto],
    description:
      'Recurring motifs of the dossier for the prompt inputs: chapters of this version only',
  })
  motifs!: DossierMotifDto[];

  @ApiProperty({
    enum: Language,
    nullable: true,
    description: 'Language of the dossier the analysis draft was built with',
  })
  dossierLanguage!: Language | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'updatedAt of the saved analysis the draft was built over; null - there was none (analysis)',
  })
  analysisUpdatedAt!: string | null;

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
