import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export enum GeoBlockScope {
  ENTIRE_BOOK = 'ENTIRE_BOOK',
  LANGUAGE_EDITION = 'LANGUAGE_EDITION',
  TEXT_READER = 'TEXT_READER',
  DOWNLOADS = 'DOWNLOADS',
  AUDIO = 'AUDIO',
  SPECIFIC_ASSET = 'SPECIFIC_ASSET',
}

export class CheckGeoBlockAccessDto {
  @ApiProperty({ example: 'GB', pattern: '^[A-Za-z]{2}$' })
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  countryCode!: string;

  @ApiProperty({ enum: GeoBlockScope })
  @IsEnum(GeoBlockScope)
  scope!: GeoBlockScope;
}

export class VerifyGeoBlockRulesDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  verified!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Checked blocked GB and allowed US scenarios.',
  })
  @IsOptional()
  @IsString()
  notesRu?: string | null;
}

export class GeoBlockRuleDto {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  bookId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  bookVersionId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  rightsProfileId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  territoryDecisionId!: string | null;

  @ApiProperty({ enum: GeoBlockScope })
  scope!: GeoBlockScope;

  @ApiProperty({ example: 'GB' })
  countryCode!: string;

  @ApiProperty()
  accessPolicy!: string;

  @ApiPropertyOptional({ nullable: true })
  sourceFinalStatus!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiPropertyOptional({ nullable: true })
  reasonRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  legalBasisRu!: string | null;

  @ApiProperty()
  generatedFrom!: string;

  @ApiProperty()
  generatedAt!: string;

  @ApiPropertyOptional({ nullable: true })
  verifiedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  verifiedByUserId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  verificationNotesRu!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class GeoBlockRulesSummaryDto {
  @ApiProperty()
  geoBlockRequired!: boolean;

  @ApiProperty()
  configured!: boolean;

  @ApiPropertyOptional({ nullable: true })
  verifiedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  lastGeneratedAt!: string | null;

  @ApiProperty()
  totalRulesCount!: number;

  @ApiProperty()
  activeRulesCount!: number;

  @ApiProperty()
  verifiedRulesCount!: number;

  @ApiProperty({ type: [String] })
  blockedCountries!: string[];

  @ApiProperty({ enum: GeoBlockScope, isArray: true })
  scopes!: GeoBlockScope[];
}

export class GeoBlockRulesResponseDto {
  @ApiProperty()
  bookVersionId!: string;

  @ApiProperty({ type: [GeoBlockRuleDto] })
  rules!: GeoBlockRuleDto[];

  @ApiProperty({ type: GeoBlockRulesSummaryDto })
  summary!: GeoBlockRulesSummaryDto;
}

export class GeoAccessCheckResultDto {
  @ApiProperty()
  allowed!: boolean;

  @ApiProperty({ example: 'GB' })
  countryCode!: string;

  @ApiProperty({ enum: GeoBlockScope })
  scope!: GeoBlockScope;

  @ApiPropertyOptional({ nullable: true })
  matchedRuleId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  reasonCode!: string | null;

  @ApiPropertyOptional({ nullable: true })
  messageRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  bookVersionId!: string | null;
}
