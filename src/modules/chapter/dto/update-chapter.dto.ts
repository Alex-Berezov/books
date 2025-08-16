import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CreateChapterDto } from './create-chapter.dto';

export class UpdateChapterDto implements Partial<CreateChapterDto> {
  @ApiPropertyOptional({ description: 'Порядковый номер главы', example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  number?: number;

  @ApiPropertyOptional({ description: 'Заголовок главы' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Контент главы' })
  @IsOptional()
  @IsString()
  content?: string;
}
