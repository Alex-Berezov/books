import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Body of POST /api/rights/agent/submissions.
 * Limits on `reportMarkdown` / `rawAgentOutput` intentionally mirror `CreateRightsReviewImportDto`.
 */
export class AgentSubmitReportDto {
  @ApiPropertyOptional({ description: 'Must match the intake the token was issued for' })
  @IsOptional()
  @IsUUID()
  intakeId?: string;

  @ApiProperty({ description: 'The JSON clearance report' })
  @IsObject()
  report!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Markdown report (up to 500K chars)', maxLength: 500000 })
  @IsOptional()
  @IsString()
  @MaxLength(500000)
  reportMarkdown?: string | null;

  @ApiPropertyOptional({ description: 'Raw agent output (up to 1M chars)', maxLength: 1000000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000000)
  rawAgentOutput?: string | null;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  sourceFileName?: string | null;

  @ApiPropertyOptional({ description: 'Agent self-identification (audit only)', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  agentName?: string | null;

  @ApiPropertyOptional({ description: 'Agent self-identification (audit only)', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  agentVersion?: string | null;
}
