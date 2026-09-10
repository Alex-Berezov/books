import { ApiProperty } from '@nestjs/swagger';
import { AudioChapterResponseDto } from './audio-chapter-response.dto';

/**
 * Ответ списков аудиоглав (`GET /versions/{id}/audio-chapters`,
 * `GET /admin/versions/{id}/audio-chapters`). Форма обёртки — своя для этого модуля,
 * берётся из `AudioChapterService.listInternal`: `{items,total,page,limit,totalPages}`,
 * не унифицируется с формой других модулей (`{data,meta}` у tags/categories,
 * `{items,total,page,limit}` без `totalPages` у users).
 */
export class PagedAudioChaptersDto {
  @ApiProperty({ type: AudioChapterResponseDto, isArray: true })
  items!: AudioChapterResponseDto[];

  @ApiProperty({ type: Number, example: 42 })
  total!: number;

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 50 })
  limit!: number;

  @ApiProperty({ type: Number, example: 1 })
  totalPages!: number;
}
