import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RightsRecheckReason, RightsRecheckSeverity } from '../rights-recheck-interface';

export class CreateRecheckTaskDto {
  @ApiPropertyOptional({
    enum: RightsRecheckReason,
    description: 'SCHEDULED_DUE is reserved for the scheduler and is coerced to MANUAL_REQUEST.',
  })
  @IsOptional()
  @IsEnum(RightsRecheckReason)
  reason?: RightsRecheckReason;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  rightsProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  rightsIntakeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookVersionId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  titleRu!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  descriptionRu!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  @ApiPropertyOptional({ enum: RightsRecheckSeverity })
  @IsOptional()
  @IsEnum(RightsRecheckSeverity)
  severity?: RightsRecheckSeverity;
}
