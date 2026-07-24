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
}
