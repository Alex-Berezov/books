import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  RightsLicenseEventType,
  RightsLicenseLinkType,
  RightsLicenseMediaFormat,
  RightsLicenseStatus,
  RightsLicenseTerritoryScope,
  RightsLicenseType,
} from '../rights-license-interface';

export class RightsLicenseSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  licenseKey!: string | null;

  @ApiProperty({ enum: RightsLicenseType })
  licenseType!: RightsLicenseType;

  @ApiProperty({ enum: RightsLicenseStatus })
  status!: RightsLicenseStatus;

  @ApiProperty({
    enum: RightsLicenseStatus,
    description: 'Status computed at request time (expiry, revocation, effective date applied)',
  })
  effectiveStatus!: RightsLicenseStatus;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  licensor!: string;

  @ApiPropertyOptional({ nullable: true })
  licensee!: string | null;

  @ApiPropertyOptional({ nullable: true })
  rightsHolder!: string | null;

  @ApiPropertyOptional({ nullable: true })
  referenceNumber!: string | null;

  @ApiPropertyOptional({ nullable: true })
  grantedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  effectiveFrom!: string | null;

  @ApiPropertyOptional({ nullable: true })
  expiresAt!: string | null;

  @ApiProperty()
  isPerpetual!: boolean;

  @ApiProperty({ enum: RightsLicenseTerritoryScope })
  territoryScope!: RightsLicenseTerritoryScope;

  @ApiProperty({ type: [String] })
  countryCodes!: string[];

  @ApiProperty({ type: [String] })
  excludedCountryCodes!: string[];

  @ApiProperty({ type: [String] })
  languageCodes!: string[];

  @ApiProperty({ enum: RightsLicenseMediaFormat, isArray: true })
  mediaFormats!: RightsLicenseMediaFormat[];

  @ApiProperty()
  commercialUseAllowed!: boolean;

  @ApiProperty()
  modificationAllowed!: boolean;

  @ApiProperty()
  translationAllowed!: boolean;

  @ApiProperty()
  sublicensingAllowed!: boolean;

  @ApiProperty()
  attributionRequired!: boolean;

  @ApiPropertyOptional({ nullable: true })
  requiredAttributionText!: string | null;

  @ApiProperty()
  exclusive!: boolean;

  @ApiProperty()
  revocable!: boolean;

  @ApiPropertyOptional({ nullable: true })
  revokedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  revocationReasonRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  confidence!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class RightsLicenseLinkDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rightsLicenseId!: string;

  @ApiProperty({ enum: RightsLicenseLinkType })
  linkType!: RightsLicenseLinkType;

  @ApiPropertyOptional({ nullable: true })
  rightsProfileId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  rightsComponentId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  componentTerritoryAssessmentId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  territoryDecisionId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  sourceEditionId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  rightsEvidenceId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  bookVersionId!: string | null;

  @ApiProperty({ type: [String] })
  coversCountryCodes!: string[];

  @ApiPropertyOptional({ nullable: true })
  notesRu!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class RightsLicenseEventDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: RightsLicenseEventType })
  eventType!: RightsLicenseEventType;

  @ApiPropertyOptional({ enum: RightsLicenseStatus, nullable: true })
  previousStatus!: RightsLicenseStatus | null;

  @ApiPropertyOptional({ enum: RightsLicenseStatus, nullable: true })
  currentStatus!: RightsLicenseStatus | null;

  @ApiPropertyOptional({ nullable: true })
  notesRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  createdByUserId!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class RightsLicenseDetailDto extends RightsLicenseSummaryDto {
  @ApiPropertyOptional({ nullable: true })
  royaltyTermsRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  otherConditionsRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  notesRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  documentStorageKey!: string | null;

  @ApiPropertyOptional({ nullable: true })
  documentSha256!: string | null;

  @ApiPropertyOptional({ nullable: true })
  documentUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  documentMediaAssetId!: string | null;

  @ApiProperty({ type: [String] })
  sourceEvidenceIds!: string[];

  @ApiPropertyOptional({ nullable: true })
  createdByUserId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  revokedByUserId!: string | null;

  @ApiProperty({ type: [RightsLicenseLinkDto] })
  links!: RightsLicenseLinkDto[];

  @ApiProperty({ type: [RightsLicenseEventDto] })
  events!: RightsLicenseEventDto[];

  @ApiProperty({ type: [String], description: 'Non-blocking notices produced by the last action' })
  warnings!: string[];
}

export class RightsLicenseListResponseDto {
  @ApiProperty({ type: [RightsLicenseSummaryDto] })
  items!: RightsLicenseSummaryDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class LicenseIssueDto {
  @ApiProperty({ example: 'LICENSE_MISSING_FOR_COUNTRY' })
  code!: string;

  @ApiProperty({ enum: ['BLOCKER', 'WARNING'] })
  severity!: 'BLOCKER' | 'WARNING';

  @ApiProperty()
  messageRu!: string;

  @ApiPropertyOptional({ nullable: true })
  licenseId?: string;

  @ApiPropertyOptional({ nullable: true })
  countryCode?: string;
}

export class CountryCoverageResultDto {
  @ApiProperty({ example: 'ES' })
  countryCode!: string;

  @ApiProperty()
  covered!: boolean;

  @ApiProperty({ type: [String] })
  licenseIds!: string[];

  @ApiProperty({ type: [LicenseIssueDto] })
  issues!: LicenseIssueDto[];
}

export class LicenseCoverageResultDto {
  @ApiProperty({ enum: ['NOT_REQUIRED', 'COVERED', 'PARTIAL', 'NOT_COVERED'] })
  status!: 'NOT_REQUIRED' | 'COVERED' | 'PARTIAL' | 'NOT_COVERED';

  @ApiProperty()
  checkedAt!: string;

  @ApiProperty({ type: [String] })
  requiredCountryCodes!: string[];

  @ApiProperty({ type: [String] })
  coveredCountryCodes!: string[];

  @ApiProperty({ type: [String] })
  uncoveredCountryCodes!: string[];

  @ApiProperty({ type: [CountryCoverageResultDto] })
  countries!: CountryCoverageResultDto[];

  @ApiProperty({ type: [String] })
  licenseIds!: string[];

  @ApiProperty({ type: [LicenseIssueDto] })
  blockers!: LicenseIssueDto[];

  @ApiProperty({ type: [LicenseIssueDto] })
  warnings!: LicenseIssueDto[];

  @ApiProperty({ type: [String] })
  attributionTextsRu!: string[];
}

export class UnlinkRightsLicenseResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;
}
