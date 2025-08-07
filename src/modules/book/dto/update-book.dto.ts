import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateBookDto {
  @ApiPropertyOptional({
    description: 'Unique URL-friendly book identifier',
    example: 'harry-potter-updated',
  })
  @IsOptional()
  @IsString()
  slug?: string;

  // More fields can be added as needed
}
