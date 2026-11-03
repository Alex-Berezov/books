import { ApiProperty } from '@nestjs/swagger';
import { LlmOperationStatus, LlmPauseReason } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';

/**
 * Где ход раздела языка (`F06-5`; `product.md` §5, §8 п.11): `pending` - автозапуск заведён, задача
 * ещё не стартовала ход; `skipped` - не начат с причиной (пропуск `AUTOSTART_SKIPPED_*`, отказ старта
 * вроде потолка, `AUTOSTART_NOTHING_TO_START`); `failed` без хода - автозапуск упал или снят
 * (`AUTOSTART_FAILED`, `AUTOSTART_CANCELLED`); остальное - статус строки хода (`ContentDraftStatus`).
 */
export const TRANSLATION_RUN_SUMMARY_STATUSES = [
  'pending',
  'skipped',
  'building',
  'ready',
  'failed',
  'discarded',
] as const;
export type TranslationRunSummaryStatus = (typeof TRANSLATION_RUN_SUMMARY_STATUSES)[number];

/** Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7). */
export class TranslationRunSummaryDto {
  @ApiProperty({ enum: TRANSLATION_RUN_SUMMARY_STATUSES })
  status!: TranslationRunSummaryStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Always set for skipped and failed. skipped (not started) - AUTOSTART_SKIPPED_EXISTING | AUTOSTART_SKIPPED_IN_PROGRESS | AUTOSTART_SKIPPED_LLM_DISABLED | AUTOSTART_NOTHING_TO_START, or the refusal of the start (LLM_CEILING_REACHED, DOSSIER_TOO_LONG, DOSSIER_STALE, SOURCE_HAS_NO_CHAPTERS...); failed - failedReason of the run, or AUTOSTART_FAILED | AUTOSTART_CANCELLED when the autostart operation failed or was cancelled',
  })
  reason!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Summary run of the draft version: GET /admin/versions/:id/drafts/summary_write of draftVersionId',
  })
  draftId!: string | null;

  @ApiProperty({
    enum: LlmOperationStatus,
    enumName: 'LlmOperationStatus',
    nullable: true,
    description:
      'Status of the operation of the summary run: paused - Continue on the Summary tab of the draft version',
  })
  operationStatus!: LlmOperationStatus | null;

  @ApiProperty({ enum: LlmPauseReason, enumName: 'LlmPauseReason', nullable: true })
  pauseReason!: LlmPauseReason | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Sections of the dossier plan' })
  plannedSections!: number | null;

  @ApiProperty({ type: Number, description: 'Sections of the plan with a text' })
  sectionsDone!: number;

  @ApiProperty({
    type: Boolean,
    description:
      'The full summary of the run has a text; false - not built yet or failed (it waits for every section)',
  })
  fullDone!: boolean;

  @ApiProperty({
    type: Boolean,
    description:
      'The very short of the run has a text; false - not built yet or failed (it waits for the full)',
  })
  briefDone!: boolean;

  @ApiProperty({
    type: Number,
    description:
      'Texts of the run with model flags (verdict flags) - texts, not remarks: «Done, texts with model flags: N»; the remarks of a text are on the Summary tab',
  })
  flaggedTexts!: number;

  @ApiProperty({
    type: Number,
    description:
      'Texts of the run that failed (sections, full, very short): a ready run with failed texts is not «Done»',
  })
  failedTexts!: number;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Spent by the summary operations of this language: the Summary line of the run',
  })
  spentUsd!: string;
}
