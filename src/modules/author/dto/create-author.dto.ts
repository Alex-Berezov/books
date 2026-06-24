import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { AuthorTranslationDto } from './author-translation.dto';

export class CreateAuthorDto {
  @ApiPropertyOptional({
    description: 'Author unique slug (optional for creation compatibility)',
    example: 'oscar-wilde',
    pattern: SLUG_PATTERN,
  })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug?: string;

  @ApiPropertyOptional({ description: 'Date of birth YYYY-MM-DD', example: '1854-10-16' })
  @IsOptional()
  @IsString()
  birthDate?: string;

  @ApiPropertyOptional({ description: 'Date of death YYYY-MM-DD', example: '1900-11-30' })
  @IsOptional()
  @IsString()
  deathDate?: string;

  @ApiProperty({ description: 'Author translations', type: [AuthorTranslationDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AuthorTranslationDto)
  translations!: AuthorTranslationDto[];
}
