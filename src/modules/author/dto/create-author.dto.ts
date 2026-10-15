import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  IsOptional,
  IsArray,
  ValidateNested,
  ValidateIf,
  MaxLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { AuthorTranslationDto } from './author-translation.dto';
import { AUTHOR_PAGE_LIMITS, AuthorPhotoCreditDto } from './author-page-blocks.dto';

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

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Full name in the native language and script (F02-2); `null`/empty — none',
    example: 'Лев Николаевич Толстой',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_o, value) => value !== undefined && value !== null && value !== '')
  @IsString()
  @MaxLength(AUTHOR_PAGE_LIMITS.nativeName)
  nativeName?: string | null;

  @ApiPropertyOptional({
    type: AuthorPhotoCreditDto,
    nullable: true,
    description: 'Portrait credit, one for all languages (F02-2); `null` — none',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AuthorPhotoCreditDto)
  photoCredit?: AuthorPhotoCreditDto | null;

  @ApiProperty({ description: 'Author translations', type: [AuthorTranslationDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AuthorTranslationDto)
  translations!: AuthorTranslationDto[];
}
