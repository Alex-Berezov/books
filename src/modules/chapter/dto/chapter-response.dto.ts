import { ApiProperty } from '@nestjs/swagger';

/**
 * Полная форма главы, как её возвращает `ChapterService` — методы сервиса читают
 * `prisma.chapter` без `select`, то есть отдают все колонки модели `Chapter`
 * (`prisma/schema.prisma`). У модели нет `updatedAt` — только `createdAt`.
 */
export class ChapterResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookVersionId!: string;

  @ApiProperty({ type: Number })
  number!: number;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  content!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}
