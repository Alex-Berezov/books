import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type RegionalRightsStatus =
  | 'ALLOWED'
  | 'BLOCKED'
  | 'LICENSE_REQUIRED'
  | 'PENDING_REVIEW'
  | 'NOT_TARGETED'
  | 'MIXED';

export class TerritoryRegionCountryDto {
  @ApiProperty() countryCode!: string;
  @ApiProperty() finalStatus!: string;
  @ApiProperty() accessPolicy!: string;
  @ApiProperty() geoBlockRequired!: boolean;
  @ApiPropertyOptional() geoBlockScope!: string | null;
  @ApiProperty() reasonRu!: string;
  @ApiPropertyOptional() legalBasisRu!: string | null;
  @ApiProperty() confidence!: string;
  @ApiPropertyOptional() nextReviewAt!: string | null;
}

export class TerritoryRegionReasonDto {
  @ApiProperty() countryCode!: string;
  @ApiProperty() finalStatus!: string;
  @ApiProperty() accessPolicy!: string;
  @ApiProperty() reasonRu!: string;
  @ApiPropertyOptional() legalBasisRu!: string | null;
}

export class TerritoryRegionSummaryDto {
  @ApiProperty() regionCode!: string;
  @ApiProperty() label!: string;
  @ApiProperty() status!: RegionalRightsStatus;
  @ApiProperty() countryCount!: number;
  @ApiProperty() targetedCountryCount!: number;
  @ApiProperty() allowedCountryCount!: number;
  @ApiProperty() blockedCountryCount!: number;
  @ApiProperty() licenseRequiredCountryCount!: number;
  @ApiProperty() pendingReviewCountryCount!: number;
  @ApiProperty() notTargetedCountryCount!: number;
  @ApiProperty() geoBlockRequiredCount!: number;
  @ApiProperty({ type: [TerritoryRegionCountryDto] }) countries!: TerritoryRegionCountryDto[];
  @ApiProperty({ type: [TerritoryRegionReasonDto] }) blockingReasons!: TerritoryRegionReasonDto[];
}
