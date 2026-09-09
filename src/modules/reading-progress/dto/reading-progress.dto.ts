import { ApiProperty } from '@nestjs/swagger';

// Ручка отдаёт строку Prisma целиком (reading-progress.service.ts: upsert/findUnique без
// `select`), поэтому здесь описаны все её поля. Три из них DTO не называл до 09.09.2026,
// и на этом расхождении встал строгий слой type-sync в `Q4`: схема documented 3 поля,
// ответ содержал 7, а рукописный тип фронта - верные 7.
export class ReadingProgressDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiProperty()
  bookVersionId: string;

  @ApiProperty({ nullable: true })
  chapterNumber: number | null;

  @ApiProperty({ nullable: true })
  audioChapterNumber: number | null;

  @ApiProperty()
  position: number;

  @ApiProperty()
  updatedAt: Date;
}
