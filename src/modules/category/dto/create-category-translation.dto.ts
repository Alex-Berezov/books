import { ApiProperty } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { IsEnum, IsString, Matches, MinLength } from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class CreateCategoryTranslationDto {
  @ApiProperty({ enum: Object.values(Language) })
  @IsEnum(Language)
  language!: Language;

  @ApiProperty({ description: 'Localized category name' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ description: 'Localized category slug', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;
}
