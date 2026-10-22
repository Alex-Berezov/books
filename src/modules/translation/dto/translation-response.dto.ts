import { ApiProperty } from '@nestjs/swagger';
import { BookDossierStatus, Language } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import { LlmOperationDto } from '../../llm-worker/dto/llm-operation.dto';
import {
  TRANSLATION_BLOCK_REASONS,
  TRANSLATION_TARGET_REASONS,
  TranslationBlockReason,
  TranslationTargetReason,
} from '../translation-source';
import { DossierDataDto, GlossaryDataDto, GlossaryHistoryItemDto } from './dossier-data.dto';

/** Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7). */

export class TranslationTargetDto {
  @ApiProperty({ enum: Language, enumName: 'Language' })
  language!: Language;

  @ApiProperty({ type: Boolean })
  available!: boolean;

  @ApiProperty({ enum: TRANSLATION_TARGET_REASONS, nullable: true })
  reason!: TranslationTargetReason | null;
}

export class TranslationSourceDto {
  @ApiProperty({ type: Boolean })
  canTranslate!: boolean;

  @ApiProperty({
    enum: TRANSLATION_BLOCK_REASONS,
    nullable: true,
    description: 'Why translating from this version is unavailable; labels live on the front',
  })
  reason!: TranslationBlockReason | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  sourceVersionId!: string | null;

  @ApiProperty({ enum: Language, enumName: 'Language', nullable: true })
  sourceLanguage!: Language | null;

  @ApiProperty({ type: String, nullable: true, description: 'Original language as written' })
  originalLanguageRaw!: string | null;

  @ApiProperty({
    type: Boolean,
    description: 'Versions of the book disagree on the original language',
  })
  originalLanguageMismatch!: boolean;

  @ApiProperty({ type: [TranslationTargetDto] })
  targets!: TranslationTargetDto[];
}

export class DossierEstimateDto {
  @ApiProperty({ type: String, format: 'uuid' })
  sourceVersionId!: string;

  @ApiProperty({ type: Number, description: 'Chapters with text' })
  chapters!: number;

  @ApiProperty({ type: Number, description: 'Chapter pieces read by the first pass' })
  parts!: number;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Upper estimate of the build' })
  estimateUsd!: string;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Default operation limit: estimate × 1.5' })
  suggestedLimitUsd!: string;
}

export class DossierStatusDto {
  @ApiProperty({ enum: [...Object.values(BookDossierStatus), 'missing'] })
  status!: BookDossierStatus | 'missing';

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  id!: string | null;

  @ApiProperty({ type: String, format: 'uuid', description: 'Version the dossier is built from' })
  sourceVersionId!: string;

  @ApiProperty({ type: Number, nullable: true })
  generation!: number | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'The source text still matches the fingerprint of the dossier',
  })
  fresh!: boolean | null;

  @ApiProperty({ type: Number, nullable: true })
  formatVersion!: number | null;

  @ApiProperty({ type: String, nullable: true })
  model!: string | null;

  @ApiProperty({ type: Number, description: 'Chapter pieces already read' })
  partsDone!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why a failed dossier was closed without a summary: DOSSIER_TOO_LONG (does not fit the model context) or DOSSIER_SOURCE_CHANGED (source text was edited mid-build; the next request builds a new generation)',
  })
  failedReason!: string | null;

  @ApiProperty({ type: () => LlmOperationDto, nullable: true })
  operation!: LlmOperationDto | null;

  @ApiProperty({
    type: () => LlmOperationDto,
    nullable: true,
    description: 'Builder before the takeover; the cost of the row is spent of both operations',
  })
  previousOperation!: LlmOperationDto | null;

  @ApiProperty({ type: () => DossierDataDto, nullable: true, description: 'Dossier v1 when ready' })
  data!: DossierDataDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt!: string | null;
}

export class GlossaryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  dossierId!: string;

  @ApiProperty({ enum: Language, enumName: 'Language' })
  language!: Language;

  @ApiProperty({ enum: BookDossierStatus, enumName: 'BookDossierStatus' })
  status!: BookDossierStatus;

  @ApiProperty({ type: () => GlossaryDataDto, nullable: true })
  data!: GlossaryDataDto | null;

  @ApiProperty({
    type: [GlossaryHistoryItemDto],
    description: 'Additions made while translating, with the source chunk',
  })
  history!: GlossaryHistoryItemDto[];

  @ApiProperty({ type: String, nullable: true })
  model!: string | null;

  @ApiProperty({ type: () => LlmOperationDto, nullable: true })
  operation!: LlmOperationDto | null;

  @ApiProperty({
    type: () => LlmOperationDto,
    nullable: true,
    description: 'Builder before the takeover; the cost of the row is spent of both operations',
  })
  previousOperation!: LlmOperationDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}
