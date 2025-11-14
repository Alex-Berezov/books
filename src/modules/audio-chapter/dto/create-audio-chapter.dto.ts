import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, IsUrl, Min } from 'class-validator';

export class CreateAudioChapterDto {
  @ApiProperty({
    description: 'Sequential number of the audio chapter within the version',
    example: 1,
  })
  @IsInt()
  @Min(1)
  number!: number;

  @ApiProperty({ description: 'Audio chapter title', example: 'Chapter 1. The Beginning' })
  @IsString()
  title!: string;

  @ApiProperty({ description: 'Audio file URL', example: 'https://cdn.example.com/audio/1.mp3' })
  @IsUrl()
  audioUrl!: string;

  @ApiProperty({ description: 'Duration in seconds', example: 360 })
  @IsInt()
  @Min(1)
  duration!: number;
}
