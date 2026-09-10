import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { BookCategoryDto, PublicBookVersionDto } from '../../book/dto/book-detail-response.dto';
import {
  BookVersionTagLinkDto,
  CategoryTranslationScalarsDto,
} from '../../book/dto/book-taxonomy-response.dto';
import { BookCardsPaginationDto } from '../../book/dto/paged-book-cards.dto';
import { SeoResponseDto } from '../../seo/dto/seo-response.dto';

/**
 * Response DTO — Swagger only, no `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Describes `CategoryService.getByLangSlugWithBooks`, served by
 * `GET /:lang/categories/:slug/books`.
 */

/**
 * The matched `CategoryTranslation`, loaded with `include: { category: true, seo: true }`
 * and handed out as-is except for the back-relation.
 *
 * ⚠️ The handler strips the back-relation by destructuring it away
 * (`CategoryService.getByLangSlugWithBooks`), so `category` never reaches the wire and is
 * not documented here. A schema field a client can never observe is as misleading as a
 * missing one.
 */
export class PublicCategoryTranslationDto extends CategoryTranslationScalarsDto {
  @ApiPropertyOptional({ type: SeoResponseDto, nullable: true })
  seo!: SeoResponseDto | null;
}

/** The `category` envelope: the `Category` row plus the resolved translation. */
export class PublicCategoryInfoDto extends BookCategoryDto {
  @ApiPropertyOptional({ type: PublicCategoryTranslationDto, nullable: true })
  translation!: PublicCategoryTranslationDto | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Description of the resolved translation, lifted for convenience',
  })
  description!: string | null;

  @ApiProperty({ enum: Language, description: 'Path language the page was resolved for' })
  language!: Language;
}

/**
 * A published version attached to a listed book: the `PUBLIC_BOOK_VERSION_SELECT`
 * whitelist plus the tag join rows the same `select` asks for.
 */
export class PublicCategoryBookVersionDto extends PublicBookVersionDto {
  @ApiProperty({ type: BookVersionTagLinkDto, isArray: true })
  tags!: BookVersionTagLinkDto[];
}

/** One book of the category page: `PUBLIC_BOOK_SELECT` columns, its published versions and the average rating. */
export class PublicCategoryBookDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: PublicCategoryBookVersionDto, isArray: true })
  versions!: PublicCategoryBookVersionDto[];

  @ApiPropertyOptional({ type: Number, description: 'Average rating (0-5)', nullable: true })
  rating!: number | null;
}

/**
 * Response of `GET /:lang/categories/:slug/books`.
 *
 * ⚠️ `meta` is fixed at `page: 1, limit: 100` — the handler does not paginate; the
 * envelope exists so the shape matches the neighbouring list routes.
 */
export class PublicCategoryBooksResponseDto {
  @ApiProperty({ type: PublicCategoryInfoDto })
  category!: PublicCategoryInfoDto;

  @ApiPropertyOptional({ type: SeoResponseDto, nullable: true })
  seo!: SeoResponseDto | null;

  @ApiProperty({ type: PublicCategoryBookDto, isArray: true })
  data!: PublicCategoryBookDto[];

  @ApiProperty({ type: BookCardsPaginationDto })
  meta!: BookCardsPaginationDto;

  @ApiProperty({ enum: Language, isArray: true })
  availableLanguages!: Language[];
}
