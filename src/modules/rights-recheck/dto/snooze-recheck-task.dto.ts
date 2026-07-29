import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class SnoozeRecheckTaskDto {
  @ApiProperty({ description: 'Reminders stay silent until this moment' })
  @IsISO8601()
  until!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reasonRu?: string;
}
