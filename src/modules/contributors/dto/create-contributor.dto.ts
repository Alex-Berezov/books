import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export enum ContributorRoleDto {
  AUTHOR = 'AUTHOR',
  TRANSLATOR = 'TRANSLATOR',
  EDITOR = 'EDITOR',
  ILLUSTRATOR = 'ILLUSTRATOR',
  PHOTOGRAPHER = 'PHOTOGRAPHER',
  INTRODUCTION_AUTHOR = 'INTRODUCTION_AUTHOR',
  ANNOTATION_AUTHOR = 'ANNOTATION_AUTHOR',
  COMPILER = 'COMPILER',
  ADAPTER = 'ADAPTER',
  COVER_DESIGNER = 'COVER_DESIGNER',
  CARTOGRAPHER = 'CARTOGRAPHER',
  OTHER = 'OTHER',
}

export enum ContributorIdentityConfidenceDto {
  CONFIRMED = 'CONFIRMED',
  PROBABLE = 'PROBABLE',
  UNCERTAIN = 'UNCERTAIN',
  UNKNOWN = 'UNKNOWN',
}

export class CreateContributorDto {
  @ApiProperty({ description: 'Display name of contributor', example: 'Alexander Pope' })
  @IsString()
  displayName!: string;

  @ApiPropertyOptional({ description: 'Original name on source language' })
  @IsOptional()
  @IsString()
  originalName?: string;

  @ApiPropertyOptional({ description: 'Date of birth (ISO 8601 string)' })
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiPropertyOptional({ description: 'Date of death (ISO 8601 string)' })
  @IsOptional()
  @IsDateString()
  deathDate?: string;

  @ApiPropertyOptional({ description: 'Birth year', example: 1688 })
  @IsOptional()
  @IsInt()
  @Min(-3000)
  @Max(2100)
  birthYear?: number;

  @ApiPropertyOptional({ description: 'Death year', example: 1744 })
  @IsOptional()
  @IsInt()
  @Min(-3000)
  @Max(2100)
  deathYear?: number;

  @ApiPropertyOptional({ description: '2-letter country code (nationality)', example: 'GB' })
  @IsOptional()
  @IsString()
  nationalityCountry?: string;

  @ApiPropertyOptional({ description: 'Pseudonym' })
  @IsOptional()
  @IsString()
  pseudonym?: string;

  @ApiPropertyOptional({ description: 'VIAF ID' })
  @IsOptional()
  @IsString()
  viafId?: string;

  @ApiPropertyOptional({ description: 'Library of Congress Authority ID' })
  @IsOptional()
  @IsString()
  locAuthorityId?: string;

  @ApiPropertyOptional({ description: 'Other authority identifiers JSON object' })
  @IsOptional()
  @IsObject()
  otherAuthorityIds?: Record<string, unknown>;

  @ApiPropertyOptional({
    enum: ContributorIdentityConfidenceDto,
    default: ContributorIdentityConfidenceDto.CONFIRMED,
  })
  @IsOptional()
  @IsEnum(ContributorIdentityConfidenceDto)
  identityConfidence?: ContributorIdentityConfidenceDto;

  @ApiPropertyOptional({ description: 'Notes in Russian' })
  @IsOptional()
  @IsString()
  notesRu?: string;

  @ApiPropertyOptional({ description: 'Optional link to public catalog Author ID' })
  @IsOptional()
  @IsUUID()
  authorId?: string;
}
