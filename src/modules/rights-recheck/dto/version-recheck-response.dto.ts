import { ApiProperty } from '@nestjs/swagger';
import { RecheckScheduleDto, RecheckTaskDto } from './recheck-task-response.dto';

/** One publication-gate contribution of the recheck module. */
export class RecheckGateReasonDto {
  @ApiProperty() code!: string;
  @ApiProperty() messageRu!: string;
  @ApiProperty({ nullable: true }) taskId!: string | null;
  @ApiProperty({ nullable: true, type: Object }) details!: Record<string, unknown> | null;
}

/** What `evaluateVersionRecheck` hands to the publication gate. */
export class RecheckGateEvaluationDto {
  @ApiProperty() versionId!: string;
  @ApiProperty({ type: [RecheckGateReasonDto] }) blockers!: RecheckGateReasonDto[];
  @ApiProperty({ type: [RecheckGateReasonDto] }) warnings!: RecheckGateReasonDto[];
  @ApiProperty() openTasksCount!: number;
  @ApiProperty() overdueTasksCount!: number;
  @ApiProperty() blockingTasksCount!: number;
  @ApiProperty({ nullable: true }) nextRecheckDueAt!: string | null;
  @ApiProperty({ type: [String] }) taskIds!: string[];
}

export class VersionRecheckDto extends RecheckGateEvaluationDto {
  @ApiProperty({ type: [RecheckTaskDto] }) tasks!: RecheckTaskDto[];
  @ApiProperty({ type: RecheckScheduleDto, nullable: true }) schedule!: RecheckScheduleDto | null;
}
