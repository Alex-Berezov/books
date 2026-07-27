import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import {
  RightsLicenseMediaFormat,
  RightsLicenseStatus,
  RightsLicenseTerritoryScope,
  RightsLicenseType,
} from '../rights-license-interface';

export class QueryRightsLicensesDto {
  @ApiPropertyOptional({
    description: 'Search term for title, licensor, licensee, rightsHolder, referenceNumber, key',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: RightsLicenseStatus })
  @IsOptional()
  @IsEnum(RightsLicenseStatus)
  status?: RightsLicenseStatus;

  @ApiPropertyOptional({ enum: RightsLicenseType })
  @IsOptional()
  @IsEnum(RightsLicenseType)
  licenseType?: RightsLicenseType;

  @ApiPropertyOptional({ enum: RightsLicenseTerritoryScope })
  @IsOptional()
  @IsEnum(RightsLicenseTerritoryScope)
  territoryScope?: RightsLicenseTerritoryScope;

  @ApiPropertyOptional({ example: 'ES' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  countryCode?: string;

  @ApiPropertyOptional({ example: 'es' })
  @IsOptional()
  @IsString()
  languageCode?: string;

  @ApiPropertyOptional({ enum: RightsLicenseMediaFormat })
  @IsOptional()
  @IsEnum(RightsLicenseMediaFormat)
  mediaFormat?: RightsLicenseMediaFormat;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rightsProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bookVersionId?: string;

  @ApiPropertyOptional({ description: 'Only licenses expiring within N days' })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  expiringInDays?: number;

  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
