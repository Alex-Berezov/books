import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, IsUrl, Min } from 'class-validator';

export class CreateAudioChapterDto {
  @ApiProperty({ description: 'Порядковый номер аудио-главы внутри версии', example: 1 })
  @IsInt()
  @Min(1)
  number!: number;

  @ApiProperty({ description: 'Заголовок аудио-главы', example: 'Chapter 1. The Beginning' })
  @IsString()
  title!: string;

  @ApiProperty({ description: 'URL аудио файла', example: 'https://cdn.example.com/audio/1.mp3' })
  @IsUrl()
  audioUrl!: string;

  @ApiProperty({ description: 'Длительность в секундах', example: 360 })
  @IsInt()
  @Min(1)
  duration!: number;
}
