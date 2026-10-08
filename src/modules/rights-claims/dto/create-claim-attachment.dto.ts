import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { RightsClaimAttachmentType } from '../rights-claim-interface';
import { IsAbsoluteHttpUrl } from '../../../shared/validators/absolute-http-url.decorator';

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
  @IsUUID()
  mediaAssetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storageKey?: string;

  @ApiPropertyOptional()
  // `javascript:` в ссылке исполнился бы по клику на сайте или в админке (`LEGACY-447`).
  // `''` — «не задано», как было при `@IsString()`: пачка сужает формат адреса, а не пустое
  // значение (решение арбитра T94, `decisions-log.md` 03.10.2026).
  @ValidateIf((_o, value) => value !== undefined && value !== null && value !== '')
  @IsAbsoluteHttpUrl()
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
