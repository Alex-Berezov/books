import { Language, Prisma } from '@prisma/client';
import type {
  AuthorAdaptationDto,
  AuthorAwardDto,
  AuthorFactsDto,
  AuthorFunFactDto,
  AuthorInfluencesDto,
  AuthorNotableWorkDto,
  AuthorPhotoCreditDto,
  AuthorSourceDto,
  AuthorStartHereDto,
  AuthorTimelineEventDto,
} from './dto/author-page-blocks.dto';
import type {
  AuthorFaqDto,
  AuthorQuoteDto,
  AuthorTranslationDto,
} from './dto/author-translation.dto';

/**
 * Данные страницы автора (F02-2): приведение блоков к хранимому виду, ключ содержимого
 * перевода для `updatedAt` и сбор слагов для разрешения ссылок. Чистые функции без DI —
 * их зовут и запись (`AuthorService.create`/`update`), и чтение (`getPublicBySlug`,
 * предупреждения сохранения), чтобы правило было одно.
 */

/** Блоки страницы автора, которые добавила F02-2 (`tech.md` §2): строка `tagline` и JSON-колонки. */
export const AUTHOR_PAGE_BLOCK_KEYS = [
  'tagline',
  'facts',
  'notableWorks',
  'startHere',
  'timeline',
  'influences',
  'awards',
  'adaptations',
  'funFacts',
  'sources',
] as const satisfies ReadonlyArray<keyof StoredAuthorPageBlocks>;

/**
 * Блок, которого нет в теле записи (`undefined`), берёт прежнее значение перевода: по T5
 * отсутствующий ключ поле не трогает, а `update` пересоздаёт перевод целиком. Явный `null`
 * или пустое значение блок очищает. Перевода раньше не было — блок пуст.
 */
export function keepAbsentBlocks(
  blocks: StoredAuthorPageBlocks,
  dto: AuthorTranslationDto,
  old: Partial<Record<keyof StoredAuthorPageBlocks, unknown>> | undefined,
): StoredAuthorPageBlocks {
  if (!old) return blocks;
  const previous = readStoredBlocks(old);
  const merged: Record<string, unknown> = { ...blocks };
  for (const key of AUTHOR_PAGE_BLOCK_KEYS) {
    if (dto[key] === undefined) merged[key] = previous[key];
  }
  return merged as unknown as StoredAuthorPageBlocks;
}

/** Блоки перевода в том виде, в каком они лежат в базе (после `compactBlock`). */
export interface StoredAuthorPageBlocks {
  tagline: string | null;
  facts: AuthorFactsDto | null;
  notableWorks: AuthorNotableWorkDto[] | null;
  startHere: AuthorStartHereDto[] | null;
  timeline: AuthorTimelineEventDto[] | null;
  influences: AuthorInfluencesDto | null;
  awards: AuthorAwardDto[] | null;
  adaptations: AuthorAdaptationDto[] | null;
  funFacts: AuthorFunFactDto[] | null;
  sources: AuthorSourceDto[] | null;
  quotes: AuthorQuoteDto[] | null;
}

/**
 * Значение к хранимому виду: строки обрезаны, `''`, `null` и `undefined` у полей и элементов
 * выброшены («нет значения», `tech.md` §2), пустой массив или объект — `null` («блока нет», T5).
 * Экземпляры DTO превращаются в простые объекты — в JSON-колонку уходит только форма.
 */
export function compactBlock(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  // Дата — значение, а не объект с полями: иначе `Object.entries` пуст и даты SEO-события
  // выпадали бы из сравнения содержимого перевода.
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (Array.isArray(value)) {
    const items = value.map(compactBlock).filter((v) => v !== null);
    return items.length === 0 ? null : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const v = compactBlock(raw);
      if (v !== null) out[key] = v;
    }
    return Object.keys(out).length === 0 ? null : out;
  }
  return value;
}

/** `null` в JSON-колонку Prisma пишется `DbNull`, а не голым `null`. */
export function toJsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/** Блоки перевода из DTO записи — в хранимом виде. Отсутствующее поле — `null`. */
export function toStoredBlocks(t: AuthorTranslationDto): StoredAuthorPageBlocks {
  const tagline = compactBlock(t.tagline);
  return {
    tagline: typeof tagline === 'string' ? tagline : null,
    facts: compactBlock(t.facts) as AuthorFactsDto | null,
    notableWorks: compactBlock(t.notableWorks) as AuthorNotableWorkDto[] | null,
    startHere: compactBlock(t.startHere) as AuthorStartHereDto[] | null,
    timeline: compactBlock(t.timeline) as AuthorTimelineEventDto[] | null,
    influences: compactBlock(t.influences) as AuthorInfluencesDto | null,
    awards: compactBlock(t.awards) as AuthorAwardDto[] | null,
    adaptations: compactBlock(t.adaptations) as AuthorAdaptationDto[] | null,
    funFacts: compactBlock(t.funFacts) as AuthorFunFactDto[] | null,
    sources: compactBlock(t.sources) as AuthorSourceDto[] | null,
    quotes: compactBlock(t.quotes) as AuthorQuoteDto[] | null,
  };
}

/** Хранимые блоки — в поля `data` Prisma для `authorTranslation.create`. */
export function storedBlocksToData(blocks: StoredAuthorPageBlocks) {
  return {
    tagline: blocks.tagline,
    facts: toJsonColumn(blocks.facts),
    notableWorks: toJsonColumn(blocks.notableWorks),
    startHere: toJsonColumn(blocks.startHere),
    timeline: toJsonColumn(blocks.timeline),
    influences: toJsonColumn(blocks.influences),
    awards: toJsonColumn(blocks.awards),
    adaptations: toJsonColumn(blocks.adaptations),
    funFacts: toJsonColumn(blocks.funFacts),
    sources: toJsonColumn(blocks.sources),
    quotes: toJsonColumn(blocks.quotes),
  };
}

/** Строка JSON с ключами по алфавиту на любой глубине: порядок ключей содержимым не считается. */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === undefined || v === null) return null;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(normalize);
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = normalize((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

/** Слаг из данных страницы и место, откуда он взят (путь — для предупреждений сохранения). */
export interface AuthorPageSlugRef {
  kind: 'book' | 'author';
  path: string;
  slug: string;
}

/** Блоки, в которых живут слаги книг и авторов (`collectSlugRefs`); по нему же читает `select`. */
export const SLUG_REF_BLOCK_KEYS = [
  'notableWorks',
  'startHere',
  'timeline',
  'influences',
  'adaptations',
  'quotes',
] as const satisfies ReadonlyArray<keyof StoredAuthorPageBlocks>;
export type SlugRefBlockKey = (typeof SLUG_REF_BLOCK_KEYS)[number];

/**
 * Все слаги книг и авторов из блоков перевода — с путями вида `startHere[0].bookSlug`.
 * Похожие авторы (`similarSlugs`) входят сюда же: для предупреждения «не найдено на сайте»
 * это такой же слаг автора.
 */
export function collectSlugRefs(
  blocks: Pick<StoredAuthorPageBlocks, SlugRefBlockKey>,
  similarSlugs: string[],
): AuthorPageSlugRef[] {
  const refs: AuthorPageSlugRef[] = [];
  const book = (path: string, slug: string | null | undefined) => {
    if (slug) refs.push({ kind: 'book', path, slug });
  };
  blocks.notableWorks?.forEach((w, i) => book(`notableWorks[${i}].bookSlug`, w.bookSlug));
  blocks.startHere?.forEach((s, i) => book(`startHere[${i}].bookSlug`, s.bookSlug));
  blocks.timeline?.forEach((e, i) => book(`timeline[${i}].bookSlug`, e.bookSlug));
  blocks.adaptations?.forEach((a, i) => book(`adaptations[${i}].bookSlug`, a.bookSlug));
  blocks.quotes?.forEach((q, i) => book(`quotes[${i}].bookSlug`, q.bookSlug));
  for (const side of ['influencedBy', 'influenced'] as const) {
    blocks.influences?.[side]?.forEach((r, i) => {
      if (r.authorSlug)
        refs.push({
          kind: 'author',
          path: `influences.${side}[${i}].authorSlug`,
          slug: r.authorSlug,
        });
    });
  }
  similarSlugs.forEach((slug, i) => {
    if (slug) refs.push({ kind: 'author', path: `similarSlugs[${i}]`, slug });
  });
  return refs;
}

/**
 * Список по году, по возрастанию; элементы без года — в конце, порядок равных сохраняется
 * (`tech.md` §2). `Array.prototype.sort` устойчива с ES2019.
 */
export function sortByYear<T extends { year?: number | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ya = a.year ?? null;
    const yb = b.year ?? null;
    if (ya === yb) return 0;
    if (ya === null) return 1;
    if (yb === null) return -1;
    return ya - yb;
  });
}

/** Хранимые блоки из строки перевода (JSON-колонки читаются как есть: форму стережёт запись). */
export function readStoredBlocks(
  row: Partial<Record<keyof StoredAuthorPageBlocks, unknown>>,
): StoredAuthorPageBlocks {
  return {
    tagline: typeof row.tagline === 'string' ? row.tagline : null,
    facts: (row.facts ?? null) as AuthorFactsDto | null,
    notableWorks: (row.notableWorks ?? null) as AuthorNotableWorkDto[] | null,
    startHere: (row.startHere ?? null) as AuthorStartHereDto[] | null,
    timeline: (row.timeline ?? null) as AuthorTimelineEventDto[] | null,
    influences: (row.influences ?? null) as AuthorInfluencesDto | null,
    awards: (row.awards ?? null) as AuthorAwardDto[] | null,
    adaptations: (row.adaptations ?? null) as AuthorAdaptationDto[] | null,
    funFacts: (row.funFacts ?? null) as AuthorFunFactDto[] | null,
    sources: (row.sources ?? null) as AuthorSourceDto[] | null,
    quotes: (row.quotes ?? null) as AuthorQuoteDto[] | null,
  };
}

/** Автор, найденный по слагу из данных страницы; `slug` — на языке страницы или `null` (без ссылки). */
export interface AuthorRef {
  authorId: string;
  name: string;
  slug: string | null;
  photoUrl: string | null;
  birthDate: string | null;
  deathDate: string | null;
}

/** Похожий автор в ответе публичной ручки. */
export type PublicSimilarAuthor = Omit<AuthorRef, 'authorId'>;

/** Карточка книги из данных страницы — на языке страницы. */
export interface AuthorPageBookRef {
  slug: string;
  title: string;
  coverUrl: string;
}

/** Слаг из данных автора, который страница покажет без ссылки. */
export interface AuthorSlugWarning {
  lang: Language;
  path: string;
  slug: string;
}

/** Автор с переводами и их SEO — то, что читают и возвращают `create`, `update`, `unlinkPerson`. */
export type AdminAuthorRow = Prisma.AuthorGetPayload<{
  include: { translations: { include: { seo: true } } };
}>;

/**
 * Перевод в админском ответе: JSON-колонки — в той форме, в какой их принимает запись
 * (`AuthorTranslationResponseDto`). Без приведения тип возврата — `JsonValue`, и сторож схемы
 * ответа (`yarn check:response-schema`) не может сверить поля с описанием.
 */
export function toAdminTranslation(t: AdminAuthorRow['translations'][number]) {
  return {
    ...t,
    quotes: t.quotes as unknown as AuthorQuoteDto[] | null,
    faq: t.faq as unknown as AuthorFaqDto[] | null,
    similarSlugs: t.similarSlugs as unknown as string[] | null,
    facts: t.facts as unknown as AuthorFactsDto | null,
    notableWorks: t.notableWorks as unknown as AuthorNotableWorkDto[] | null,
    startHere: t.startHere as unknown as AuthorStartHereDto[] | null,
    timeline: t.timeline as unknown as AuthorTimelineEventDto[] | null,
    influences: t.influences as unknown as AuthorInfluencesDto | null,
    awards: t.awards as unknown as AuthorAwardDto[] | null,
    adaptations: t.adaptations as unknown as AuthorAdaptationDto[] | null,
    funFacts: t.funFacts as unknown as AuthorFunFactDto[] | null,
    sources: t.sources as unknown as AuthorSourceDto[] | null,
  };
}

/** Автор с переводами в админском ответе (`AuthorResponseDto`) — те же приведения. */
export function toAdminAuthor(author: AdminAuthorRow) {
  return {
    ...author,
    photoCredit: author.photoCredit as unknown as AuthorPhotoCreditDto | null,
    translations: author.translations.map(toAdminTranslation),
  };
}
