import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language, PageType, PublicationStatus } from '@prisma/client';
import { SeoResponseDto } from '../../seo/dto/seo-response.dto';

/**
 * Response of `GET /:lang/pages/:slug` and `GET /:lang/pages/by-key/:systemKey`
 * (`PagesService.getPublicBySlug` / `getPublicBySystemKey`). Both load the full
 * `Page` row with `include: { seo: true }` — no field whitelist, unlike the public
 * book selects — so every scalar column is part of the real response.
 */
export class PublicPageDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ enum: PageType })
  type!: PageType;

  @ApiProperty()
  content!: string;

  @ApiProperty({ enum: PublicationStatus })
  status!: PublicationStatus;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiPropertyOptional({ type: String, nullable: true })
  translationGroupId!: string | null;

  @ApiPropertyOptional({
    type: String,
    description: 'Immutable key for the pages the site looks up for itself (homepage, hubs)',
    nullable: true,
  })
  systemKey!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  h1!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  shortDescription!: string | null;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { question: { type: 'string' }, answer: { type: 'string' } },
    },
    nullable: true,
    description: 'Json column. Shape declared by `CreatePageDto.faq`.',
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  faq!: unknown;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'Json column. Free-form by design: `CreatePageDto.sections` is `Record<string, unknown>` with no per-key validation, and the front reads it as the same type.',
  })
  sections!: unknown;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: Number, nullable: true })
  seoId!: number | null;

  @ApiPropertyOptional({ type: SeoResponseDto, nullable: true })
  seo!: SeoResponseDto | null;
}
