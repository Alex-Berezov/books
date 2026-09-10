import { ApiProperty } from '@nestjs/swagger';
import {
  RightsAgentSubmissionMaterialization,
  RightsAgentSubmissionStatus,
} from '../rights-agent-interface';

export class AgentSubmissionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty({ type: String, nullable: true }) uploadTokenId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Display prefix of the token used' })
  tokenPrefix!: string | null;
  @ApiProperty({ enum: RightsAgentSubmissionStatus }) status!: RightsAgentSubmissionStatus;
  @ApiProperty({ type: String, nullable: true }) declaredSchemaVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportJsonSha256!: string | null;
  @ApiProperty({ type: Number, nullable: true }) payloadSizeBytes!: number | null;
  @ApiProperty({ type: String, nullable: true }) sourceFileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) agentName!: string | null;
  @ApiProperty({ type: String, nullable: true }) agentVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) rightsReviewImportId!: string | null;
  @ApiProperty() validationErrorCount!: number;
  @ApiProperty() validationWarningCount!: number;
  @ApiProperty({ type: String, nullable: true }) rejectionCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) rejectionMessageRu!: string | null;
  @ApiProperty({ enum: RightsAgentSubmissionMaterialization })
  materialization!: RightsAgentSubmissionMaterialization;
  @ApiProperty({ type: String, nullable: true }) materializationError!: string | null;
  @ApiProperty({ type: String, nullable: true }) materializedProfileId!: string | null;
  @ApiProperty({ type: String, nullable: true }) processedAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class AgentSubmissionListResponseDto {
  @ApiProperty({ type: [AgentSubmissionDto] }) items!: AgentSubmissionDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
