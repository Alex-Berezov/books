import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAudioChapterDto {
  @ApiProperty({
    description: 'Sequential number of the audio chapter within the version',
    example: 1,
  })
  @IsInt()
  @Min(1)
  number!: number;

  @ApiProperty({
    description: 'Audio chapter title',
    example: 'Chapter 1. The Beginning',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @Length(1, 255)
  title!: string;

  @ApiProperty({
    description: 'Audio file URL',
    example: 'https://cdn.example.com/audio/1.mp3',
  })
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  audioUrl!: string;

  @ApiProperty({
    description: 'Duration in seconds (0..86400)',
    example: 360,
    minimum: 0,
    maximum: 86400,
  })
  @IsInt()
  @Min(0)
  @Max(86400)
  duration!: number;

  @ApiPropertyOptional({
    description: 'Short description of the chapter (plain/markdown, ≤ 5000 chars)',
    maxLength: 5000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Full transcript of the chapter (markdown)',
  })
  @IsOptional()
  @IsString()
  transcript?: string;

  @ApiPropertyOptional({
    description: 'Associated MediaAsset id (from Media Library)',
  })
  @IsOptional()
  @IsUUID()
  mediaId?: string;
}
