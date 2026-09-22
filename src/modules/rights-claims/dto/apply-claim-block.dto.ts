import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ClaimBlockScope } from '../rights-claim-interface';
import { ALLOWED_CLAIM_BLOCK_SCOPES } from '../rights-claim.constants';

export class ApplyClaimBlockDto {
  @ApiProperty({
    enum: ALLOWED_CLAIM_BLOCK_SCOPES,
    description:
      'SPECIFIC_ASSET is forbidden (LEGACY-027): a block with that scope never matches any request. Point-level blocking of a single file is done by hand, not through a claim.',
  })
  @IsIn(ALLOWED_CLAIM_BLOCK_SCOPES)
  scope!: ClaimBlockScope;

  @ApiPropertyOptional({
    type: [String],
    description: 'Empty or omitted = a single worldwide block (countryCode = null)',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  countryCodes?: string[];

  @ApiPropertyOptional({ description: 'Defaults to the claim target version' })
  @IsOptional()
  @IsUUID()
  bookVersionId?: string;

  @ApiPropertyOptional({ description: 'Defaults to the claim target book' })
  @IsOptional()
  @IsUUID()
  bookId?: string;

  @ApiProperty()
  @IsString()
  reasonRu!: string;

  @ApiPropertyOptional({ description: 'ISO date; the block stops applying after it' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ default: false, description: 'Also move the published version to draft' })
  @IsOptional()
  @IsBoolean()
  unpublishVersion?: boolean;
}
