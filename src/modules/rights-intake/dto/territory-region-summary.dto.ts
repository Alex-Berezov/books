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
  /**
   * WP-C.4: второй знаменатель — сколько стран региона входит в план публикации версии.
   * `0` означает «план неизвестен либо регион вне плана»; доля по справочнику региона
   * (`countryCount`) остаётся на месте и по-прежнему решает, зелёный ли регион (R6-04).
   */
  @ApiProperty() targetCountryCount!: number;
  /** WP-C.4: числитель доли по плану публикации — разрешённые страны плана в этом регионе. */
  @ApiProperty() targetAllowedCountryCount!: number;
  @ApiProperty() allowedCountryCount!: number;
  @ApiProperty() licensedCountryCount!: number;
  @ApiProperty() blockedCountryCount!: number;
  @ApiProperty() licenseRequiredCountryCount!: number;
  @ApiProperty() pendingReviewCountryCount!: number;
  @ApiProperty() notTargetedCountryCount!: number;
  @ApiProperty() undecidedCountryCount!: number;
  @ApiProperty() geoBlockRequiredCount!: number;
  @ApiProperty({ type: [TerritoryRegionCountryDto] }) countries!: TerritoryRegionCountryDto[];
  @ApiProperty({ type: [TerritoryRegionReasonDto] }) blockingReasons!: TerritoryRegionReasonDto[];
}
