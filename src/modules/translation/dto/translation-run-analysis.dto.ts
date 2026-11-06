import { ApiProperty } from '@nestjs/swagger';
import { LlmOperationStatus, LlmPauseReason } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import {
  TRANSLATION_RUN_SUMMARY_STATUSES,
  TranslationRunSummaryStatus,
} from './translation-run-summary.dto';

/**
 * Строка «Analysis» языка запуска (`F07-3b`; решение арбитра `F07 | F07-3b`, В2): статусы и причины -
 * те же, что у строки «Summary» (`TranslationRunSummaryDto`), единица хода - шаг, счёт - блоки.
 * Response DTO - только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 */
export class TranslationRunAnalysisDto {
  @ApiProperty({ enum: TRANSLATION_RUN_SUMMARY_STATUSES })
  status!: TranslationRunSummaryStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Always set for skipped and failed - the same reasons as the summary line: AUTOSTART_SKIPPED_* | AUTOSTART_NOTHING_TO_START or the refusal of the start (skipped), failedReason of the run or AUTOSTART_FAILED | AUTOSTART_CANCELLED (failed)',
  })
  reason!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Analysis run of the draft version: GET /admin/versions/:id/drafts/analysis_write of draftVersionId',
  })
  draftId!: string | null;

  @ApiProperty({
    enum: LlmOperationStatus,
    enumName: 'LlmOperationStatus',
    nullable: true,
    description:
      'Status of the operation of the analysis run: paused - Continue on the Analysis tab of the draft version',
  })
  operationStatus!: LlmOperationStatus | null;

  @ApiProperty({ enum: LlmPauseReason, enumName: 'LlmPauseReason', nullable: true })
  pauseReason!: LlmPauseReason | null;

  @ApiProperty({ type: Number, description: 'Steps of the run that are over: «step N of M»' })
  stepsDone!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Steps of the run (5; runs of F07-1 - 3); null - the run has not started',
  })
  stepsTotal!: number | null;

  @ApiProperty({
    type: Number,
    description:
      'Blocks of the run with model flags (verdict flags) - blocks, not remarks; the step flag CORE_MISSING is not counted',
  })
  flaggedItems!: number;

  @ApiProperty({
    type: Number,
    description: 'Blocks of the run that failed: a ready run with failed blocks is not «Done»',
  })
  failedItems!: number;

  @ApiProperty({
    type: Boolean,
    description:
      'The analysis of the draft version has its core now (BookAnalysis.hasCore, not the step flag CORE_MISSING): «Done» needs it and no failed blocks',
  })
  coreReady!: boolean;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Spent by the analysis operations of this language: the Analysis line of the run',
  })
  spentUsd!: string;
}
