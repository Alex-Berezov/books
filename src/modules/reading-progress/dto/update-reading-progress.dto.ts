import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Min, ValidateIf } from 'class-validator';
import { Xor } from '../../../shared/validators/xor.decorator';

export class UpdateReadingProgressDto {
  @ApiPropertyOptional({ description: 'Chapter number for text reading (>=1)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Xor('chapterNumber', 'audioChapterNumber', {
    message: 'Exactly one of chapterNumber or audioChapterNumber must be provided',
  })
  @ValidateIf((o: UpdateReadingProgressDto) => o.chapterNumber !== undefined)
  chapterNumber?: number;

  @ApiPropertyOptional({ description: 'Audio chapter number for audio listening (>=1)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @ValidateIf((o: UpdateReadingProgressDto) => o.audioChapterNumber !== undefined)
  audioChapterNumber?: number;

  @ApiPropertyOptional({
    description: 'Playback/scroll position; seconds for audio or fraction for text',
    example: 12.5,
  })
  @IsNumber()
  @Min(0)
  position: number;
}
