import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { RightsNotificationSeverity, RightsNotificationType } from '../rights-agent-interface';

/** Query booleans arrive as strings ("true"/"1"); normalise them before validation. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

export class ListRightsNotificationsDto {
  @ApiPropertyOptional({ description: 'Only unread notifications' })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  unreadOnly?: boolean;

  @ApiPropertyOptional({ enum: RightsNotificationType })
  @IsOptional()
  @IsEnum(RightsNotificationType)
  type?: RightsNotificationType;

  @ApiPropertyOptional({ enum: RightsNotificationSeverity })
  @IsOptional()
  @IsEnum(RightsNotificationSeverity)
  severity?: RightsNotificationSeverity;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  rightsIntakeId?: string;

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
