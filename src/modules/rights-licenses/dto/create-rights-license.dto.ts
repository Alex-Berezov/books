import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  RightsLicenseMediaFormat,
  RightsLicenseStatus,
  RightsLicenseTerritoryScope,
  RightsLicenseType,
} from '../rights-license-interface';

export enum RightsLicenseConfidenceDto {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

export class CreateRightsLicenseDto {
  @ApiPropertyOptional({ example: 'license:penguin-2019' })
  @IsOptional()
  @IsString()
  licenseKey?: string;

  @ApiPropertyOptional({ enum: RightsLicenseType, default: RightsLicenseType.DIRECT_LICENSE })
  @IsOptional()
  @IsEnum(RightsLicenseType)
  licenseType?: RightsLicenseType;

  @ApiPropertyOptional({ enum: RightsLicenseStatus, default: RightsLicenseStatus.DRAFT })
  @IsOptional()
  @IsEnum(RightsLicenseStatus)
  status?: RightsLicenseStatus;

  @ApiProperty({ example: 'Лицензия на испанский перевод (Penguin, 2019)' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiProperty({ example: 'Penguin Random House' })
  @IsString()
  @IsNotEmpty()
  licensor!: string;

  @ApiPropertyOptional({ example: 'Bibliaris' })
  @IsOptional()
  @IsString()
  licensee?: string;

  @ApiPropertyOptional({ example: 'Penguin Random House' })
  @IsOptional()
  @IsString()
  rightsHolder?: string;

  @ApiPropertyOptional({ example: 'PRH-2019-4471' })
  @IsOptional()
  @IsString()
  referenceNumber?: string;

  @ApiPropertyOptional({ example: '2019-05-01' })
  @IsOptional()
  @IsISO8601()
  grantedAt?: string;

  @ApiPropertyOptional({ example: '2019-06-01' })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional({ example: '2029-06-01' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPerpetual?: boolean;

  @ApiPropertyOptional({
    enum: RightsLicenseTerritoryScope,
    default: RightsLicenseTerritoryScope.UNKNOWN,
  })
  @IsOptional()
  @IsEnum(RightsLicenseTerritoryScope)
  territoryScope?: RightsLicenseTerritoryScope;

  @ApiPropertyOptional({ type: [String], example: ['ES', 'MX', 'AR'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[A-Za-z]{2}$/, { each: true })
  countryCodes?: string[];

  @ApiPropertyOptional({ type: [String], example: ['US'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[A-Za-z]{2}$/, { each: true })
  excludedCountryCodes?: string[];

  @ApiPropertyOptional({ type: [String], example: ['es'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languageCodes?: string[];

  @ApiPropertyOptional({ enum: RightsLicenseMediaFormat, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(RightsLicenseMediaFormat, { each: true })
  mediaFormats?: RightsLicenseMediaFormat[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  commercialUseAllowed?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  modificationAllowed?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  translationAllowed?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  sublicensingAllowed?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  attributionRequired?: boolean;

  @ApiPropertyOptional({ example: '© Penguin Random House, 2019' })
  @IsOptional()
  @IsString()
  requiredAttributionText?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  exclusive?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  revocable?: boolean;

  @ApiPropertyOptional({ example: '8% от выручки, ежеквартально.' })
  @IsOptional()
  @IsString()
  royaltyTermsRu?: string;

  @ApiPropertyOptional({ example: 'Запрещено использование обложки издателя.' })
  @IsOptional()
  @IsString()
  otherConditionsRu?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notesRu?: string;

  @ApiPropertyOptional({ example: 'rights/licenses/prh-2019-4471.pdf' })
  @IsOptional()
  @IsString()
  documentStorageKey?: string;

  @ApiPropertyOptional({ description: '64 hex characters' })
  @IsOptional()
  @IsString()
  documentSha256?: string;

  @ApiPropertyOptional({ example: 'https://example.org/license.pdf' })
  @IsOptional()
  @IsString()
  documentUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  documentMediaAssetId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceEvidenceIds?: string[];

  @ApiPropertyOptional({ enum: RightsLicenseConfidenceDto })
  @IsOptional()
  @IsEnum(RightsLicenseConfidenceDto)
  confidence?: RightsLicenseConfidenceDto;
}
