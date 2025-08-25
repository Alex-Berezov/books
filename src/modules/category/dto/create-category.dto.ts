import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches, MinLength, ValidateIf } from 'class-validator';
import { CategoryType as PrismaCategoryType } from '@prisma/client';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class CreateCategoryDto {
  @ApiProperty({ enum: Object.values(PrismaCategoryType), description: 'Тип категории' })
  @IsEnum(PrismaCategoryType)
  type!: PrismaCategoryType;

  @ApiProperty({ description: 'Название категории', example: 'Fantasy' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ description: 'Slug категории', example: 'fantasy', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiProperty({
    description: 'Родительская категория (необязательно)',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  parentId?: string | null;
}
