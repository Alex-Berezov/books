import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { RightsAgentTokenStatus } from '../rights-agent-interface';

export class ListAgentTokensDto {
  @ApiPropertyOptional({ enum: RightsAgentTokenStatus })
  @IsOptional()
  @IsEnum(RightsAgentTokenStatus)
  status?: RightsAgentTokenStatus;

  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
