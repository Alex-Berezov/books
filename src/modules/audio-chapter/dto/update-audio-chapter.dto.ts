import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { CreateAudioChapterDto } from './create-audio-chapter.dto';

export class UpdateAudioChapterDto implements Partial<CreateAudioChapterDto> {
  @ApiPropertyOptional({ description: 'Sequential number of the audio chapter', example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  number?: number;

  @ApiPropertyOptional({ description: 'Audio chapter title', minLength: 1, maxLength: 255 })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  title?: string;

  @ApiPropertyOptional({ description: 'Audio file URL' })
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  audioUrl?: string;

  @ApiPropertyOptional({
    description: 'Duration in seconds (0..86400)',
    minimum: 0,
    maximum: 86400,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  duration?: number;

  @ApiPropertyOptional({ description: 'Short description of the chapter', maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ description: 'Full transcript of the chapter (markdown)' })
  @IsOptional()
  @IsString()
  transcript?: string;

  @ApiPropertyOptional({ description: 'Associated MediaAsset id' })
  @IsOptional()
  @IsUUID()
  mediaId?: string;
}
