import { ApiProperty } from '@nestjs/swagger';

// Ручка отдаёт строку Prisma целиком (reading-progress.service.ts: upsert/findUnique без
// `select`), поэтому здесь описаны все её поля. Три из них DTO не называл до 09.09.2026,
// и на этом расхождении встал строгий слой type-sync в `Q4`: схема documented 3 поля,
// ответ содержал 7, а рукописный тип фронта - верные 7.
export class ReadingProgressDto {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty({ type: String })
  userId: string;

  @ApiProperty({ type: String })
  bookVersionId: string;

  /**
   * 🔴 `type: Number` обязателен. Без него `@ApiProperty({ nullable: true })` над полем
   * union-типа `number | null` даёт в OpenAPI `type: object` без свойств: Swagger не
   * выводит тип из TypeScript сам — плагина в проекте нет (`nest-cli.json` без `plugins`).
   * Рукописный тип фронта (`books-front/types/api-schema/bookshelf.ts`, `ReadingProgress`)
   * верно называет число, и на бестиповом объекте расходилась машинная сверка
   * (`LEGACY-374`).
   */
  @ApiProperty({ type: Number, nullable: true })
  chapterNumber: number | null;

  @ApiProperty({ type: Number, nullable: true })
  audioChapterNumber: number | null;

  @ApiProperty({ type: Number })
  position: number;

  @ApiProperty({ type: Date })
  updatedAt: Date;
}
