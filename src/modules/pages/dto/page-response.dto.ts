import { ApiProperty } from '@nestjs/swagger';
import { PublicationStatus, Language } from '@prisma/client';

export class SeoResponse {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ required: false, nullable: true, example: 'SEO Title' })
  metaTitle!: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'SEO Description' })
  metaDescription!: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'https://example.com/page' })
  canonicalUrl!: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'index, follow' })
  robots!: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'OG Title' })
  ogTitle!: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'OG Description' })
  ogDescription!: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'website' })
  ogType!: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'https://example.com/page' })
  ogUrl!: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'https://example.com/image.jpg' })
  ogImageUrl!: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'Image alt text' })
  ogImageAlt!: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'summary_large_image' })
  twitterCard!: string | null;

  @ApiProperty({ required: false, nullable: true, example: '@site' })
  twitterSite!: string | null;

  @ApiProperty({ required: false, nullable: true, example: '@creator' })
  twitterCreator!: string | null;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  updatedAt!: Date;
}

export class PageResponse {
  @ApiProperty({ example: 'uuid-here' })
  id!: string;

  @ApiProperty({ example: 'about-us' })
  slug!: string;

  @ApiProperty({ example: 'About Us' })
  title!: string;

  @ApiProperty({ enum: ['generic', 'category_index', 'author_index'] })
  type!: 'generic' | 'category_index' | 'author_index';

  @ApiProperty({ example: 'Page content here...' })
  content!: string;

  @ApiProperty({ enum: Object.values(Language), example: 'en' })
  language!: Language;

  @ApiProperty({ enum: Object.values(PublicationStatus), example: 'draft' })
  status!: PublicationStatus;

  @ApiProperty({ required: false, nullable: true, example: 1 })
  seoId!: number | null;

  @ApiProperty({ required: false, nullable: true, type: SeoResponse })
  seo!: SeoResponse | null;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  updatedAt!: Date;
}

export class PaginationMeta {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 45 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

export class PaginatedPagesResponse {
  @ApiProperty({ type: [PageResponse] })
  data!: PageResponse[];

  @ApiProperty({ type: PaginationMeta })
  meta!: PaginationMeta;
}
