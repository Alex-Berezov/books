import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class RecordCounterNoticeDto {
  @ApiProperty({ description: 'Text of the counter notice' })
  @IsString()
  counterNoticeTextRu!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  counterNoticeClaimantName?: string;

  @ApiPropertyOptional({ description: 'ISO date the counter notice arrived; defaults to now' })
  @IsOptional()
  @IsDateString()
  counterNoticeReceivedAt?: string;
}
