import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRightsReviewImportDto {
  @ApiProperty({ description: 'Agent JSON report' })
  @IsObject()
  reportJson!: Record<string, unknown>;

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

  @ApiPropertyOptional({ description: 'Source file name', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  sourceFileName?: string | null;

  /**
   * WP-9.1 (essence §15 `agent_model`): чем именно проверяли. Самодекларация — audit only,
   * ровно как `agentName`/`agentVersion` в агентском канале. Версия задания (`promptVersion`)
   * берётся не отсюда, а из манифеста интейка: её знает сервер, а не тот, кто импортирует.
   */
  @ApiPropertyOptional({
    description: 'Agent model self-identification (audit only)',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  agentModel?: string | null;
}
