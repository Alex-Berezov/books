import { ApiProperty } from '@nestjs/swagger';
import { LlmOperationStatus, LlmPauseReason } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import {
  TRANSLATION_RUN_SUMMARY_STATUSES,
  TranslationRunSummaryStatus,
} from './translation-run-summary.dto';

/**
 * Строка «World» языка запуска (`F08-9b`; решение арбитра `F08 | F08-9b`): статусы и причины - те же,
 * что у строк «Summary» и «Analysis», единица хода - шаг, счёт - блоки.
 * Response DTO - только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 */
export class TranslationRunWorldDto {
  @ApiProperty({ enum: TRANSLATION_RUN_SUMMARY_STATUSES })
  status!: TranslationRunSummaryStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Always set for skipped and failed - the same reasons as the summary line: AUTOSTART_SKIPPED_* | AUTOSTART_NOTHING_TO_START or the refusal of the start, among them WORLD_ANALYSIS_MISSING - the analysis run of the language is not ready (skipped), failedReason of the run or AUTOSTART_FAILED | AUTOSTART_CANCELLED (failed); pending - waits for the analysis run of the language',
  })
  reason!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'World run of the draft version: GET /admin/versions/:id/drafts/world_write of draftVersionId',
  })
  draftId!: string | null;

  @ApiProperty({
    enum: LlmOperationStatus,
    enumName: 'LlmOperationStatus',
    nullable: true,
    description:
      'Status of the operation of the world run: paused - Continue on the World tab of the draft version',
  })
  operationStatus!: LlmOperationStatus | null;

  @ApiProperty({ enum: LlmPauseReason, enumName: 'LlmPauseReason', nullable: true })
  pauseReason!: LlmPauseReason | null;

  @ApiProperty({ type: Number, description: 'Steps of the run that are over: «step N of M»' })
  stepsDone!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Steps of the run: the choice of characters, two per character and one per pair; null - the choice has not passed',
  })
  stepsTotal!: number | null;

  @ApiProperty({
    type: Number,
    description:
      'Blocks of the run with flags, as Model flags of the World tab: verdict flags and at least one remark of the run other than EXTERNAL_CHECK (check facts by hand); a flags block without such remarks and a Nothing to add block are not counted',
  })
  flaggedItems!: number;

  @ApiProperty({
    type: Number,
    description: 'Blocks of the run that failed: a ready run with failed blocks is not «Done»',
  })
  failedItems!: number;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Spent by the world operations of this language: the World line of the run',
  })
  spentUsd!: string;
}
