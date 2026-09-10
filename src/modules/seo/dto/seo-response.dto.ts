import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Поля зеркалят модель `Seo` (`prisma/schema.prisma`) один в один: `GET`/`PUT`
 * `versions/:bookVersionId/seo` отдают запись целиком, без выборки полей.
 */
export class SeoResponseDto {
  @ApiProperty()
  id!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: String, nullable: true })
  metaTitle!: string | null;

  @ApiProperty({ type: String, nullable: true })
  metaDescription!: string | null;

  @ApiProperty({ type: String, nullable: true })
  canonicalUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  robots!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ogTitle!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ogDescription!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ogType!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ogUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ogImageUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ogImageAlt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  twitterCard!: string | null;

  @ApiProperty({ type: String, nullable: true })
  twitterSite!: string | null;

  @ApiProperty({ type: String, nullable: true })
  twitterCreator!: string | null;

  @ApiProperty({ type: String, nullable: true })
  eventName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  eventDescription!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  eventStartDate!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  eventEndDate!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  eventUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  eventImageUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  eventLocationName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  eventLocationStreet!: string | null;

  @ApiProperty({ type: String, nullable: true })
  eventLocationCity!: string | null;

  @ApiProperty({ type: String, nullable: true })
  eventLocationRegion!: string | null;

  @ApiProperty({ type: String, nullable: true })
  eventLocationPostal!: string | null;

  @ApiProperty({ type: String, nullable: true })
  eventLocationCountry!: string | null;
}
