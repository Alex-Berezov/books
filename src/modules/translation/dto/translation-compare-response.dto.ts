import { ApiProperty } from '@nestjs/swagger';
import { Language, TranslationCompareModelStatus } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import { LlmOperationDto } from '../../llm-worker/dto/llm-operation.dto';

/** Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7). */

const MONEY_OR_NULL = { ...LLM_MONEY_PROPERTY, nullable: true } as const;

export class CompareContextLineDto {
  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Upper estimate of the build' })
  estimateUsd!: string;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Limit of its own operation: estimate × 1.5; must fit the compare limit',
  })
  suggestedLimitUsd!: string;

  @ApiProperty({
    type: Boolean,
    description: 'The dossier is not ready yet: an upper bound by the dossier answer size',
  })
  upperBound!: boolean;
}

export class CompareModelEstimateDto {
  @ApiProperty({ type: String })
  model!: string;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Upper estimate: one call per piece' })
  estimateUsd!: string;
}

export class TranslationCompareEstimateDto {
  @ApiProperty({ type: Number })
  chapterNumber!: number;

  @ApiProperty({ enum: Language, enumName: 'Language' })
  targetLanguage!: Language;

  @ApiProperty({ type: Number, description: 'Pieces by code boundaries' })
  chunks!: number;

  @ApiProperty({
    type: () => CompareContextLineDto,
    nullable: true,
    description: 'The dossier is built first under its own operation; null - ready or building',
  })
  dossier!: CompareContextLineDto | null;

  @ApiProperty({
    type: () => CompareContextLineDto,
    nullable: true,
    description: 'The glossary is built first under its own operation; null - ready or building',
  })
  glossary!: CompareContextLineDto | null;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Contested joints by the split stage' })
  splitUsd!: string;

  @ApiProperty({ type: [CompareModelEstimateDto] })
  models!: CompareModelEstimateDto[];

  @ApiProperty({
    type: Boolean,
    description: 'Model estimates include an upper bound for a dossier and glossary not built yet',
  })
  upperBound!: boolean;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Split plus all models' })
  translationsUsd!: string;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description:
      'Default compare limit: translations × 1.5, and not less than the limit of a dossier or glossary built first',
  })
  suggestedLimitUsd!: string;
}

export class TranslationCompareModelDto {
  @ApiProperty({ type: String })
  model!: string;

  @ApiProperty({ type: Number, description: 'Column and translation order from 0' })
  position!: number;

  @ApiProperty({
    enum: TranslationCompareModelStatus,
    enumName: 'TranslationCompareModelStatus',
    description: 'queued models of a paused operation are stopped by its pauseReason',
  })
  status!: TranslationCompareModelStatus;

  @ApiProperty({ type: Number })
  chunksDone!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Translated chapter HTML when done; no partial text',
  })
  html!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the model failed: COMPARE_INVALID_RESPONSE, COMPARE_TOO_LONG, COMPARE_CHAPTER_TOO_LONG, COMPARE_CHAPTER_CHANGED, an LLM_* code or a worker reason',
  })
  error!: string | null;

  @ApiProperty({ ...LLM_MONEY_PROPERTY, description: 'Sum of its settled calls' })
  costUsd!: string;

  @ApiProperty({ type: Number })
  inputTokens!: number;

  @ApiProperty({ type: Number })
  outputTokens!: number;

  @ApiProperty({ type: Number, description: 'Sum of call durations, ms' })
  durationMs!: number;
}

export class TranslationCompareListItemDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  bookVersionId!: string;

  @ApiProperty({ type: Number })
  chapterNumber!: number;

  @ApiProperty({ enum: Language, enumName: 'Language' })
  language!: Language;

  @ApiProperty({ type: () => LlmOperationDto })
  operation!: LlmOperationDto;

  @ApiProperty({ type: [String] })
  models!: string[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class TranslationCompareDto extends TranslationCompareListItemDto {
  @ApiProperty({ type: String, nullable: true, description: 'Chapter title of the source' })
  chapterTitle!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Current chapter text of the source; null - the chapter is gone',
  })
  originalHtml!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Pieces; null - not split yet' })
  chunks!: number | null;

  @ApiProperty({
    type: Boolean,
    description: 'Waiting for the dossier or glossary to be built',
  })
  waitingForContext!: boolean;

  @ApiProperty({ ...MONEY_OR_NULL, description: 'Split stage calls; null - none' })
  splitCostUsd!: string | null;

  @ApiProperty({ type: [TranslationCompareModelDto] })
  results!: TranslationCompareModelDto[];
}
