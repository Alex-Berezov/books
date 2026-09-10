import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PublicationStatus, Language } from '@prisma/client';

export class SeoResponse {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'SEO Title' })
  metaTitle!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'SEO Description' })
  metaDescription!: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'https://example.com/page',
  })
  canonicalUrl!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'index, follow' })
  robots!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'OG Title' })
  ogTitle!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'OG Description' })
  ogDescription!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'website' })
  ogType!: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'https://example.com/page',
  })
  ogUrl!: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'https://example.com/image.jpg',
  })
  ogImageUrl!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'Image alt text' })
  ogImageAlt!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'summary_large_image' })
  twitterCard!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: '@site' })
  twitterSite!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: '@creator' })
  twitterCreator!: string | null;

  // Событийная разметка Schema.org: связь `seo` выбирается целиком (pages.service.ts,
  // `include: { seo: true }`), и эти двенадцать полей ответ содержал, а схема - нет.
  @ApiProperty({ type: String, required: false, nullable: true, example: 'Book fair' })
  eventName!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'Annual book fair' })
  eventDescription!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    nullable: true,
    example: '2026-05-01T10:00:00.000Z',
  })
  eventStartDate!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    nullable: true,
    example: '2026-05-03T18:00:00.000Z',
  })
  eventEndDate!: Date | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'https://example.com/fair',
  })
  eventUrl!: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'https://example.com/fair.jpg',
  })
  eventImageUrl!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'City Library' })
  eventLocationName!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: '1 Main St' })
  eventLocationStreet!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'Lisbon' })
  eventLocationCity!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'Lisboa' })
  eventLocationRegion!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: '1000-001' })
  eventLocationPostal!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'PT' })
  eventLocationCountry!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z' })
  updatedAt!: Date;
}

export class PageTranslation {
  @ApiProperty({ example: 'uuid-here' })
  id!: string;

  @ApiProperty({ enum: Object.values(Language), example: 'fr' })
  language!: Language;

  @ApiProperty({ example: 'a-propos' })
  slug!: string;

  @ApiProperty({ example: 'À propos' })
  title!: string;
}

export class PageResponse {
  @ApiProperty({ example: 'uuid-here' })
  id!: string;

  @ApiProperty({ example: 'about-us' })
  slug!: string;

  @ApiProperty({ example: 'About Us' })
  title!: string;

  @ApiProperty({ enum: ['generic', 'category_index', 'author_index', 'homepage'] })
  type!: 'generic' | 'category_index' | 'author_index' | 'homepage';

  @ApiProperty({ example: 'Page content here...' })
  content!: string;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'Browse Book Categories' })
  h1!: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'Explore book categories on Bibliaris.',
  })
  shortDescription!: string | null;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: { question: { type: 'string' }, answer: { type: 'string' } },
    },
    required: false,
    nullable: true,
    description: 'FAQ structured data as JSON array. Shape declared by `CreatePageDto.faq`.',
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  faq?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'Homepage sections configuration (JSON object with block data). Free-form by design: `CreatePageDto.sections` is `Record<string, unknown>` with no per-key validation, and the front reads it as the same type.',
  })
  sections?: Record<string, unknown> | null;

  @ApiProperty({ enum: Object.values(Language), example: 'en' })
  language!: Language;

  @ApiProperty({ enum: Object.values(PublicationStatus), example: 'draft' })
  status!: PublicationStatus;

  @ApiProperty({ type: Number, required: false, nullable: true, example: 1 })
  seoId!: number | null;

  @ApiProperty({ required: false, nullable: true, type: SeoResponse })
  seo!: SeoResponse | null;

  @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z' })
  updatedAt!: Date;

  @ApiProperty({ type: String, required: false, nullable: true, example: 'uuid-group' })
  translationGroupId!: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'privacy',
    description:
      'Системный ключ страницы: по нему страницу зовут по адресу /pages/by-key/{systemKey}',
  })
  systemKey!: string | null;
}

/**
 * Ответ `GET /admin/pages/:id` и только его. `translations` добавляет одна-единственная
 * ветка - `PagesService.findById` вторым запросом по `translationGroupId`; остальные методы
 * модуля возвращают строку `Page` с `include: { seo: true }` и языковых близнецов не грузят.
 *
 * Поэтому поле живёт в наследнике, а не в `PageResponse`: пока оно стояло в базовом классе,
 * схема была **богаче** ответа, и фронт по сгенерированному типу читал `page.translations`
 * у публичной страницы - код собирался, значение всегда было `undefined`. Сторож
 * `check-response-schema.mjs` такое не ловит по устройству: он ищет обратное - поле ответа,
 * которого нет в схеме.
 */
export class PageWithTranslationsResponse extends PageResponse {
  @ApiProperty({
    type: [PageTranslation],
    description: 'Языковые версии страницы из той же группы перевода; пустой массив, если их нет',
  })
  translations!: PageTranslation[];
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
