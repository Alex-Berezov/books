import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Mirrors the Prisma `RightsComponentType` enum, which the generated client does not expose here. */
export enum ClaimComponentType {
  ORIGINAL_TEXT = 'ORIGINAL_TEXT',
  TRANSLATION = 'TRANSLATION',
  ADAPTATION = 'ADAPTATION',
  ABRIDGMENT = 'ABRIDGMENT',
  INTRODUCTION = 'INTRODUCTION',
  PREFACE = 'PREFACE',
  AFTERWORD = 'AFTERWORD',
  ANNOTATIONS = 'ANNOTATIONS',
  FOOTNOTES = 'FOOTNOTES',
  BIOGRAPHY = 'BIOGRAPHY',
  GLOSSARY = 'GLOSSARY',
  INDEX = 'INDEX',
  EDITORIAL_REVISION = 'EDITORIAL_REVISION',
  COMPILATION_STRUCTURE = 'COMPILATION_STRUCTURE',
  ILLUSTRATION = 'ILLUSTRATION',
  PHOTOGRAPH = 'PHOTOGRAPH',
  MAP = 'MAP',
  COVER = 'COVER',
  TYPOGRAPHIC_LAYOUT = 'TYPOGRAPHIC_LAYOUT',
  AUDIO_NARRATION = 'AUDIO_NARRATION',
  AUDIO_RECORDING = 'AUDIO_RECORDING',
  OTHER = 'OTHER',
}

export class LinkClaimComponentDto {
  @ApiPropertyOptional({ description: 'Existing rights profile component' })
  @IsOptional()
  @IsString()
  rightsComponentId?: string;

  @ApiPropertyOptional({ enum: ClaimComponentType, description: 'Used when there is no profile' })
  @IsOptional()
  @IsEnum(ClaimComponentType)
  componentType?: ClaimComponentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  titleRu?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notesRu?: string;
}
