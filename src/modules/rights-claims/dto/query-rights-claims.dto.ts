import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  RightsClaimChannel,
  RightsClaimResolution,
  RightsClaimSeverity,
  RightsClaimStatus,
  RightsClaimType,
  RightsClaimantType,
} from '../rights-claim-interface';

/** Query booleans arrive as strings ("true"/"1"); normalise them before validation. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

export class QueryRightsClaimsDto {
  @ApiPropertyOptional({
    description:
      'Search term for claimNumber, claimantName, claimantOrganization, claimantEmail, ' +
      'claimedWorkTitle, claimedWorkAuthor, descriptionRu',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: RightsClaimStatus })
  @IsOptional()
  @IsEnum(RightsClaimStatus)
  status?: RightsClaimStatus;

  @ApiPropertyOptional({ enum: RightsClaimType })
  @IsOptional()
  @IsEnum(RightsClaimType)
  claimType?: RightsClaimType;

  @ApiPropertyOptional({ enum: RightsClaimSeverity })
  @IsOptional()
  @IsEnum(RightsClaimSeverity)
  severity?: RightsClaimSeverity;

  @ApiPropertyOptional({ enum: RightsClaimResolution })
  @IsOptional()
  @IsEnum(RightsClaimResolution)
  resolution?: RightsClaimResolution;

  @ApiPropertyOptional({ enum: RightsClaimChannel })
  @IsOptional()
  @IsEnum(RightsClaimChannel)
  channel?: RightsClaimChannel;

  @ApiPropertyOptional({ enum: RightsClaimantType })
  @IsOptional()
  @IsEnum(RightsClaimantType)
  claimantType?: RightsClaimantType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignedToUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bookId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bookVersionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rightsProfileId?: string;

  @ApiPropertyOptional({ example: 'US', description: 'Matches affectedCountryCodes' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  countryCode?: string;

  @ApiPropertyOptional({ description: 'Only claims in an open status' })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  openOnly?: boolean;

  @ApiPropertyOptional({ description: 'Only open claims whose deadline has passed' })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  overdueOnly?: boolean;

  @ApiPropertyOptional({ description: 'Only claims with at least one active access block' })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  hasActiveBlock?: boolean;

  @ApiPropertyOptional({ description: 'Only claims whose deadline falls within N days' })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  deadlineWithinDays?: number;

  @ApiPropertyOptional({ description: 'ISO date — lower bound of receivedAt' })
  @IsOptional()
  @IsDateString()
  receivedFrom?: string;

  @ApiPropertyOptional({ description: 'ISO date — upper bound of receivedAt' })
  @IsOptional()
  @IsDateString()
  receivedTo?: string;

  @ApiPropertyOptional()
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  requiresLawyerReview?: boolean;

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
