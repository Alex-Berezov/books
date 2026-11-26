import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Language, WorldEntityType } from '@prisma/client';
import {
  BOOK_ANALYSIS_ROLES,
  BookAnalysisFaqDto,
  BookAnalysisSourceDto,
  type BookAnalysisRole,
} from '../../book-analysis/dto/book-analysis-blocks.dto';
import {
  BookWorldAdaptationDto,
  BookWorldArcDto,
  BookWorldCompareDto,
  BookWorldChapterExclusionDto,
  BookWorldProfileDto,
  BookWorldQuoteDto,
  BookWorldRelationDto,
  BookWorldSceneDto,
  WORLD_PLACE_KINDS,
  type WorldPlaceKind,
} from './book-world-blocks.dto';
import { WORLD_GEO_REASONS, type WorldGeoReason } from '../world-geo';

/** Проверенная точка реального места (`F08-12a`): координаты из Wikidata P625 и ссылка на источник. */
export class BookWorldPointDto {
  @ApiProperty({ type: Number, minimum: -90, maximum: 90 })
  lat!: number;

  @ApiProperty({ type: Number, minimum: -180, maximum: 180 })
  lng!: number;

  @ApiProperty({ type: String, description: 'Wikidata item page the coordinates come from' })
  sourceUrl!: string;
}

/** Итог проверки точки места — только редактору (`F08-12a`). */
export class BookWorldGeoCheckDto {
  @ApiProperty({ type: String, description: 'Wikidata item that was checked' })
  wikidataId!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the current check ran; null — there is no check for the current wikidataId and names (reason unavailable)',
  })
  checkedAt!: string | null;

  @ApiProperty({
    enum: WORLD_GEO_REASONS,
    nullable: true,
    description:
      'Why there is no point: not_found, no_coordinates (no P625), not_earth, out_of_range, ' +
      'name_mismatch (no Wikidata label or alias in the version language equals the name or a name form), ' +
      'unavailable (no check for the current wikidataId and names: Wikidata did not answer or the check has not run; checked again on the next save); null — the point is set',
  })
  reason!: WorldGeoReason | null;
}

/**
 * Response DTO — только Swagger (`STYLE_GUIDE.md` §7). Один тип ответа на редактора и читателя
 * (`tech.md` §3, риск R3): служебное — только в `editor`, которого у читателя нет вовсе.
 */
export class BookWorldEditorDto {
  @ApiProperty({
    type: Boolean,
    description:
      'The entity is public apart from the version: core, read after the model text, visible ' +
      '(computeWorldListed); a pair also needs both its characters listed (F08-8c); ' +
      'the page exists when the version is also published with a slug',
  })
  isListed!: boolean;

  @ApiProperty({ type: Boolean })
  isVisible!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  autoTextAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'First time on the site; after it the entity cannot be deleted',
  })
  firstPublishedAt!: Date | null;

  @ApiProperty({
    type: [String],
    description: 'Core parts still missing (world-core.ts), e.g. "quotes", "mentions"',
  })
  missing!: string[];

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Chapters the entity is found in (F08-2); null — not counted yet',
  })
  mentionChapters!: number | null;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description: 'Entity page only: name forms excluded from mention search (F08-2)',
  })
  aliasExclusions?: string[] | null;

  @ApiPropertyOptional({
    type: [BookWorldChapterExclusionDto],
    nullable: true,
    description: 'Entity page only: chapters where a name form is not counted (F08-8a)',
  })
  aliasChapterExclusions?: BookWorldChapterExclusionDto[] | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Entity page only: items that no longer match the text of the version on the last recount, ' +
      'e.g. "quotes.2" (not verbatim or no such chapter), "scenes.0", "arc.stages.1" (no such chapter); ' +
      'not counted in the core and not shown to readers',
  })
  stale?: string[];

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Entity page only: when the counted mentions last changed; not a freshness mark — a recount that changes nothing does not move it (use recountPending)',
  })
  mentionsAt?: Date | null;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Entity page only: a presence recount is queued for the version and has not run yet (F08-2)',
  })
  recountPending?: boolean;

  @ApiPropertyOptional({
    type: BookWorldGeoCheckDto,
    nullable: true,
    description:
      'Entity page of a place only (F08-12a): Wikidata coordinate check for the current wikidataId and names ' +
      '(the same rule as point); null — a fictional place, a place without wikidataId, or not a place',
  })
  geo?: BookWorldGeoCheckDto | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Entity page only: illustration brief of this version (English, with the book title and author; ' +
      'a character 1:1 by Appearance F08-11d-2, a place 16:9 by Description F08-12b); null — not written. ' +
      'Never in the public entity',
  })
  imageBrief?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Entity page only: the brief was written for another Appearance (a character) or Description ' +
      '(a place, F08-12b) or before the check existed (F08-11d-2) — regenerate it; false when there is no brief',
  })
  imageBriefStale?: boolean;
}

export class BookWorldEntitySummaryDto {
  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ enum: WorldEntityType, enumName: 'WorldEntityType' })
  type!: WorldEntityType;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ enum: BOOK_ANALYSIS_ROLES, nullable: true })
  role!: BookAnalysisRole | null;

  @ApiProperty({ type: String, nullable: true })
  short!: string | null;

  @ApiProperty({ type: Boolean, description: 'Core of the entity is filled (product.md §3)' })
  hasCore!: boolean;

  @ApiProperty({ type: Boolean })
  isIndexable!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'First chapter the entity is found in (F08-2 count); null — not counted yet or not found',
  })
  mentionFirst!: number | null;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({
    type: BookWorldEditorDto,
    description: 'Editors only; absent for readers',
  })
  editor?: BookWorldEditorDto;
}

/** Язык кластера hreflang мира книги и слаг версии этого языка (F08-3a). */
export class WorldAlternateDto {
  @ApiProperty({ enum: Language, enumName: 'Language' })
  language!: Language;

  @ApiProperty({ type: String, description: 'Version slug' })
  slug!: string;
}

/** Строка списка мира: сводка и, читателю, формы имени для перелинковки (`F08-5`). Только в списке. */
export class BookWorldListEntityDto extends BookWorldEntitySummaryDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Readers only: name forms for site cross-links (F08-5) — name and aliases as written, without excluded forms, forms shorter than 3 letters and repeats; absent for editors and on the entity page',
  })
  forms?: string[];
}

/** Сцена места на общей странице: без текста сцены, только ссылка на главу (`F08-12a`, Q4). */
export class BookWorldPlaceSceneDto extends PickType(BookWorldSceneDto, [
  'title',
  'chapter',
] as const) {
  // Абзац в карточке есть всегда (`toPlaceCard`), в отличие от входа сцены, где он необязателен.
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    description: 'First paragraph with a name form in the chapter (F08-10a); null — none',
  })
  paragraph!: number | null;
}

/**
 * Место на общей странице `/wiki` — текстовым списком и точкой карты (`F08-12a`, решение арбитра
 * `F08 | F08-12` Q4): и место без своей страницы, карточкой без адреса.
 */
export class BookWorldPlaceCardDto {
  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  short!: string | null;

  @ApiProperty({ enum: WORLD_PLACE_KINDS, nullable: true })
  kind!: WorldPlaceKind | null;

  @ApiProperty({ type: String, nullable: true, description: 'Where the place is, as text' })
  location!: string | null;

  @ApiProperty({
    type: Boolean,
    description:
      'The place has its own page /wiki/{key} (core, read, visible); otherwise a card without a link',
  })
  hasPage!: boolean;

  @ApiProperty({
    type: BookWorldPointDto,
    nullable: true,
    description: 'Map point: a real place with Wikidata-checked coordinates only; otherwise null',
  })
  point!: BookWorldPointDto | null;

  @ApiProperty({
    type: [BookWorldPlaceSceneDto],
    description: 'Scenes with chapters, stale ones left out',
  })
  scenes!: BookWorldPlaceSceneDto[];
}

export class BookWorldListResponseDto {
  @ApiProperty({ enum: Language, description: 'Language of the version' })
  language!: Language;

  @ApiProperty({
    type: [WorldAlternateDto],
    description:
      'hreflang cluster of this page (same rule as GET /:lang/world/sitemap): languages of the book where the page ' +
      'exists on a published version with a slug and without editorial noindex, this version first; empty when ' +
      'the page is not indexable (entity isIndexable=false, editorial noindex, draft)',
  })
  alternates!: WorldAlternateDto[];

  @ApiProperty({
    type: [BookWorldListEntityDto],
    description: 'Readers: public entities only; editors: every entity of the version',
  })
  entities!: BookWorldListEntityDto[];

  @ApiProperty({
    type: [BookWorldPlaceCardDto],
    description:
      'Places shown on the world page (F08-12a, public since F08-12c): visible, read after the model ' +
      'text; with or without their own page. Same set for editors',
  })
  places!: BookWorldPlaceCardDto[];
}

export class BookWorldChapterCountDto {
  @ApiProperty({ type: Number })
  chapter!: number;

  @ApiProperty({ type: Number, description: 'Mentions of any name form in the chapter' })
  count!: number;
}

export class BookWorldCoPresenceDto {
  @ApiProperty({ type: String, description: 'Key of the other character' })
  key!: string;

  @ApiProperty({ type: [Number], description: 'Chapters where both are found, ascending' })
  chapters!: number[];
}

/**
 * Посчитанное присутствие по главам (`F08-2`, `world-mentions.ts`). Наружу — только эти поля
 * (белый список `readMentions`): номера абзацев и несошедшиеся пункты хранятся, но не отдаются.
 */
export class BookWorldMentionsDto {
  @ApiProperty({
    type: [Number],
    description:
      'Chapters the entity is found in, ascending; for a pair (F08-8c) — chapters where both characters are found',
  })
  chapters!: number[];

  @ApiProperty({ type: Number, nullable: true, description: 'First chapter it is found in' })
  first!: number | null;

  @ApiProperty({
    type: () => [BookWorldChapterCountDto],
    description: 'Mentions per chapter, ascending by chapter',
  })
  perChapter!: BookWorldChapterCountDto[];

  @ApiProperty({
    type: () => [BookWorldCoPresenceDto],
    description:
      'Characters only: other characters found in the same chapters; readers see public neighbours only',
  })
  coPresence!: BookWorldCoPresenceDto[];
}

export class BookWorldEntityDto extends BookWorldEntitySummaryDto {
  @ApiProperty({ type: [String], nullable: true })
  aliases!: string[] | null;

  @ApiProperty({ type: BookWorldProfileDto, nullable: true })
  profile!: BookWorldProfileDto | null;

  @ApiProperty({ type: String, nullable: true })
  appearance!: string | null;

  @ApiProperty({ type: String, nullable: true })
  character!: string | null;

  @ApiProperty({ type: BookWorldArcDto, nullable: true })
  arc!: BookWorldArcDto | null;

  @ApiProperty({ type: [BookWorldSceneDto], nullable: true })
  scenes!: BookWorldSceneDto[] | null;

  @ApiProperty({ type: [BookWorldRelationDto], nullable: true })
  relations!: BookWorldRelationDto[] | null;

  @ApiProperty({ type: [BookWorldQuoteDto], nullable: true })
  quotes!: BookWorldQuoteDto[] | null;

  @ApiProperty({ type: String, nullable: true })
  critique!: string | null;

  @ApiProperty({ type: String, nullable: true })
  prototypes!: string | null;

  @ApiProperty({ type: [BookWorldAdaptationDto], nullable: true })
  adaptations!: BookWorldAdaptationDto[] | null;

  @ApiProperty({ type: [BookWorldCompareDto], nullable: true, description: 'Pairs only (F08-8c)' })
  compare!: BookWorldCompareDto[] | null;

  @ApiProperty({ type: String, nullable: true, description: 'Pairs only (F08-8c)' })
  bonds!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Pairs only (F08-8c)' })
  differences!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Pairs only (F08-8c)' })
  conclusion!: string | null;

  @ApiProperty({ enum: WORLD_PLACE_KINDS, nullable: true, description: 'Places only (F08-12a)' })
  kind!: WorldPlaceKind | null;

  @ApiProperty({ type: String, nullable: true, description: 'Places only (F08-12a)' })
  location!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Places only (F08-12a)' })
  significance!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Places only (F08-12a)' })
  description!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Places only (F08-12a): Wikidata item of a real place',
  })
  wikidataId!: string | null;

  @ApiProperty({ type: [BookAnalysisFaqDto], nullable: true })
  faq!: BookAnalysisFaqDto[] | null;

  @ApiProperty({ type: [BookAnalysisSourceDto], nullable: true })
  sources!: BookAnalysisSourceDto[] | null;

  @ApiProperty({ type: BookWorldMentionsDto, nullable: true })
  mentions!: BookWorldMentionsDto | null;

  @ApiProperty({
    type: BookWorldPointDto,
    nullable: true,
    description:
      'Places only (F08-12a): Wikidata-checked point of a real place for its current wikidataId; otherwise null',
  })
  point!: BookWorldPointDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/**
 * Принятая иллюстрация сущности (`F08-11a`): одна на книгу и ключ, общая для всех языков. Подпись
 * и `alt` собирает страница по языку; непринятая (ожидающая) картинка сюда не попадает никогда.
 */
export class BookWorldImageDto {
  @ApiProperty({ type: String, description: 'Absolute public URL of the original file' })
  url!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Pixels, from the file header' })
  width!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Pixels, from the file header' })
  height!: number | null;
}

export class BookWorldEntityResponseDto {
  @ApiProperty({ enum: Language, description: 'Language of the version' })
  language!: Language;

  @ApiProperty({
    type: [Number],
    description:
      'Chapter numbers of the version, ascending; chapter links are rendered only for these (empty without text)',
  })
  chapterNumbers!: number[];

  @ApiProperty({ type: BookWorldEntityDto })
  entity!: BookWorldEntityDto;

  @ApiProperty({
    type: [WorldAlternateDto],
    description:
      'hreflang cluster of this page (same rule as GET /:lang/world/sitemap): languages of the book where the page ' +
      'exists on a published version with a slug and without editorial noindex, this version first; empty when ' +
      'the page is not indexable (entity isIndexable=false, editorial noindex, draft)',
  })
  alternates!: WorldAlternateDto[];

  @ApiProperty({
    type: BookWorldImageDto,
    nullable: true,
    description:
      'Accepted illustration of the entity (one per book, key and entity type, all languages; F08-11a, F08-12c-2): ' +
      'a character main/secondary or a place; null when there is none, the row belongs to another entity type ' +
      'or it is not accepted yet - a generated image waiting for acceptance is never here, editors included',
  })
  image!: BookWorldImageDto | null;
}

export const BOOK_WORLD_WARNING_CODES = ['core_incomplete'] as const;
export type BookWorldWarningCode = (typeof BOOK_WORLD_WARNING_CODES)[number];

/** Предупреждение записи: сущность сохранена (или сохранится), но страницы у неё не будет. */
export class BookWorldWarningDto {
  @ApiProperty({ enum: BOOK_WORLD_WARNING_CODES })
  code!: BookWorldWarningCode;

  @ApiProperty({
    type: String,
    description: 'Field path, e.g. "entities.0.quotes" or "mentions"',
  })
  path!: string;

  @ApiProperty({ type: String })
  message!: string;
}

export class BookWorldSavedEntityDto {
  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: Boolean, description: 'The entity did not exist before this save' })
  created!: boolean;

  @ApiProperty({ type: Boolean, description: 'Core of the merged entity' })
  hasCore!: boolean;

  @ApiProperty({ type: [BookWorldWarningDto] })
  warnings!: BookWorldWarningDto[];
}

export class BookWorldSaveResponseDto {
  @ApiProperty({
    type: BookWorldListResponseDto,
    nullable: true,
    description: 'Every entity of the version after the save; null on dryRun (nothing is written)',
  })
  world!: BookWorldListResponseDto | null;

  @ApiProperty({
    type: [BookWorldSavedEntityDto],
    description: 'Entities of the body, in body order',
  })
  entities!: BookWorldSavedEntityDto[];
}

export class BookWorldEntitySaveResponseDto {
  @ApiProperty({
    type: BookWorldEntityDto,
    nullable: true,
    description: 'Saved entity; null on dryRun (nothing is written)',
  })
  entity!: BookWorldEntityDto | null;

  @ApiProperty({ type: Boolean, description: 'Core of the merged entity' })
  hasCore!: boolean;

  @ApiProperty({ type: [BookWorldWarningDto] })
  warnings!: BookWorldWarningDto[];

  @ApiProperty({
    type: Boolean,
    description:
      'The save queued a presence recount (a new entity, or its search forms — name, name forms and exclusions together — or type changed); false on dryRun',
  })
  recountQueued!: boolean;
}
