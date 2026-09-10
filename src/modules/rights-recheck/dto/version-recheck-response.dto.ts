import { ApiProperty } from '@nestjs/swagger';
import { RecheckScheduleDto, RecheckTaskDto } from './recheck-task-response.dto';

/** One publication-gate contribution of the recheck module. */
export class RecheckGateReasonDto {
  @ApiProperty() code!: string;
  @ApiProperty() messageRu!: string;
  @ApiProperty({ type: String, nullable: true }) taskId!: string | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Free-form by design: each gate reason `code` attaches its own keys, assembled inline in `RightsRecheckService` (`{ code, messageRu, taskId, details }`). Nothing validates the composition.',
  })
  details!: Record<string, unknown> | null;
}

/** What `evaluateVersionRecheck` hands to the publication gate. */
export class RecheckGateEvaluationDto {
  @ApiProperty() versionId!: string;
  @ApiProperty({ type: [RecheckGateReasonDto] }) blockers!: RecheckGateReasonDto[];
  @ApiProperty({ type: [RecheckGateReasonDto] }) warnings!: RecheckGateReasonDto[];
  @ApiProperty() openTasksCount!: number;
  @ApiProperty() overdueTasksCount!: number;
  @ApiProperty() blockingTasksCount!: number;
  @ApiProperty({ type: String, nullable: true }) nextRecheckDueAt!: string | null;
  @ApiProperty({ type: [String] }) taskIds!: string[];
}

export class VersionRecheckDto extends RecheckGateEvaluationDto {
  @ApiProperty({ type: [RecheckTaskDto] }) tasks!: RecheckTaskDto[];
  @ApiProperty({ type: RecheckScheduleDto, nullable: true }) schedule!: RecheckScheduleDto | null;
}
