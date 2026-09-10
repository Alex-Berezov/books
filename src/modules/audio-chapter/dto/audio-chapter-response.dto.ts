import { ApiProperty } from '@nestjs/swagger';

/**
 * Полная форма аудиоглавы, как её возвращает `AudioChapterService` — методы сервиса
 * читают `prisma.audioChapter` без `select`, то есть отдают все колонки модели
 * `AudioChapter` (`prisma/schema.prisma`).
 */
export class AudioChapterResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  bookVersionId!: string;

  @ApiProperty()
  number!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  audioUrl!: string;

  @ApiProperty()
  duration!: number;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  transcript!: string | null;

  @ApiProperty({ type: String, nullable: true })
  mediaId!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}
