import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class CreateTagDto {
  @ApiProperty({ description: 'Tag name', example: 'Motivation' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ description: 'Tag slug', example: 'motivation', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;
}
