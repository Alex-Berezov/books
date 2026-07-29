import { ApiProperty } from '@nestjs/swagger';
import {
  RightsAgentSubmissionMaterialization,
  RightsAgentSubmissionStatus,
} from '../rights-agent-interface';

export class AgentSubmissionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty({ nullable: true }) uploadTokenId!: string | null;
  @ApiProperty({ nullable: true, description: 'Display prefix of the token used' })
  tokenPrefix!: string | null;
  @ApiProperty({ enum: RightsAgentSubmissionStatus }) status!: RightsAgentSubmissionStatus;
  @ApiProperty({ nullable: true }) declaredSchemaVersion!: string | null;
  @ApiProperty({ nullable: true }) reportJsonSha256!: string | null;
  @ApiProperty({ nullable: true }) payloadSizeBytes!: number | null;
  @ApiProperty({ nullable: true }) sourceFileName!: string | null;
  @ApiProperty({ nullable: true }) agentName!: string | null;
  @ApiProperty({ nullable: true }) agentVersion!: string | null;
  @ApiProperty({ nullable: true }) rightsReviewImportId!: string | null;
  @ApiProperty() validationErrorCount!: number;
  @ApiProperty() validationWarningCount!: number;
  @ApiProperty({ nullable: true }) rejectionCode!: string | null;
  @ApiProperty({ nullable: true }) rejectionMessageRu!: string | null;
  @ApiProperty({ enum: RightsAgentSubmissionMaterialization })
  materialization!: RightsAgentSubmissionMaterialization;
  @ApiProperty({ nullable: true }) materializationError!: string | null;
  @ApiProperty({ nullable: true }) materializedProfileId!: string | null;
  @ApiProperty({ nullable: true }) processedAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class AgentSubmissionListResponseDto {
  @ApiProperty({ type: [AgentSubmissionDto] }) items!: AgentSubmissionDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
