import { ApiProperty } from '@nestjs/swagger';

/** Глава без текста — для «Вводных для промпта» анализа (F03-1, решение арбитра А5). */
export class ChapterTitleDto {
  @ApiProperty({ type: Number })
  number!: number;

  @ApiProperty({ type: String })
  title!: string;
}
