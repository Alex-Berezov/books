import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateBookDto {
  @ApiProperty({
    description: 'Unique URL-friendly book identifier',
    example: 'harry-potter',
  })
  @IsString()
  slug: string;

  // More fields can be added as needed
}
