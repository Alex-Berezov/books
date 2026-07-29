import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { RightsRecheckScanStatus } from '../rights-recheck-interface';

export class ListScanRunsDto {
  @ApiPropertyOptional({ enum: RightsRecheckScanStatus })
  @IsOptional()
  @IsEnum(RightsRecheckScanStatus)
  status?: RightsRecheckScanStatus;

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
