import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RightsLegalChangeType, RightsRecheckSeverity } from '../rights-recheck-interface';

export class CreateLegalChangeDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  titleRu!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(8000)
  descriptionRu!: string;

  @ApiProperty({ enum: RightsLegalChangeType })
  @IsEnum(RightsLegalChangeType)
  changeType!: RightsLegalChangeType;

  @ApiPropertyOptional({ enum: RightsRecheckSeverity, default: RightsRecheckSeverity.WARNING })
  @IsOptional()
  @IsEnum(RightsRecheckSeverity)
  severity?: RightsRecheckSeverity;

  @ApiProperty({ type: [String], description: 'ISO-3166-1 alpha-2 codes' })
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[A-Z]{2}$/, { each: true })
  jurisdictionCodes!: string[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  appliesToAllCountries?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  @MaxLength(2000)
  sourceUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  sourceTitle?: string;
}
