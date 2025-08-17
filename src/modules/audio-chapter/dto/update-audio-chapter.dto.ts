import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUrl, Min } from 'class-validator';
import { CreateAudioChapterDto } from './create-audio-chapter.dto';

export class UpdateAudioChapterDto implements Partial<CreateAudioChapterDto> {
  @ApiPropertyOptional({ description: 'Порядковый номер аудио-главы', example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  number?: number;

  @ApiPropertyOptional({ description: 'Заголовок аудио-главы' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'URL аудио файла' })
  @IsOptional()
  @IsUrl()
  audioUrl?: string;

  @ApiPropertyOptional({ description: 'Длительность в секундах' })
  @IsOptional()
  @IsInt()
  @Min(1)
  duration?: number;
}
