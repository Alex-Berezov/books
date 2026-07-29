import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RightsAgentTokenStatus } from '../rights-agent-interface';

export class AgentTokenDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty({ description: 'First 12 characters of the token, for display only' })
  tokenPrefix!: string;
  @ApiProperty({ enum: RightsAgentTokenStatus }) status!: RightsAgentTokenStatus;
  @ApiProperty({ nullable: true }) labelRu!: string | null;
  @ApiProperty() maxUses!: number;
  @ApiProperty() usedCount!: number;
  @ApiProperty() remainingUses!: number;
  @ApiProperty() failedAttempts!: number;
  @ApiProperty() maxFailedAttempts!: number;
  @ApiProperty() allowRetryOnValidationError!: boolean;
  @ApiProperty() autoMaterialize!: boolean;
  @ApiProperty({ type: [String], nullable: true }) allowedSchemaVersions!: string[] | null;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() isExpired!: boolean;
  @ApiProperty({ description: 'Token can still be used for a submission' }) isUsable!: boolean;
  @ApiProperty({ nullable: true }) issuedByUserId!: string | null;
  @ApiProperty({ nullable: true }) firstUsedAt!: string | null;
  @ApiProperty({ nullable: true }) lastUsedAt!: string | null;
  @ApiProperty({ nullable: true }) revokedAt!: string | null;
  @ApiProperty({ nullable: true }) revokeReasonRu!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/** Returned only by the issue endpoint — the raw token is never persisted or shown again. */
export class AgentTokenIssuedDto extends AgentTokenDto {
  @ApiProperty({ description: 'Raw token. Shown exactly once, at issue time.' })
  token!: string;
}

export class AgentTokenListResponseDto {
  @ApiProperty({ type: [AgentTokenDto] }) items!: AgentTokenDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class AgentTokenDetailResponseDto extends AgentTokenDto {
  @ApiPropertyOptional({ nullable: true }) lastUsedIp?: string | null;
}
