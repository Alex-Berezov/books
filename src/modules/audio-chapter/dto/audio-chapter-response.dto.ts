import { ApiProperty } from '@nestjs/swagger';

/**
 * Полная форма аудиоглавы, как её возвращает `AudioChapterService` — методы сервиса
 * читают `prisma.audioChapter` без `select`, то есть отдают все колонки модели
 * `AudioChapter` (`prisma/schema.prisma`).
 */
export class AudioChapterResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookVersionId!: string;

  @ApiProperty({ type: Number })
  number!: number;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  audioUrl!: string;

  @ApiProperty({ type: Number })
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
