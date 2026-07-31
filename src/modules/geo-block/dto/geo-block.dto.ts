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

/**
 * Phase 12 / WP-1.2а. Health of the country source itself, not of any single version.
 * Phase 12 depends on an upstream proxy header (`CF-IPCountry`) that the application neither
 * controls nor can probe: turning off Cloudflare proxying or IP Geolocation would silently
 * disable every geo-block. These counters make that failure visible.
 */
export enum GeoCountrySourceStatus {
  /** No public request has been observed since the process started — nothing to judge by. */
  NO_DATA = 'NO_DATA',
  /** Practically every request carries a country. */
  HEALTHY = 'HEALTHY',
  /** A noticeable share of requests arrives without a country. */
  DEGRADED = 'DEGRADED',
  /** Nothing has resolved at all over a meaningful number of requests — the source is gone. */
  UNAVAILABLE = 'UNAVAILABLE',
}

export class GeoCountrySourceHealthDto {
  @ApiProperty({ enum: GeoCountrySourceStatus })
  status!: GeoCountrySourceStatus;

  @ApiProperty({ example: 1240, description: 'Requests whose country was resolved' })
  resolvedCount!: number;

  @ApiProperty({ example: 3, description: 'Requests that arrived without a resolvable country' })
  unknownCount!: number;

  @ApiProperty({ example: 1243 })
  totalCount!: number;

  @ApiProperty({
    example: 0.0024,
    description: 'unknownCount / totalCount, 0 when no requests yet',
  })
  unknownRatio!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 'cf-ipcountry',
    description: 'Header that supplied the most recent country',
  })
  lastResolvedHeader!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-31T12:00:00.000Z' })
  lastResolvedAt!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-31T11:59:00.000Z' })
  lastUnknownAt!: string | null;

  @ApiProperty({
    example: '2026-07-31T09:00:00.000Z',
    description: 'Counters live in process memory and reset on restart; this is when they started',
  })
  windowStartedAt!: string;
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
