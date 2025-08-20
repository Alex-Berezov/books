import { ApiProperty } from '@nestjs/swagger';

export class ReadingProgressDto {
  @ApiProperty({ nullable: true })
  chapterNumber: number | null;

  @ApiProperty({ nullable: true })
  audioChapterNumber: number | null;

  @ApiProperty()
  position: number;
}
