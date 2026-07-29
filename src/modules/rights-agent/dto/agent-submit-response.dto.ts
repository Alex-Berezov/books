import { ApiProperty } from '@nestjs/swagger';
import { RightsAgentSubmissionMaterialization } from '../rights-agent-interface';

export class AgentValidationIssueDto {
  @ApiProperty() path!: string;
  @ApiProperty() message!: string;
  @ApiProperty() code!: string;
}

/**
 * Response the external agent receives. It deliberately exposes no rights profile id,
 * no intake content, no user data and no claim data.
 */
export class AgentSubmitResponseDto {
  @ApiProperty() submissionId!: string;
  @ApiProperty({ enum: ['VALIDATED', 'VALIDATION_FAILED'] })
  status!: 'VALIDATED' | 'VALIDATION_FAILED';
  @ApiProperty() intakeId!: string;
  @ApiProperty({ nullable: true }) schemaVersion!: string | null;
  @ApiProperty({ nullable: true }) reviewImportId!: string | null;
  @ApiProperty({ nullable: true }) reportJsonSha256!: string | null;
  @ApiProperty({ type: [AgentValidationIssueDto] }) validationErrors!: AgentValidationIssueDto[];
  @ApiProperty({ type: [AgentValidationIssueDto] }) validationWarnings!: AgentValidationIssueDto[];
  @ApiProperty({ enum: RightsAgentSubmissionMaterialization })
  materialization!: RightsAgentSubmissionMaterialization;
  @ApiProperty({
    description: 'Always true — an agent submission is never approved automatically',
    example: true,
  })
  humanApprovalRequired!: true;
  @ApiProperty() messageRu!: string;
  @ApiProperty({ description: 'ISO timestamp' }) receivedAt!: string;
}
