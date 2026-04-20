import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Language } from '@prisma/client';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { SeoInputDto } from '../../pages/dto/seo-input.dto';

export class UpdateCategoryTranslationDto {
  @ApiPropertyOptional({ enum: Object.values(Language) })
  @IsOptional()
  @IsEnum(Language)
  language?: Language;

  @ApiPropertyOptional({ description: 'Localized category name' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ description: 'Localized category slug', pattern: SLUG_PATTERN })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug?: string;

  @ApiPropertyOptional({ description: 'HTML description for the category page' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ description: 'SEO metadata', type: SeoInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeoInputDto)
  seo?: SeoInputDto;
}
