import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { ViewSource } from '@prisma/client';

export class CreateViewDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  bookVersionId!: string;

  @ApiProperty({ enum: ViewSource, enumName: 'ViewSource' })
  @IsEnum(ViewSource)
  source!: ViewSource;

  @ApiPropertyOptional({ description: 'ISO date-time, must be <= now()' })
  @IsOptional()
  @IsISO8601()
  timestamp?: string;
}
