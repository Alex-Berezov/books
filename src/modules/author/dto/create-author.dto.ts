import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { AuthorTranslationDto } from './author-translation.dto';

export class CreateAuthorDto {
  @ApiProperty({ description: 'Author unique slug', example: 'oscar-wilde', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiPropertyOptional({ description: 'Date of birth YYYY-MM-DD', example: '1854-10-16' })
  @IsOptional()
  @IsString()
  birthDate?: string;

  @ApiPropertyOptional({ description: 'Date of death YYYY-MM-DD', example: '1900-11-30' })
  @IsOptional()
  @IsString()
  deathDate?: string;

  @ApiPropertyOptional({
    description: 'Wikidata URL',
    example: 'https://www.wikidata.org/wiki/Q30875',
  })
  @IsOptional()
  @IsString()
  wikidataUrl?: string;

  @ApiPropertyOptional({
    description: 'Wikipedia URL',
    example: 'https://en.wikipedia.org/wiki/Oscar_Wilde',
  })
  @IsOptional()
  @IsString()
  wikipediaUrl?: string;

  @ApiPropertyOptional({
    description: 'Author photo URL',
    example: 'https://example.com/author.jpg',
  })
  @IsOptional()
  @IsString()
  photoUrl?: string;

  @ApiProperty({ description: 'Author translations', type: [AuthorTranslationDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AuthorTranslationDto)
  translations!: AuthorTranslationDto[];
}
