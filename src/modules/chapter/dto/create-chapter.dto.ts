import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';

export class CreateChapterDto {
  @ApiProperty({
    description: 'Chapter order number within the version (auto-assigned if omitted)',
    example: 1,
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  number?: number;

  @ApiProperty({ description: 'Chapter title', example: 'Chapter 1. The Boy Who Lived' })
  @IsString()
  title!: string;

  @ApiProperty({
    description: 'Chapter content (markdown/html/plain)',
    example: 'Once upon a time...',
  })
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.body)
  content!: string;
}
