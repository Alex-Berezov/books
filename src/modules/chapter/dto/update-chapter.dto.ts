import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CreateChapterDto } from './create-chapter.dto';

export class UpdateChapterDto implements Partial<CreateChapterDto> {
  @ApiPropertyOptional({ description: 'Chapter order number', example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  number?: number;

  @ApiPropertyOptional({ description: 'Chapter title' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Chapter content' })
  @IsOptional()
  @IsString()
  content?: string;
}
