import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
  RightsRecheckReason,
  RightsRecheckSeverity,
  RightsRecheckStatus,
  RightsRecheckTriggerSource,
} from '../rights-recheck-interface';

/** Query strings arrive as `'true'` / `'1'`; class-validator needs a real boolean. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === '1' || value === true) return true;
  if (value === 'false' || value === '0' || value === false) return false;
  return value;
};

export class ListRecheckTasksDto {
  @ApiPropertyOptional({ enum: RightsRecheckStatus })
  @IsOptional()
  @IsEnum(RightsRecheckStatus)
  status?: RightsRecheckStatus;

  @ApiPropertyOptional({ enum: RightsRecheckReason })
  @IsOptional()
  @IsEnum(RightsRecheckReason)
  reason?: RightsRecheckReason;

  @ApiPropertyOptional({ enum: RightsRecheckSeverity })
  @IsOptional()
  @IsEnum(RightsRecheckSeverity)
  severity?: RightsRecheckSeverity;

  @ApiPropertyOptional({ enum: RightsRecheckTriggerSource })
  @IsOptional()
  @IsEnum(RightsRecheckTriggerSource)
  source?: RightsRecheckTriggerSource;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  rightsIntakeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  rightsProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookVersionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  legalChangeEventId?: string;

  @ApiPropertyOptional({ description: 'Only open tasks whose dueAt is already in the past' })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  overdueOnly?: boolean;

  @ApiPropertyOptional({ description: 'Only open tasks due within N days' })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  dueWithinDays?: number;

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
