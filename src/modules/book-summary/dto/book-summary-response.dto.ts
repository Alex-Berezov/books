import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Поля зеркалят модель `BookSummary` (`prisma/schema.prisma`) один в один:
 * `getByVersion`/`upsertForVersion` отдают запись целиком, без выборки полей.
 */
export class BookSummaryResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookVersionId!: string;

  @ApiProperty({ type: String })
  summary!: string;

  @ApiProperty({
    type: Boolean,
    description: 'В summary есть видимый текст; по нему считаются _count.summaries и hasSummary',
  })
  hasText!: boolean;

  @ApiProperty({ type: String, nullable: true })
  analysis!: string | null;

  @ApiProperty({ type: String, nullable: true })
  themes!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Very short summary (rich HTML); written by PUT versions/:id/summary/brief only',
  })
  brief!: string | null;

  @ApiProperty({
    type: Boolean,
    description: 'brief has visible text; the "In brief" block is shown only then',
  })
  briefHasText!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}
