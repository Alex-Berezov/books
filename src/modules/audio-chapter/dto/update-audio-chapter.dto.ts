import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUrl, Min } from 'class-validator';
import { CreateAudioChapterDto } from './create-audio-chapter.dto';

export class UpdateAudioChapterDto implements Partial<CreateAudioChapterDto> {
  @ApiPropertyOptional({ description: 'Sequential number of the audio chapter', example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  number?: number;

  @ApiPropertyOptional({ description: 'Audio chapter title' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Audio file URL' })
  @IsOptional()
  @IsUrl()
  audioUrl?: string;

  @ApiPropertyOptional({ description: 'Duration in seconds' })
  @IsOptional()
  @IsInt()
  @Min(1)
  duration?: number;
}
