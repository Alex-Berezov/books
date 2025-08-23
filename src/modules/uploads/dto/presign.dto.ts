import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export enum UploadType {
  cover = 'cover',
  audio = 'audio',
}

export class PresignRequestDto {
  @ApiProperty({ enum: UploadType, example: UploadType.cover })
  @IsEnum(UploadType)
  type!: UploadType;

  @ApiProperty({ description: 'MIME type of the file', example: 'image/jpeg' })
  @IsString()
  @IsNotEmpty()
  contentType!: string;

  @ApiProperty({ description: 'Estimated file size in bytes', example: 1024 * 1024 })
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  size!: number;
}

export class PresignResponseDto {
  @ApiProperty()
  key!: string;

  @ApiProperty({ description: 'Direct upload URL (for local driver this is API endpoint)' })
  url!: string;

  @ApiProperty({ description: 'HTTP method to use', enum: ['POST', 'PUT'], example: 'POST' })
  method!: 'POST' | 'PUT';

  @ApiProperty({ description: 'Headers to include with upload request', required: false })
  @IsOptional()
  headers?: Record<string, string>;

  @ApiProperty({ description: 'Token required by direct upload endpoint' })
  token!: string;

  @ApiProperty({ description: 'Time-to-live in seconds' })
  ttlSec!: number;
}

export class DirectUploadResponseDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  publicUrl!: string;
}
