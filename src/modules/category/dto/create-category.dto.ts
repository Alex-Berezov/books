import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches, MinLength, ValidateIf } from 'class-validator';
import { CategoryType as PrismaCategoryType } from '@prisma/client';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class CreateCategoryDto {
  @ApiProperty({ enum: Object.values(PrismaCategoryType), description: 'Category type' })
  @IsEnum(PrismaCategoryType)
  type!: PrismaCategoryType;

  @ApiProperty({ description: 'Category name', example: 'Fantasy' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ description: 'Category slug', example: 'fantasy', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiProperty({
    description: 'Parent category (optional)',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  parentId?: string | null;
}
