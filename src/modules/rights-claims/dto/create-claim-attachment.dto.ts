import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { RightsClaimAttachmentType } from '../rights-claim-interface';

export class CreateClaimAttachmentDto {
  @ApiPropertyOptional({
    enum: RightsClaimAttachmentType,
    default: RightsClaimAttachmentType.EVIDENCE,
  })
  @IsOptional()
  @IsEnum(RightsClaimAttachmentType)
  attachmentType?: RightsClaimAttachmentType;

  @ApiProperty()
  @IsString()
  @MaxLength(500)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  fileName?: string;

  @ApiPropertyOptional({ description: 'One of mediaAssetId / storageKey / url is required' })
  @IsOptional()
  @IsString()
  mediaAssetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storageKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional({ description: '64 hex characters' })
  @IsOptional()
  @IsString()
  sha256?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contentType?: string;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notesRu?: string;
}
