import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { RightsLicenseLinkType } from '../rights-license-interface';

export class LinkRightsLicenseDto {
  @ApiProperty({ enum: RightsLicenseLinkType })
  @IsEnum(RightsLicenseLinkType)
  linkType!: RightsLicenseLinkType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rightsProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rightsComponentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  componentTerritoryAssessmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  territoryDecisionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceEditionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rightsEvidenceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bookVersionId?: string;

  @ApiPropertyOptional({ type: [String], example: ['ES'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[A-Za-z]{2}$/, { each: true })
  coversCountryCodes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notesRu?: string;
}
