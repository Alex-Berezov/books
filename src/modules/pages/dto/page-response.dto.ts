import { ApiProperty } from '@nestjs/swagger';
import { PublicationStatus, Language } from '@prisma/client';

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
