import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateBookSummaryDto {
  @ApiProperty({ description: 'Short summary text' })
  @IsString()
  summary!: string;

  @ApiPropertyOptional({ description: 'Optional analysis' })
  @IsOptional()
  @IsString()
  analysis?: string;

  @ApiPropertyOptional({ description: 'Optional themes' })
  @IsOptional()
  @IsString()
  themes?: string;
}
