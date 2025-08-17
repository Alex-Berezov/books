import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { CategoryType as PrismaCategoryType } from '@prisma/client';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { CreateCategoryDto } from './create-category.dto';

export class UpdateCategoryDto implements Partial<CreateCategoryDto> {
  @ApiPropertyOptional({ enum: Object.values(PrismaCategoryType) })
  @IsOptional()
  @IsEnum(PrismaCategoryType)
  type?: PrismaCategoryType;

  @ApiPropertyOptional({ description: 'Название категории' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ description: 'Slug категории', pattern: SLUG_PATTERN })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug?: string;
}
