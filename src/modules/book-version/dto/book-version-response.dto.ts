import { ApiProperty } from '@nestjs/swagger';
import { FaqItemDto } from '../../../shared/dto/faq-item.dto';
import {
  BookVersionCharacterDto,
  BookVersionQuoteDto,
  BookVersionSymbolDto,
} from '../../../shared/dto/book-version-json.dto';
import { Language, BookType, PublicationStatus } from '@prisma/client';
import { SeoResponseDto } from '../../seo/dto/seo-response.dto';
import {
  BookCategoryDto,
  BookTagDto,
  PublicBookVersionDto,
} from '../../book/dto/book-detail-response.dto';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * `seo` в списке версий книги отбирается не целиком, а только двумя полями
 * (`book-version.service.ts`, `list()`: `seo: { select: { metaTitle: true, metaDescription: true } }`),
 * поэтому это не `SeoResponseDto`, а отдельная урезанная форма.
 */
export class SeoMetaSummaryDto {
  @ApiProperty({ type: String, nullable: true })
  metaTitle!: string | null;

  @ApiProperty({ type: String, nullable: true })
  metaDescription!: string | null;
}

/**
 * `BookVersion` целиком, как её отдают `create`/`createAdmin`/`update`/`remove`/
 * `publish`/`unpublish` и (массивом) `listAdmin` в `book-version.service.ts` — без `select`,
 * то есть все скалярные поля модели (`prisma/schema.prisma`, `model BookVersion`) плюс
 * связанная `seo` (`include: { seo: true }`).
 *
 * ⚠️ Это внутренняя/админская форма — включает весь правовой контур (`rights*`).
 * Для публичной выдачи используется `PublicBookVersionDto`
 * (`book/dto/book-detail-response.dto.ts`, `PUBLIC_BOOK_VERSION_SELECT`), а не эта DTO.
 */
export class BookVersionResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookId!: string;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  author!: string;

  @ApiProperty({ type: String })
  description!: string;

  @ApiProperty({ type: String })
  coverImageUrl!: string;

  @ApiProperty({ enum: BookType })
  type!: BookType;

  @ApiProperty({ type: Boolean })
  isFree!: boolean;

  @ApiProperty({ type: String, nullable: true })
  referralUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;

  @ApiProperty({ enum: PublicationStatus })
  status!: PublicationStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: Number, nullable: true })
  seoId!: number | null;

  @ApiProperty({ type: String, nullable: true })
  previewMediaId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  primaryCategoryId!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  firstPublishedYear!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  editionPublishedYear!: number | null;

  @ApiProperty({ type: String, nullable: true })
  originalLanguage!: string | null;

  @ApiProperty({ type: String, nullable: true })
  copyrightStatus!: string | null;

  @ApiProperty({ type: String, nullable: true })
  authorPageUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  authorId!: string | null;

  @ApiProperty({
    type: [BookVersionCharacterDto],
    nullable: true,
    description: 'Персонажи книги (Json-колонка; форма задана CreateBookVersionDto.characters)',
  })
  characters!: BookVersionCharacterDto[] | null;

  @ApiProperty({
    type: [BookVersionQuoteDto],
    nullable: true,
    description: 'Цитаты из книги (Json-колонка; форма задана CreateBookVersionDto.quotes)',
  })
  quotes!: BookVersionQuoteDto[] | null;

  @ApiProperty({
    type: [FaqItemDto],
    nullable: true,
    description: 'FAQ по книге (Json-колонка; форма задана CreateBookVersionDto.faq)',
  })
  faq!: FaqItemDto[] | null;

  @ApiProperty({
    type: [String],
    nullable: true,
    description: 'Темы книги (Json-колонка: массив строк)',
  })
  themes!: string[] | null;

  @ApiProperty({ type: String, nullable: true })
  originalTitle!: string | null;

  @ApiProperty({
    type: [String],
    nullable: true,
    description: 'Альтернативные названия книги (Json-колонка: массив строк)',
  })
  alternativeTitles!: string[] | null;

  @ApiProperty({ type: String, nullable: true })
  shortDescription!: string | null;

  @ApiProperty({ type: String, nullable: true })
  summaryShort!: string | null;

  @ApiProperty({
    type: [BookVersionSymbolDto],
    nullable: true,
    description: 'Символы в книге (Json-колонка; форма задана CreateBookVersionDto.symbols)',
  })
  symbols!: BookVersionSymbolDto[] | null;

  @ApiProperty({ type: String, nullable: true })
  coverAlt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvedRightsReviewId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsStatus!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Разрешённые страны клиренса (Json в базе, произвольная форма)',
  })
  rightsAllowedCountryCodes!: unknown;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Заблокированные страны клиренса (Json в базе, произвольная форма)',
  })
  rightsBlockedCountryCodes!: unknown;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Страны, требующие лицензии (Json в базе, произвольная форма)',
  })
  rightsLicenseRequiredCountryCodes!: unknown;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Страны с ожидающей проверкой (Json в базе, произвольная форма)',
  })
  rightsPendingCountryCodes!: unknown;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Требуемые правовые действия (Json в базе, произвольная форма)',
  })
  rightsRequiredActions!: unknown;

  @ApiProperty({ type: Boolean })
  rightsGeoBlockRequired!: boolean;

  @ApiProperty({ type: Boolean })
  rightsGeoBlockConfigured!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rightsGeoBlockConfiguredAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  rightsGeoBlockNotesRu!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rightsGeoBlockVerifiedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  rightsGeoBlockVerifiedByUserId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rightsGeoBlockLastGeneratedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  rightsContentHash!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsContentHashAlgorithmVersion!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Снимок содержимого для расчёта content hash (Json в базе, произвольная форма)',
  })
  rightsContentHashInput!: unknown;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rightsContentHashCalculatedAt!: Date | null;

  @ApiProperty({ type: Boolean })
  rightsRecheckRequired!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rightsStaleDetectedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  rightsStaleReasonCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsStaleReasonRu!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Идентификаторы лицензий, покрывающих версию (Json в базе, произвольная форма)',
  })
  rightsLicenseIds!: unknown;

  @ApiProperty({ type: String, nullable: true })
  rightsLicenseCoverageStatus!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rightsLicenseCheckedAt!: Date | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Страны без лицензионного покрытия (Json в базе, произвольная форма)',
  })
  rightsLicenseUncoveredCountryCodes!: unknown;

  @ApiProperty({ type: String, nullable: true })
  rightsLicenseAttributionTextRu!: string | null;

  @ApiProperty({ type: Boolean })
  rightsClaimBlockActive!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rightsClaimBlockAppliedAt!: Date | null;

  @ApiProperty({ type: SeoResponseDto, nullable: true })
  seo!: SeoResponseDto | null;
}

/**
 * `book` в ответе `GET /admin/versions/:id` (`book-version.service.ts`, `getAdmin()`) —
 * подмножество полей `Book`, добавленное `include: { book: { select: {...} } }`.
 */
export class BookVersionAdminBookSummaryDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String, nullable: true })
  rightsIntakeId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  currentRightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvedRightsReviewId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rightsCreatedAt!: Date | null;
}

/**
 * Ответ `GET /admin/versions/:id` (`getAdmin()`): `BookVersionResponseDto` плюс `bookSlug`
 * и вложенные `book`/`categories`/`tags`, которые метод добавляет сверх модели.
 */
export class BookVersionAdminDetailResponseDto extends BookVersionResponseDto {
  @ApiProperty({ type: String })
  bookSlug!: string;

  @ApiProperty({ type: BookVersionAdminBookSummaryDto })
  book!: BookVersionAdminBookSummaryDto;

  @ApiProperty({ type: [BookCategoryDto] })
  categories!: BookCategoryDto[];

  @ApiProperty({ type: [BookTagDto] })
  tags!: BookTagDto[];
}

/**
 * Ответ `GET /books/:bookId/versions` (`list()`): `PUBLIC_BOOK_VERSION_SELECT` плюс `seo`,
 * отобранная только метатегами (`select: { metaTitle: true, metaDescription: true }`).
 */
export class PublicBookVersionListItemDto extends PublicBookVersionDto {
  @ApiProperty({ type: SeoMetaSummaryDto, nullable: true })
  seo!: SeoMetaSummaryDto | null;
}

/**
 * Ответ `GET /versions/:id` (`getPublic()`/`get()`): `PUBLIC_BOOK_VERSION_SELECT` плюс
 * полная `seo` (`seo: true`) и категории/теги, приведённые к голым записям
 * `Category`/`Tag` (`categories.map(c => c.category)`, `tags.map(t => t.tag)`).
 */
export class PublicBookVersionDetailResponseDto extends PublicBookVersionDto {
  @ApiProperty({ type: SeoResponseDto, nullable: true })
  seo!: SeoResponseDto | null;

  @ApiProperty({ type: [BookCategoryDto] })
  categories!: BookCategoryDto[];

  @ApiProperty({ type: [BookTagDto] })
  tags!: BookTagDto[];
}
