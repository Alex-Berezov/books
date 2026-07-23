import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsInt,
  Min,
  Max,
  MinLength,
  MaxLength,
  Matches,
  ArrayMinSize,
  Validate,
} from 'class-validator';
import { RightsSourceProvider, RightsSourceTextType } from '@prisma/client';

const CURRENT_YEAR = new Date().getFullYear();

const ALLOWED_TARGET_LANGUAGES = ['en', 'es', 'fr', 'pt', 'ru'] as const;
const ALLOWED_CONTENT_TYPES = [
  'TEXT',
  'AUDIO',
  'REFERRAL',
  'DOWNLOAD',
  'COVER',
  'ILLUSTRATIONS',
] as const;
const ALLOWED_COMPONENTS = [
  'ORIGINAL_TEXT',
  'TRANSLATION',
  'INTRODUCTION',
  'PREFACE',
  'AFTERWORD',
  'ANNOTATIONS',
  'FOOTNOTES',
  'ILLUSTRATION',
  'PHOTOGRAPH',
  'MAP',
  'COVER',
  'AUDIO_NARRATION',
  'AUDIO_RECORDING',
  'OTHER',
] as const;

export class CreateRightsIntakeDto {
  @ApiProperty({ description: 'Candidate title (name of the work)', minLength: 2, maxLength: 300 })
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  candidateTitle!: string;

  @ApiProperty({ description: 'Candidate author', minLength: 2, maxLength: 300 })
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  candidateAuthor!: string;

  @ApiPropertyOptional({ description: 'Original title of the work', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  originalTitle?: string | null;

  @ApiPropertyOptional({ description: 'Original language code', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  originalLanguage?: string | null;

  @ApiPropertyOptional({ description: 'Author birth year', minimum: -3000 })
  @IsOptional()
  @IsInt()
  @Min(-3000)
  @Max(CURRENT_YEAR)
  authorBirthYear?: number | null;

  @ApiPropertyOptional({ description: 'Author death year', minimum: -3000 })
  @IsOptional()
  @IsInt()
  @Min(-3000)
  @Max(CURRENT_YEAR)
  authorDeathYear?: number | null;

  @ApiPropertyOptional({
    description: 'Source provider',
    enum: RightsSourceProvider,
    default: 'UNKNOWN',
  })
  @IsOptional()
  @IsEnum(RightsSourceProvider)
  sourceProvider?: RightsSourceProvider;

  @ApiPropertyOptional({
    description: 'Source external ID (e.g. Gutenberg eBook ID)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sourceExternalId?: string | null;

  @ApiPropertyOptional({ description: 'Source URL' })
  @IsOptional()
  @IsString()
  sourceUrl?: string | null;

  @ApiPropertyOptional({ description: 'Source title', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceTitle?: string | null;

  @ApiPropertyOptional({ description: 'Source language code', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sourceLanguage?: string | null;

  @ApiPropertyOptional({
    description: 'Source text type',
    enum: RightsSourceTextType,
    default: 'UNKNOWN',
  })
  @IsOptional()
  @IsEnum(RightsSourceTextType)
  sourceTextType?: RightsSourceTextType;

  @ApiProperty({
    description: 'Target languages (en, es, fr, pt, ru)',
    isArray: true,
    example: ['en', 'fr'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @Validate(IsAllowedTargetLanguage, { each: true })
  targetLanguages!: string[];

  @ApiProperty({
    description: 'Target country codes (ISO alpha-2 uppercase)',
    isArray: true,
    example: ['US', 'GB', 'FR'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @Matches(/^[A-Z]{2}$/, { each: true, message: 'Each country code must be uppercase ISO alpha-2' })
  targetCountryCodes!: string[];

  @ApiProperty({ description: 'Planned content types', isArray: true, example: ['TEXT', 'AUDIO'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @Validate(IsAllowedContentType, { each: true })
  plannedContentTypes!: string[];

  @ApiPropertyOptional({ description: 'Planned components', isArray: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Validate(IsAllowedComponent, { each: true })
  plannedComponents?: string[] | null;

  @ApiPropertyOptional({ description: 'Notes in Russian', maxLength: 10000 })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  notesRu?: string | null;
}

function IsAllowedTargetLanguage() {
  return { validate: (v: string) => (ALLOWED_TARGET_LANGUAGES as readonly string[]).includes(v) };
}

function IsAllowedContentType() {
  return { validate: (v: string) => (ALLOWED_CONTENT_TYPES as readonly string[]).includes(v) };
}

function IsAllowedComponent() {
  return { validate: (v: string) => (ALLOWED_COMPONENTS as readonly string[]).includes(v) };
}
