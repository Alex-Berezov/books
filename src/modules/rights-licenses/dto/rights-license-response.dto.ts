import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  RightsLicenseEventType,
  RightsLicenseLinkType,
  RightsLicenseMediaFormat,
  RightsLicenseStatus,
  RightsLicenseTerritoryScope,
  RightsLicenseType,
} from '../rights-license-interface';

/**
 * 🔴 Обнуляемое поле здесь пишется `@ApiProperty({ type: <T>, nullable: true })`, а не
 * `@ApiPropertyOptional({ nullable: true })`. Причины две, и обе машинные.
 *
 * 1. Без `type` Swagger берёт тип из `design:type`, а у объединения `string | null` он равен
 *    `Object` - в схему уходит объект без свойств (`Record<string, never>`), и сверять по нему
 *    нечего (`LEGACY-374`).
 * 2. `@ApiPropertyOptional` выводит поле из `required`, хотя мапперы
 *    (`rights-licenses.service.ts:708` `mapSummary`, `:745` `buildDetail`, `:776` `mapLink`,
 *    `:794` `mapEvent`) выставляют **каждый** ключ явно: пустота выражается значением `null`,
 *    а не отсутствием ключа.
 */
export class RightsLicenseSummaryDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
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

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  licensor!: string;

  @ApiProperty({ type: String, nullable: true })
  licensee!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsHolder!: string | null;

  @ApiProperty({ type: String, nullable: true })
  referenceNumber!: string | null;

  @ApiProperty({ type: String, nullable: true })
  grantedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  effectiveFrom!: string | null;

  @ApiProperty({ type: String, nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ type: Boolean })
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

  @ApiProperty({ type: Boolean })
  commercialUseAllowed!: boolean;

  @ApiProperty({ type: Boolean })
  modificationAllowed!: boolean;

  @ApiProperty({ type: Boolean })
  translationAllowed!: boolean;

  @ApiProperty({ type: Boolean })
  sublicensingAllowed!: boolean;

  @ApiProperty({ type: Boolean })
  attributionRequired!: boolean;

  @ApiProperty({ type: String, nullable: true })
  requiredAttributionText!: string | null;

  @ApiProperty({ type: Boolean })
  exclusive!: boolean;

  @ApiProperty({ type: Boolean })
  revocable!: boolean;

  @ApiProperty({ type: String, nullable: true })
  revokedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  revocationReasonRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  confidence!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;

  @ApiProperty({ type: String })
  updatedAt!: string;
}

export class RightsLicenseLinkDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  rightsLicenseId!: string;

  @ApiProperty({ enum: RightsLicenseLinkType })
  linkType!: RightsLicenseLinkType;

  @ApiProperty({ type: String, nullable: true })
  rightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsComponentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  componentTerritoryAssessmentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  territoryDecisionId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  sourceEditionId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsEvidenceId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  bookVersionId!: string | null;

  @ApiProperty({ type: [String] })
  coversCountryCodes!: string[];

  @ApiProperty({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;
}

export class RightsLicenseEventDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ enum: RightsLicenseEventType })
  eventType!: RightsLicenseEventType;

  @ApiProperty({ enum: RightsLicenseStatus, nullable: true })
  previousStatus!: RightsLicenseStatus | null;

  @ApiProperty({ enum: RightsLicenseStatus, nullable: true })
  currentStatus!: RightsLicenseStatus | null;

  @ApiProperty({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  createdByUserId!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;
}

export class RightsLicenseDetailDto extends RightsLicenseSummaryDto {
  @ApiProperty({ type: String, nullable: true })
  royaltyTermsRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  otherConditionsRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  documentStorageKey!: string | null;

  @ApiProperty({ type: String, nullable: true })
  documentSha256!: string | null;

  @ApiProperty({ type: String, nullable: true })
  documentUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  documentMediaAssetId!: string | null;

  @ApiProperty({ type: [String] })
  sourceEvidenceIds!: string[];

  @ApiProperty({ type: String, nullable: true })
  createdByUserId!: string | null;

  @ApiProperty({ type: String, nullable: true })
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

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  page!: number;

  @ApiProperty({ type: Number })
  limit!: number;
}

export class LicenseIssueDto {
  @ApiProperty({ type: String, example: 'LICENSE_MISSING_FOR_COUNTRY' })
  code!: string;

  @ApiProperty({ enum: ['BLOCKER', 'WARNING'] })
  severity!: 'BLOCKER' | 'WARNING';

  @ApiProperty({ type: String })
  messageRu!: string;

  // Ключа может не быть вовсе, но `null` в нём не бывает: обе ветки, которые собирают
  // `LicenseIssue`, кладут либо строку, либо ничего - `rejectionFor` пишет `licenseId`
  // и `countryCode` через `base` (rights-license-coverage.service.ts:359), а
  // `LICENSE_MISSING_FOR_COUNTRY` - только `countryCode` (там же:340). Поэтому
  // необязательное поле без `nullable`, а не `nullable` без обязательности.
  @ApiPropertyOptional({ type: String })
  licenseId?: string;

  @ApiPropertyOptional({ type: String })
  countryCode?: string;
}

export class CountryCoverageResultDto {
  @ApiProperty({ type: String, example: 'ES' })
  countryCode!: string;

  @ApiProperty({ type: Boolean })
  covered!: boolean;

  @ApiProperty({ type: [String] })
  licenseIds!: string[];

  @ApiProperty({ type: [LicenseIssueDto] })
  issues!: LicenseIssueDto[];
}

export class LicenseCoverageResultDto {
  @ApiProperty({ enum: ['NOT_REQUIRED', 'COVERED', 'PARTIAL', 'NOT_COVERED'] })
  status!: 'NOT_REQUIRED' | 'COVERED' | 'PARTIAL' | 'NOT_COVERED';

  @ApiProperty({ type: String })
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
  @ApiProperty({ type: Boolean, example: true })
  success!: boolean;
}
