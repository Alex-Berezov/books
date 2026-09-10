import { ApiProperty } from '@nestjs/swagger';

/**
 * Полная форма главы, как её возвращает `ChapterService` — методы сервиса читают
 * `prisma.chapter` без `select`, то есть отдают все колонки модели `Chapter`
 * (`prisma/schema.prisma`). У модели нет `updatedAt` — только `createdAt`.
 */
export class ChapterResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  bookVersionId!: string;

  @ApiProperty()
  number!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  content!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}
