import { ApiProperty } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { AuthorFaqDto, AuthorQuoteDto } from './author-translation.dto';

/**
 * Форма `Seo`, как она реально приезжает вложенной в перевод автора
 * (`author.service.ts`: `create`/`update` читают её через
 * `include: { translations: { include: { seo: true } } }`). Полный набор
 * колонок модели `Seo` (`prisma/schema.prisma:559-616`), без связей —
 * `include: { seo: true }` их не подтягивает. Response DTO — только Swagger,
 * `class-validator` не нужен (`STYLE_GUIDE.md` §7).
 */
export class AuthorTranslationSeoResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ nullable: true, type: String })
  metaTitle!: string | null;

  @ApiProperty({ nullable: true, type: String })
  metaDescription!: string | null;

  @ApiProperty({ nullable: true, type: String })
  canonicalUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  robots!: string | null;

  @ApiProperty({ nullable: true, type: String })
  ogTitle!: string | null;

  @ApiProperty({ nullable: true, type: String })
  ogDescription!: string | null;

  @ApiProperty({ nullable: true, type: String })
  ogType!: string | null;

  @ApiProperty({ nullable: true, type: String })
  ogUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  ogImageUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  ogImageAlt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  twitterCard!: string | null;

  @ApiProperty({ nullable: true, type: String })
  twitterSite!: string | null;

  @ApiProperty({ nullable: true, type: String })
  twitterCreator!: string | null;

  @ApiProperty({ nullable: true, type: String })
  eventName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  eventDescription!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  eventStartDate!: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  eventEndDate!: Date | null;

  @ApiProperty({ nullable: true, type: String })
  eventUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  eventImageUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  eventLocationName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  eventLocationStreet!: string | null;

  @ApiProperty({ nullable: true, type: String })
  eventLocationCity!: string | null;

  @ApiProperty({ nullable: true, type: String })
  eventLocationRegion!: string | null;

  @ApiProperty({ nullable: true, type: String })
  eventLocationPostal!: string | null;

  @ApiProperty({ nullable: true, type: String })
  eventLocationCountry!: string | null;
}

/**
 * Форма `AuthorTranslation`, как её реально возвращают `AuthorService.create`
 * и `.update` (`author.service.ts:577-616`, `:752-759`) — колонки модели
 * (`prisma/schema.prisma:632-658`) плюс вложенный `seo`. `quotes`/`faq`/
 * `similarSlugs` — колонки `Json?`, но пишутся и читаются только в форме
 * `AuthorQuoteDto[]`/`AuthorFaqDto[]`/`string[]`, той же, что и на входе
 * (`AuthorTranslationDto` в `author-translation.dto.ts`).
 */
export class AuthorTranslationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  authorId!: string;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  biography!: string | null;

  @ApiProperty({ nullable: true, type: String })
  wikidataUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  wikipediaUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  photoUrl!: string | null;

  @ApiProperty({ nullable: true, type: [AuthorQuoteDto] })
  quotes!: AuthorQuoteDto[] | null;

  @ApiProperty({ nullable: true, type: [AuthorFaqDto] })
  faq!: AuthorFaqDto[] | null;

  @ApiProperty({ nullable: true, type: [String] })
  similarSlugs!: string[] | null;

  @ApiProperty({ nullable: true, type: Number })
  seoId!: number | null;

  @ApiProperty({ nullable: true, type: AuthorTranslationSeoResponseDto })
  seo!: AuthorTranslationSeoResponseDto | null;
}

/**
 * Форма `Author` без переводов — то, что реально отдаёт `AuthorService.delete`
 * (`author.service.ts:766-772`, `prisma.author.delete` без `include`), то есть
 * только колонки модели `Author` (`prisma/schema.prisma:616-630`).
 */
export class AuthorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ nullable: true, type: String, example: '1854-10-16' })
  birthDate!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '1900-11-30' })
  deathDate!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  personId!: string | null;
}

/**
 * Форма ответа `POST /admin/authors` и `PUT /admin/authors/:id`
 * (`AuthorController.create`/`.update`, `author.controller.ts:65-94`) —
 * `Author` вместе с переводами, как их возвращает
 * `include: { translations: { include: { seo: true } } }`.
 */
export class AuthorResponseDto extends AuthorDto {
  @ApiProperty({ type: AuthorTranslationResponseDto, isArray: true })
  translations!: AuthorTranslationResponseDto[];
}

/**
 * Элемент админской выдачи автора — ровно то, что собирает
 * `AuthorService.toAuthorItem` (`author.service.ts:246-272`). Одна форма на два
 * маршрута: список `GET /admin/authors` и одиночное чтение
 * `GET /admin/authors/:id` — оба идут через этот же метод.
 *
 * ⚠️ Это НЕ `Author` целиком и не `AuthorResponseDto`: `createdAt`,
 * `updatedAt` и `personId` наружу здесь не уходят, зато добавлены поля
 * выбранного перевода (`slug`, `name`, `wikidataUrl`, `wikipediaUrl`,
 * `photoUrl`) и счётчик книг.
 *
 * `slug` и `name` — всегда строки: у автора без подходящего перевода метод
 * подставляет `''`, а не `null`.
 */
export class AdminAuthorItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Slug of the picked translation, empty string if there is none' })
  slug!: string;

  @ApiProperty({ description: 'Name of the picked translation, empty string if there is none' })
  name!: string;

  @ApiProperty({ nullable: true, type: String, example: '1854-10-16' })
  birthDate!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '1900-11-30' })
  deathDate!: string | null;

  @ApiProperty({ nullable: true, type: String })
  wikidataUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  wikipediaUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  photoUrl!: string | null;

  @ApiProperty({ type: AuthorTranslationResponseDto, isArray: true })
  translations!: AuthorTranslationResponseDto[];

  @ApiProperty({ description: 'Number of published books of this author' })
  booksCount!: number;
}

/**
 * Обёртка страницы админского списка авторов — форма `{ data, meta }`,
 * которую возвращает `AuthorService.list` (`author.service.ts:314-323`).
 */
export class AdminAuthorsListMetaDto {
  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

/** Ответ `GET /admin/authors` (`AuthorController.list`). */
export class AdminAuthorsListResponseDto {
  @ApiProperty({ type: AdminAuthorItemDto, isArray: true })
  data!: AdminAuthorItemDto[];

  @ApiProperty({ type: AdminAuthorsListMetaDto })
  meta!: AdminAuthorsListMetaDto;
}
