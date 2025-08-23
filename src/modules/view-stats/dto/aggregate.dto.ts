import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsISO8601, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ViewSource } from '@prisma/client';

export type Period = 'day' | 'week' | 'month' | 'all';

export class AggregateQueryDto {
  @ApiProperty({ description: 'BookVersion id', format: 'uuid' })
  @IsUUID()
  versionId!: string;

  @ApiProperty({ enum: ['day', 'week', 'month', 'all'], enumName: 'ViewsPeriod' })
  @IsIn(['day', 'week', 'month', 'all'])
  period!: Period;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: ViewSource })
  @IsOptional()
  @IsEnum(ViewSource)
  source?: ViewSource;
}

export class AggregatePointDto {
  @ApiProperty({ example: '2025-08-01' })
  date!: string;
  @ApiProperty()
  count!: number;
}

export class AggregateResponseDto {
  @ApiProperty()
  total!: number;
  @ApiProperty({ type: [AggregatePointDto] })
  series!: AggregatePointDto[];
}

export class TopViewsQueryDto {
  @ApiProperty({ enum: ['day', 'week', 'month', 'all'] })
  @IsIn(['day', 'week', 'month', 'all'])
  period!: Period;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ enum: ViewSource })
  @IsOptional()
  @IsEnum(ViewSource)
  source?: ViewSource;
}

export class TopViewsItemDto {
  @ApiProperty({ format: 'uuid' })
  bookVersionId!: string;
  @ApiProperty()
  count!: number;
}

export class TopViewsResponseDto {
  @ApiProperty({ type: [TopViewsItemDto] })
  items!: TopViewsItemDto[];
  @ApiProperty()
  totalVersions!: number;
}
