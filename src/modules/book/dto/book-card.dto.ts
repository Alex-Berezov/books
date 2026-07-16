import { ApiProperty } from '@nestjs/swagger';

/**
 * Compact book card model for lists/recommendations.
 *
 * Contains only the fields required by the frontend BookCard component.
 * Intentionally does NOT include versions[], _count, tags, categories,
 * translations, description, JSON content fields, SEO, etc.
 *
 * `id` is the canonical Book.id (bookId), used for deduplication, ratings and relations.
 * `slug` is the BookVersion.slug for the requested :lang.
 */
export class BookCardDto {
  @ApiProperty({
    description: 'Canonical Book.id (bookId)',
    example: '4a23a1fe-b335-4f0d-98fa-a65d187821fe',
  })
  id!: string;

  @ApiProperty({ description: 'BookVersion.slug for the requested language', example: 'hamlet' })
  slug!: string;

  @ApiProperty({ description: 'Localized title', example: 'Hamlet' })
  title!: string;

  @ApiProperty({ description: 'Localized display author name', example: 'William Shakespeare' })
  author!: string;

  @ApiProperty({
    description:
      'Stable author slug for the author page link. null when authorId is null (legacy data).',
    example: 'william-shakespeare',
    nullable: true,
  })
  authorSlug!: string | null;

  @ApiProperty({
    description: 'Localized cover image URL',
    example: 'https://api.bibliaris.com/covers/...png',
    nullable: true,
  })
  coverImageUrl!: string | null;

  @ApiProperty({ description: 'Average rating (0-5)', example: 4.5, nullable: true })
  rating!: number | null;

  @ApiProperty({ description: 'Number of ratings', example: 12 })
  ratingsCount!: number;

  @ApiProperty({
    description: 'Whether a published text version exists for this language',
    example: true,
  })
  hasText!: boolean;

  @ApiProperty({
    description: 'Whether a published audio version exists for this language',
    example: false,
  })
  hasAudio!: boolean;

  @ApiProperty({
    description:
      'ISO date the language version was published (BookVersion.publishedAt). null if unpublished.',
    example: '2026-07-01T00:00:00.000Z',
    nullable: true,
  })
  publishedAt!: string | null;
}
