import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  RightsRecheckEventType,
  RightsRecheckPolicy,
  RightsRecheckReason,
  RightsRecheckReminderStage,
  RightsRecheckResolution,
  RightsRecheckSeverity,
  RightsRecheckStatus,
  RightsRecheckTriggerSource,
} from '../rights-recheck-interface';

export class RecheckTaskDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RightsRecheckReason }) reason!: RightsRecheckReason;
  @ApiProperty() reasonRu!: string;
  @ApiProperty({ enum: RightsRecheckStatus }) status!: RightsRecheckStatus;
  @ApiProperty({ enum: RightsRecheckSeverity }) severity!: RightsRecheckSeverity;
  @ApiProperty({ enum: RightsRecheckTriggerSource }) source!: RightsRecheckTriggerSource;

  @ApiProperty({ type: String, nullable: true }) rightsProfileId!: string | null;
  @ApiProperty({ type: String, nullable: true }) rightsIntakeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) baselineReviewId!: string | null;
  @ApiProperty({ type: String, nullable: true }) bookId!: string | null;
  @ApiProperty({ type: String, nullable: true }) bookVersionId!: string | null;
  @ApiProperty({ type: String, nullable: true }) legalChangeEventId!: string | null;

  @ApiProperty() titleRu!: string;
  @ApiProperty() descriptionRu!: string;
  @ApiProperty({ type: String, nullable: true }) triggerCode!: string | null;
  @ApiProperty({ type: [String] }) affectedCountryCodes!: string[];

  @ApiProperty() dueAt!: string;
  @ApiProperty({ enum: RightsRecheckReminderStage }) reminderStage!: RightsRecheckReminderStage;
  @ApiProperty() remindersSentCount!: number;
  @ApiProperty({ type: String, nullable: true }) lastReminderAt!: string | null;

  @ApiProperty({ type: String, nullable: true }) snoozedUntil!: string | null;
  @ApiProperty({ type: String, nullable: true }) snoozeReasonRu!: string | null;

  @ApiProperty({ type: String, nullable: true }) startedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) startedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) completedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) completedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) completionNotesRu!: string | null;
  @ApiProperty({ type: String, nullable: true }) completedReviewId!: string | null;
  @ApiProperty({ type: String, nullable: true }) dismissedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) dismissedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) dismissReasonRu!: string | null;

  @ApiProperty({ enum: RightsRecheckResolution, nullable: true })
  resolution!: RightsRecheckResolution | null;
  @ApiProperty({ type: String, nullable: true }) resolutionRu!: string | null;

  @ApiProperty({ type: String, nullable: true }) createdByUserId!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;

  // Computed at request time — never stored.
  @ApiProperty() isOpen!: boolean;
  @ApiProperty() isOverdue!: boolean;
  @ApiProperty() daysUntilDue!: number;
  @ApiProperty() isSnoozed!: boolean;
  @ApiProperty({ enum: RightsRecheckSeverity }) effectiveSeverity!: RightsRecheckSeverity;
}

export class RecheckTaskEventDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RightsRecheckEventType }) eventType!: RightsRecheckEventType;
  @ApiProperty({ enum: RightsRecheckStatus, nullable: true })
  fromStatus!: RightsRecheckStatus | null;
  @ApiProperty({ enum: RightsRecheckStatus, nullable: true }) toStatus!: RightsRecheckStatus | null;
  @ApiProperty() messageRu!: string;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Free-form by design: each `RightsRecheckEventType` writes its own keys (`{ stage, previousStage }`, `{ from, to }`, `{ snoozedUntil }`, `{ resolution }`, …). `appendEvent` takes `payload: unknown`.',
  })
  payload!: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) createdByUserId!: string | null;
  @ApiProperty() createdAt!: string;
}

export class RecheckTaskTargetsDto {
  @ApiPropertyOptional({ type: String, nullable: true }) intakeTitle?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) intakeStatus?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) profileStatus?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) versionLanguage?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) versionTitle?: string | null;
}

export class RecheckTaskDetailDto extends RecheckTaskDto {
  @ApiProperty({ type: [RecheckTaskEventDto] }) events!: RecheckTaskEventDto[];
  @ApiProperty({ type: RecheckTaskTargetsDto }) targets!: RecheckTaskTargetsDto;
}

export class RecheckTaskListResponseDto {
  @ApiProperty({ type: [RecheckTaskDto] }) items!: RecheckTaskDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class RecheckScheduleDto {
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty({ enum: RightsRecheckPolicy }) recheckPolicy!: RightsRecheckPolicy;
  @ApiProperty({ type: Number, nullable: true }) recheckIntervalDays!: number | null;
  @ApiProperty({ type: String, nullable: true }) nextReviewAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) recheckPausedUntil!: string | null;
  @ApiProperty({ type: String, nullable: true }) recheckPauseReasonRu!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastRecheckScanAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) computedDueAt!: string | null;
  @ApiProperty() openTasksCount!: number;
}

export class RecheckScheduleWithTasksDto extends RecheckScheduleDto {
  @ApiProperty({ type: [RecheckTaskDto] }) openTasks!: RecheckTaskDto[];
}
