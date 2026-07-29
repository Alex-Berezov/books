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

  @ApiProperty({ nullable: true }) rightsProfileId!: string | null;
  @ApiProperty({ nullable: true }) rightsIntakeId!: string | null;
  @ApiProperty({ nullable: true }) baselineReviewId!: string | null;
  @ApiProperty({ nullable: true }) bookId!: string | null;
  @ApiProperty({ nullable: true }) bookVersionId!: string | null;
  @ApiProperty({ nullable: true }) legalChangeEventId!: string | null;

  @ApiProperty() titleRu!: string;
  @ApiProperty() descriptionRu!: string;
  @ApiProperty({ nullable: true }) triggerCode!: string | null;
  @ApiProperty({ type: [String] }) affectedCountryCodes!: string[];

  @ApiProperty() dueAt!: string;
  @ApiProperty({ enum: RightsRecheckReminderStage }) reminderStage!: RightsRecheckReminderStage;
  @ApiProperty() remindersSentCount!: number;
  @ApiProperty({ nullable: true }) lastReminderAt!: string | null;

  @ApiProperty({ nullable: true }) snoozedUntil!: string | null;
  @ApiProperty({ nullable: true }) snoozeReasonRu!: string | null;

  @ApiProperty({ nullable: true }) startedAt!: string | null;
  @ApiProperty({ nullable: true }) startedByUserId!: string | null;
  @ApiProperty({ nullable: true }) completedAt!: string | null;
  @ApiProperty({ nullable: true }) completedByUserId!: string | null;
  @ApiProperty({ nullable: true }) completionNotesRu!: string | null;
  @ApiProperty({ nullable: true }) completedReviewId!: string | null;
  @ApiProperty({ nullable: true }) dismissedAt!: string | null;
  @ApiProperty({ nullable: true }) dismissedByUserId!: string | null;
  @ApiProperty({ nullable: true }) dismissReasonRu!: string | null;

  @ApiProperty({ enum: RightsRecheckResolution, nullable: true })
  resolution!: RightsRecheckResolution | null;
  @ApiProperty({ nullable: true }) resolutionRu!: string | null;

  @ApiProperty({ nullable: true }) createdByUserId!: string | null;
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
  @ApiProperty({ nullable: true, type: Object }) payload!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true }) createdByUserId!: string | null;
  @ApiProperty() createdAt!: string;
}

export class RecheckTaskTargetsDto {
  @ApiPropertyOptional({ nullable: true }) intakeTitle?: string | null;
  @ApiPropertyOptional({ nullable: true }) intakeStatus?: string | null;
  @ApiPropertyOptional({ nullable: true }) profileStatus?: string | null;
  @ApiPropertyOptional({ nullable: true }) versionLanguage?: string | null;
  @ApiPropertyOptional({ nullable: true }) versionTitle?: string | null;
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
  @ApiProperty({ nullable: true }) recheckIntervalDays!: number | null;
  @ApiProperty({ nullable: true }) nextReviewAt!: string | null;
  @ApiProperty({ nullable: true }) recheckPausedUntil!: string | null;
  @ApiProperty({ nullable: true }) recheckPauseReasonRu!: string | null;
  @ApiProperty({ nullable: true }) lastRecheckScanAt!: string | null;
  @ApiProperty({ nullable: true }) computedDueAt!: string | null;
  @ApiProperty() openTasksCount!: number;
}

export class RecheckScheduleWithTasksDto extends RecheckScheduleDto {
  @ApiProperty({ type: [RecheckTaskDto] }) openTasks!: RecheckTaskDto[];
}
