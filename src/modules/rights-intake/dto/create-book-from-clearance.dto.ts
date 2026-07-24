import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  ValidateNested,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CreateBookFromClearanceVersionDto } from './create-book-from-clearance-version.dto';

export class CreateBookFromClearanceDto {
  @ApiProperty({ description: 'Book slug', example: 'the-picture-of-dorian-gray' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase alphanumeric with hyphens',
  })
  slug!: string;

  @ApiProperty({
    type: [CreateBookFromClearanceVersionDto],
    description: 'Book versions to create',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateBookFromClearanceVersionDto)
  versions!: CreateBookFromClearanceVersionDto[];
}
