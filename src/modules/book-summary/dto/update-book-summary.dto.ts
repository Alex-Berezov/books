import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';

export class UpdateBookSummaryDto {
  @ApiProperty({ description: 'Short summary text' })
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  summary!: string;

  @ApiPropertyOptional({ description: 'Optional analysis' })
  @IsOptional()
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  analysis?: string;

  @ApiPropertyOptional({ description: 'Optional themes' })
  @IsOptional()
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  themes?: string;
}
