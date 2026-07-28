import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  RightsClaimChannel,
  RightsClaimSeverity,
  RightsClaimType,
  RightsClaimantType,
} from '../rights-claim-interface';

export class CreateRightsClaimDto {
  @ApiProperty({ enum: RightsClaimType })
  @IsEnum(RightsClaimType)
  claimType!: RightsClaimType;

  @ApiPropertyOptional({ enum: RightsClaimSeverity, default: RightsClaimSeverity.MEDIUM })
  @IsOptional()
  @IsEnum(RightsClaimSeverity)
  severity?: RightsClaimSeverity;

  @ApiPropertyOptional({ enum: RightsClaimChannel, default: RightsClaimChannel.EMAIL })
  @IsOptional()
  @IsEnum(RightsClaimChannel)
  channel?: RightsClaimChannel;

  @ApiPropertyOptional({ description: 'ISO date the claim was received' })
  @IsOptional()
  @IsDateString()
  receivedAt?: string;

  @ApiPropertyOptional({ description: 'ISO date the claim must be answered by' })
  @IsOptional()
  @IsDateString()
  deadlineAt?: string;

  // --- Claimant ---

  @ApiProperty()
  @IsString()
  @MaxLength(500)
  claimantName!: string;

  @ApiPropertyOptional({ enum: RightsClaimantType, default: RightsClaimantType.UNKNOWN })
  @IsOptional()
  @IsEnum(RightsClaimantType)
  claimantType?: RightsClaimantType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  claimantOrganization?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(320)
  claimantEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  claimantPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  claimantAddress?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  claimantIsAuthorized?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  claimantPersonId?: string;

  // --- Target ---

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rightsIntakeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mediaAssetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parentClaimId?: string;

  // --- Territories and languages ---

  @ApiPropertyOptional({ type: [String], description: 'Empty = the claim applies worldwide' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  affectedCountryCodes?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  affectedLanguages?: string[];

  // --- Substance ---

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  claimedWorkTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  claimedWorkAuthor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  claimedRightsDescriptionRu?: string;

  @ApiProperty()
  @IsString()
  descriptionRu!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  infringingUrls?: string[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  goodFaithStatement?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  swornStatement?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  originalNoticeText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  originalNoticeUrl?: string;

  // --- Handling ---

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignedToUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internalNotesRu?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  blocksPublication?: boolean;

  @ApiPropertyOptional({ description: 'Required when blocksPublication is set to false' })
  @IsOptional()
  @IsString()
  blocksPublicationOverrideReasonRu?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresLawyerReview?: boolean;
}
