import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RejectRightsReviewDto {
  @ApiProperty({ description: 'Rejection reason in Russian (min 10 characters)' })
  @IsString()
  @MinLength(10)
  reasonRu!: string;
}
