import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Поля зеркалят модель `BookSummary` (`prisma/schema.prisma`) один в один:
 * `getByVersion`/`upsertForVersion` отдают запись целиком, без выборки полей.
 */
export class BookSummaryResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  bookVersionId!: string;

  @ApiProperty()
  summary!: string;

  @ApiProperty({ type: String, nullable: true })
  analysis!: string | null;

  @ApiProperty({ type: String, nullable: true })
  themes!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}
