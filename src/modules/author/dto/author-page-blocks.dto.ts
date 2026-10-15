import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { applyDecorators } from '@nestjs/common';
import { IsAbsoluteHttpUrl } from '../../../shared/validators/absolute-http-url.decorator';
import { SLUG_REGEX, SLUG_REGEX_README } from '../../../shared/validators/slug';

/**
 * Блоки страницы автора (F02-2). Форма и лимиты — `books-app-docs/features/F02-author-page/tech.md` §2;
 * та же форма — JSON импорта и промпты (`tech.md` §3, T4). Фронт проверяет импорт той же схемой
 * (`books-front/lib/admin/author-page-blocks.schema.ts`), чтобы ошибка с путём показывалась до отправки.
 *
 * Строки обрезаются по краям; пустая строка у необязательного поля — «нет значения», у обязательного —
 * отказ. `null` у необязательного листового поля — тоже «нет значения» (`@IsOptional` пропускает `null`).
 */

export const AUTHOR_PAGE_LIMITS = {
  tagline: 140,
  nativeName: 200,
  text: 300,
  title: 300,
  facts: { item: 120, list: 20 },
  notableWorks: 7,
  startHere: { list: 5, reason: 220 },
  timeline: { list: 15, text: 200 },
  influences: 8,
  awards: 20,
  adaptations: 10,
  funFacts: { list: 5, text: 300 },
  sources: 10,
  // Цитат на странице 3–5 (промпт); предел держит число слагов книг страницы ниже
  // предохранителя разрешения (`AUTHOR_PAGE_REFS_MAX` в `author.service.ts`).
  quotes: 50,
  slug: 200,
  // Годы до нашей эры — отрицательные (античность); верхняя граница — предохранитель от опечатки.
  year: { min: -3000, max: 2100 },
} as const;

export const AUTHOR_ADAPTATION_KINDS = [
  'film',
  'series',
  'animation',
  'play',
  'opera',
  'other',
] as const;
export type AuthorAdaptationKind = (typeof AUTHOR_ADAPTATION_KINDS)[number];

export const AUTHOR_GENDERS = ['male', 'female'] as const;

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

const isAbsent = (value: unknown) => value === undefined || value === null || value === '';

/** Обязательная непустая строка с пределом длины. */
const RequiredText = (max: number) =>
  applyDecorators(trim(), IsString(), IsNotEmpty(), MaxLength(max));

/** Необязательная строка: `undefined`, `null` и `''` — «нет значения». */
const OptionalText = (max: number) =>
  applyDecorators(
    trim(),
    ValidateIf((_o, value) => !isAbsent(value)),
    IsString(),
    MaxLength(max),
  );

/** `''` и строка из пробелов — «нет значения»; числовая строка — число. Читает сырое значение. */
const yearFromRaw = () =>
  Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    const raw = obj[key];
    if (typeof raw === 'string') return raw.trim() === '' ? undefined : Number(raw);
    return raw;
  });

/**
 * Необязательный год. `''` и строка из пробелов — «нет значения», как у соседних строковых
 * полей: `@Type(() => Number)` сделал бы из них `0`, несуществующий год. `@Transform` читает
 * сырое значение из `obj`, потому что получает уже приведённое `@Type`.
 */
const OptionalYear = () =>
  applyDecorators(
    Type(() => Number),
    yearFromRaw(),
    IsOptional(),
    IsInt(),
    Min(AUTHOR_PAGE_LIMITS.year.min),
    Max(AUTHOR_PAGE_LIMITS.year.max),
  );

/** Слаг книги или автора на сайте — тем же форматом, что слаг записи (`SLUG_PATTERN`). */
const OptionalSlug = () =>
  applyDecorators(
    OptionalText(AUTHOR_PAGE_LIMITS.slug),
    ValidateIf((_o, value) => !isAbsent(value)),
    Matches(SLUG_REGEX, { message: SLUG_REGEX_README }),
  );

/** Список строк фактов: элементы — непустые строки с пределом. */
const FactList = () =>
  applyDecorators(
    IsOptional(),
    IsArray(),
    ArrayMaxSize(AUTHOR_PAGE_LIMITS.facts.list),
    Transform(({ value }: { value: unknown }) =>
      Array.isArray(value)
        ? (value as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : v))
        : value,
    ),
    IsString({ each: true }),
    IsNotEmpty({ each: true }),
    MaxLength(AUTHOR_PAGE_LIMITS.facts.item, { each: true }),
  );

export class AuthorPhotoCreditDto {
  @ApiProperty({ description: 'Author of the photo' })
  @RequiredText(AUTHOR_PAGE_LIMITS.title)
  author!: string;

  @ApiProperty({ description: 'License name, e.g. "CC BY-SA 4.0" or "Public domain"' })
  @RequiredText(AUTHOR_PAGE_LIMITS.title)
  license!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @trim()
  @ValidateIf((_o, value) => !isAbsent(value))
  @IsAbsoluteHttpUrl()
  licenseUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @trim()
  @ValidateIf((_o, value) => !isAbsent(value))
  @IsAbsoluteHttpUrl()
  sourceUrl?: string | null;
}

export class AuthorFactsDto {
  @ApiPropertyOptional({ enum: AUTHOR_GENDERS, nullable: true })
  @IsOptional()
  @IsIn(AUTHOR_GENDERS)
  gender?: (typeof AUTHOR_GENDERS)[number] | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(AUTHOR_PAGE_LIMITS.title)
  birthPlace?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(AUTHOR_PAGE_LIMITS.title)
  deathPlace?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(AUTHOR_PAGE_LIMITS.title)
  nationality?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @FactList()
  occupations?: string[];

  @ApiPropertyOptional({ type: [String] })
  @FactList()
  movements?: string[];

  @ApiPropertyOptional({ type: [String] })
  @FactList()
  genres?: string[];

  @ApiPropertyOptional({ type: [String] })
  @FactList()
  languages?: string[];

  @ApiPropertyOptional({ type: [String] })
  @FactList()
  pseudonyms?: string[];
}

export class AuthorNotableWorkDto {
  @ApiProperty()
  @RequiredText(AUTHOR_PAGE_LIMITS.title)
  title!: string;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @OptionalYear()
  year?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalSlug()
  bookSlug?: string | null;
}

export class AuthorStartHereDto {
  @ApiProperty()
  @RequiredText(AUTHOR_PAGE_LIMITS.slug)
  @Matches(SLUG_REGEX, { message: SLUG_REGEX_README })
  bookSlug!: string;

  @ApiProperty({ maxLength: AUTHOR_PAGE_LIMITS.startHere.reason })
  @RequiredText(AUTHOR_PAGE_LIMITS.startHere.reason)
  reason!: string;
}

export class AuthorTimelineEventDto {
  @ApiProperty({ type: Number })
  // Год обязателен: `''` — отказ, а не год 0.
  @Type(() => Number)
  @yearFromRaw()
  @IsInt()
  @Min(AUTHOR_PAGE_LIMITS.year.min)
  @Max(AUTHOR_PAGE_LIMITS.year.max)
  year!: number;

  @ApiProperty({ maxLength: AUTHOR_PAGE_LIMITS.timeline.text })
  @RequiredText(AUTHOR_PAGE_LIMITS.timeline.text)
  text!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalSlug()
  bookSlug?: string | null;
}

export class AuthorInfluenceRefDto {
  @ApiProperty()
  @RequiredText(AUTHOR_PAGE_LIMITS.title)
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalSlug()
  authorSlug?: string | null;
}

export class AuthorInfluencesDto {
  @ApiPropertyOptional({ type: [AuthorInfluenceRefDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHOR_PAGE_LIMITS.influences)
  @ValidateNested({ each: true })
  @Type(() => AuthorInfluenceRefDto)
  influencedBy?: AuthorInfluenceRefDto[];

  @ApiPropertyOptional({ type: [AuthorInfluenceRefDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHOR_PAGE_LIMITS.influences)
  @ValidateNested({ each: true })
  @Type(() => AuthorInfluenceRefDto)
  influenced?: AuthorInfluenceRefDto[];
}

export class AuthorAwardDto {
  @ApiProperty()
  @RequiredText(AUTHOR_PAGE_LIMITS.title)
  name!: string;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @OptionalYear()
  year?: number | null;

  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @IsBoolean()
  nomination?: boolean | null;
}

export class AuthorAdaptationDto {
  @ApiProperty()
  @RequiredText(AUTHOR_PAGE_LIMITS.title)
  title!: string;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @OptionalYear()
  year?: number | null;

  @ApiProperty({ enum: AUTHOR_ADAPTATION_KINDS })
  @IsIn(AUTHOR_ADAPTATION_KINDS)
  kind!: AuthorAdaptationKind;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalText(AUTHOR_PAGE_LIMITS.title)
  basedOn?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @OptionalSlug()
  bookSlug?: string | null;
}

export class AuthorFunFactDto {
  @ApiProperty({ maxLength: AUTHOR_PAGE_LIMITS.funFacts.text })
  @RequiredText(AUTHOR_PAGE_LIMITS.funFacts.text)
  text!: string;

  @ApiProperty({ description: 'Source title; a fact without a source is rejected' })
  @RequiredText(AUTHOR_PAGE_LIMITS.title)
  sourceTitle!: string;

  @ApiProperty({ description: 'Absolute http(s) URL of the source' })
  @trim()
  @IsNotEmpty()
  @IsAbsoluteHttpUrl()
  sourceUrl!: string;
}

export class AuthorSourceDto {
  @ApiProperty()
  @RequiredText(AUTHOR_PAGE_LIMITS.title)
  title!: string;

  @ApiProperty({ description: 'Absolute http(s) URL' })
  @trim()
  @IsNotEmpty()
  @IsAbsoluteHttpUrl()
  url!: string;
}
