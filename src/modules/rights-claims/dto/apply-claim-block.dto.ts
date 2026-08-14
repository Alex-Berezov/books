import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ClaimBlockScope } from '../rights-claim-interface';

export class ApplyClaimBlockDto {
  @ApiProperty({ enum: ClaimBlockScope })
  @IsEnum(ClaimBlockScope)
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
