import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AGENT_TOKEN_DEFAULT_MAX_USES,
  AGENT_TOKEN_DEFAULT_TTL_HOURS,
  AGENT_TOKEN_MAX_MAX_USES,
  AGENT_TOKEN_MAX_TTL_HOURS,
  AGENT_TOKEN_MIN_TTL_HOURS,
} from '../rights-agent.constants';

export class CreateAgentTokenDto {
  @ApiPropertyOptional({ description: 'Human-readable label for the editor', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  labelRu?: string | null;

  @ApiPropertyOptional({
    description: 'Token lifetime in hours',
    default: AGENT_TOKEN_DEFAULT_TTL_HOURS,
    minimum: AGENT_TOKEN_MIN_TTL_HOURS,
    maximum: AGENT_TOKEN_MAX_TTL_HOURS,
  })
  @IsOptional()
  @IsInt()
  @Min(AGENT_TOKEN_MIN_TTL_HOURS)
  @Max(AGENT_TOKEN_MAX_TTL_HOURS)
  ttlHours?: number;

  @ApiPropertyOptional({
    description: 'How many successful submissions the token allows',
    default: AGENT_TOKEN_DEFAULT_MAX_USES,
    minimum: 1,
    maximum: AGENT_TOKEN_MAX_MAX_USES,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(AGENT_TOKEN_MAX_MAX_USES)
  maxUses?: number;

  @ApiPropertyOptional({
    description: 'Report schema versions this token accepts. Omit to accept all supported ones.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  allowedSchemaVersions?: string[];

  @ApiPropertyOptional({
    description: 'Materialize the rights profile right after a successful validation',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  autoMaterialize?: boolean;

  @ApiPropertyOptional({
    description: 'A failed validation does not consume a use of the token',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  allowRetryOnValidationError?: boolean;
}
