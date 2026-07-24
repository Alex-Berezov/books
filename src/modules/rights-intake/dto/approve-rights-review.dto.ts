import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ApproveRightsReviewDto {
  @ApiPropertyOptional({ description: 'Approval notes in Russian' })
  @IsOptional()
  @IsString()
  notesRu?: string;
}
