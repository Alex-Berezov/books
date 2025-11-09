import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID, Matches, MaxLength, IsIn } from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class CheckSlugQueryDto {
  @ApiProperty({
    description: 'Slug для проверки уникальности',
    example: 'about-us',
    pattern: SLUG_PATTERN,
  })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), {
    message: SLUG_REGEX_README,
  })
  @MaxLength(100, { message: 'Slug must be at most 100 characters long' })
  slug!: string;

  @ApiProperty({
    description: 'Язык страницы',
    example: 'en',
    enum: ['en', 'es', 'fr', 'pt'],
  })
  @IsString()
  @IsIn(['en', 'es', 'fr', 'pt'], { message: 'Language must be one of: en, es, fr, pt' })
  lang!: string;

  @ApiPropertyOptional({
    description: 'ID страницы для исключения из проверки (при редактировании)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID('4', { message: 'excludeId must be a valid UUID' })
  excludeId?: string;
}
