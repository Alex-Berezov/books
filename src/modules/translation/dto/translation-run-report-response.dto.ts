import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language, TranslationChapterStatus, TranslationRunLanguageStatus } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';

/**
 * Отчёт запуска перевода (`F05-6`, шаг 8): по языкам - куски, повторы, флаги кусков и глав
 * с причинами, итоговая проверка, ссылка на черновик; стоимость - по этапам и моделям на весь
 * запуск (у вызова LLM языка нет - решение арбитра `F05 | F05-6`, 6c В8). Причины - кодами:
 * подписи на пяти языках - экран `F05-7`.
 */

export class TranslationReportChunkFlagDto {
  @ApiProperty({ type: String, description: 'Flag reason code of the pieces' })
  reason!: string;

  @ApiProperty({ type: Number })
  count!: number;
}

export class TranslationReportChunksDto {
  @ApiProperty({ type: Number, description: 'Pieces of all chapters of this language' })
  total!: number;

  @ApiProperty({
    type: Number,
    description: 'Translate attempts beyond the first, summed over the pieces',
  })
  retries!: number;

  @ApiProperty({ type: () => [TranslationReportChunkFlagDto] })
  flagged!: TranslationReportChunkFlagDto[];
}

/** Находка главы: код и опора в тексте; поля - только те, что у кода есть. */
export class TranslationReportFindingDto {
  @ApiProperty({
    type: String,
    description:
      'Finding code: assembly (CHAPTER_TOO_LONG, CHUNK_UNTRANSLATED, CHUNKS_MISMATCH, CHUNK_FLAGGED, SEAM_REPEAT), joints (SEAM_*), final check (FINAL_*, GLOSSARY_SOURCE_FORM, CHAPTER_EMPTY), draft (SOURCE_CHANGED, TITLE_MISSING). SEAM_CHECKED and FINAL_CHECKED are paid answers without a problem',
  })
  code!: string;

  @ApiPropertyOptional({
    type: Number,
    description: 'Joint number from 1: between pieces seam-1 and seam',
  })
  seam?: number;

  @ApiPropertyOptional({ type: Number })
  chunkIndex?: number;

  @ApiPropertyOptional({ type: String, description: 'Flag reason of the piece (CHUNK_FLAGGED)' })
  chunkReason?: string;

  @ApiPropertyOptional({ type: Number, description: 'Source block number the remark is about' })
  block?: number;

  @ApiPropertyOptional({ type: String, description: 'Remark of the checking model' })
  issue?: string;

  @ApiPropertyOptional({ type: [String], description: 'Problems at the joint named by the model' })
  problems?: string[];

  @ApiPropertyOptional({ type: String, description: 'Glossary entry key (GLOSSARY_SOURCE_FORM)' })
  key?: string;

  @ApiPropertyOptional({
    type: String,
    description: 'The source spelling found in the translation',
  })
  form?: string;

  @ApiPropertyOptional({ type: String, description: 'The spelling the glossary gives' })
  target?: string;

  @ApiPropertyOptional({ type: String, description: 'Text around the found spelling' })
  fragment?: string;

  @ApiPropertyOptional({ type: String, description: 'Model of the paid answer' })
  model?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Found on the text before a retry or a hand edit of a piece: mute it, it is not in the chapter flag; absent - current',
  })
  stale?: boolean;
}

export class TranslationReportChapterDto {
  @ApiProperty({ type: Number })
  number!: number;

  @ApiProperty({
    enum: TranslationChapterStatus,
    enumName: 'TranslationChapterStatus',
    description: 'written - in the draft; flagged - not in the draft; assembled/pending - not yet',
  })
  status!: TranslationChapterStatus;

  @ApiProperty({ type: String, nullable: true, description: 'First flag of the chapter' })
  flagReason!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  seamIndex!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Length of the assembled chapter' })
  length!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lengthLimit!: number | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Chapter of the draft',
  })
  chapterId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the last chapter rewrite after a piece retry or hand edit did not go through: CHAPTER_EDITED_MANUALLY, VERSION_NOT_DRAFT, DRAFT_DELETED, SOURCE_CHANGED or an assembly code; empty - it did, or there was none',
  })
  rewriteRefusal!: string | null;

  @ApiProperty({ type: () => [TranslationReportFindingDto] })
  findings!: TranslationReportFindingDto[];
}

export class TranslationReportFinalCheckDto {
  @ApiProperty({
    enum: ['pending', 'skipped', 'in_progress', 'done'],
    description:
      'pending - an unfinished language has not reached it yet; skipped - not done: its metadata stage started before the final check existed, or the language ended earlier',
  })
  status!: 'pending' | 'skipped' | 'in_progress' | 'done';

  @ApiProperty({
    type: [Number],
    description: 'Source chapters with text that are not among the chapters of the translation',
  })
  missingChapters!: number[];

  @ApiProperty({ type: Number, description: 'Chapters read by the checking model' })
  chaptersChecked!: number;
}

export class TranslationReportLanguageDto {
  @ApiProperty({ enum: Language, enumName: 'Language' })
  language!: Language;

  @ApiProperty({ enum: TranslationRunLanguageStatus, enumName: 'TranslationRunLanguageStatus' })
  status!: TranslationRunLanguageStatus;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reasonText!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The draft version of this language; null - not created or deleted',
  })
  draftVersionId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  draftCreatedAt!: string | null;

  @ApiProperty({ type: Number })
  flaggedChunks!: number;

  @ApiProperty({ type: Number })
  flaggedChapters!: number;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'The author name is the glossary spelling; null - the metadata stage gave no answer',
  })
  authorFromGlossary!: boolean | null;

  @ApiProperty({ type: () => TranslationReportChunksDto })
  chunks!: TranslationReportChunksDto;

  @ApiProperty({ type: () => [TranslationReportChapterDto] })
  chapters!: TranslationReportChapterDto[];

  @ApiProperty({
    type: [Number],
    description:
      'Chapters not in the draft (CHAPTER_TOO_LONG, CHUNK_UNTRANSLATED, SOURCE_CHANGED…)',
  })
  notWrittenChapters!: number[];

  @ApiProperty({
    type: Number,
    description:
      'Chapters the run wrote to the draft; 0 with a draft - a draft without chapters of the run',
  })
  writtenChapters!: number;

  @ApiProperty({
    type: [Number],
    description:
      'Chapter numbers already taken in the draft by another chapter: skipped, not written by the run',
  })
  takenChapters!: number[];

  @ApiProperty({ type: () => TranslationReportFinalCheckDto })
  finalCheck!: TranslationReportFinalCheckDto;
}

export class TranslationReportCostDto {
  @ApiProperty({ type: String })
  stage!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Model that answered; null - calls without an answer of a model',
  })
  model!: string | null;

  @ApiProperty({ type: Number })
  calls!: number;

  @ApiProperty({ ...LLM_MONEY_PROPERTY })
  costUsd!: string;
}

export class TranslationReportInFlightDto {
  @ApiProperty({ type: Number, description: 'Calls without a final cost yet' })
  calls!: number;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Reserved for them, not in the total' })
  reservedUsd!: string;
}

export class TranslationRunReportDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  bookVersionId!: string;

  @ApiProperty({ type: () => [TranslationReportLanguageDto] })
  languages!: TranslationReportLanguageDto[];

  @ApiProperty({
    type: () => [TranslationReportCostDto],
    description:
      'Cost by stage and model over every operation of the run (the run, its dossier and glossaries)',
  })
  costs!: TranslationReportCostDto[];

  @ApiProperty({ type: () => TranslationReportInFlightDto })
  inFlight!: TranslationReportInFlightDto;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Spent by every operation of the run; equals the sum of costs to the cent',
  })
  totalUsd!: string;
}
