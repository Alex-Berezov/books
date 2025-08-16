import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Min } from 'class-validator';

export class CreateChapterDto {
  @ApiProperty({ description: 'Порядковый номер главы внутри версии', example: 1 })
  @IsInt()
  @Min(1)
  number!: number;

  @ApiProperty({ description: 'Заголовок главы', example: 'Chapter 1. The Boy Who Lived' })
  @IsString()
  title!: string;

  @ApiProperty({
    description: 'Контент главы (markdown/html/plain)',
    example: 'Once upon a time...',
  })
  @IsString()
  content!: string;
}
