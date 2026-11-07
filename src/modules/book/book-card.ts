import { BookType, Prisma } from '@prisma/client';
import { ClaimBlockScope } from '../rights-claims/rights-claim-interface';
import { worldwideSettledClaimBlockWhere } from '../rights-claims/settled-claim-block';
import { BookCardDto } from './dto/book-card.dto';

/**
 * Счётчик пересказов для `_count`: только строки с видимым текстом (`BookSummary.hasText`, его
 * пишет `upsertForVersion` по `richHtmlText`, старые строки пересчитала миграция
 * `20261017120000_book_summary_has_text`). Один на все выборки, которые отдают признак пересказа:
 * карточки, список книг (карта сайта) и обзор книги (кнопка и страница). Пустой пересказ, посчитанный
 * здесь, повёл бы на страницу, которая отвечает 404 (решение арбитра 17.10.2026).
 */
export const SUMMARIES_WITH_TEXT_COUNT = {
  where: { hasText: true },
} as const satisfies Prisma.BookVersionCountOutputTypeCountSummariesArgs;

/**
 * Счётчик анализа для `_count` (F03): запись с заполненным ядром (`BookAnalysis.hasCore`,
 * пересчитывается при каждом сохранении). Одна функция на карточки, список книг (по нему карта
 * сайта строит адреса анализа и hreflang) и обзор книги (кнопка, переключатель языка) — решения
 * арбитра А8 и `F03 | F03-2` (`decisions-log.md`).
 *
 * Блок окончённой претензии анализ не закрывает ни по стране, ни на весь мир: анализ — собственный
 * текст редакции (правило владельца 07.11.2026, `T163`, `LEGACY-490`).
 */
export const ANALYSES_WITH_CORE_COUNT = {
  where: { hasCore: true },
} as const satisfies Prisma.BookVersionCountOutputTypeCountAnalysesArgs;

/**
 * Разделы пересказа видны читателю (F04, решение арбитра `F04 | F04-1`): у полного пересказа есть
 * текст и версию не закрывает блок окончённой претензии **на весь мир** (`countryCode = null`) —
 * ни на самой версии, ни на всей книге. Блок по одной стране разделы не закрывает нигде, включая
 * страну блока (правило владельца 07.11.2026, `T163`, `LEGACY-490`): краткий и полный пересказ
 * претензия не закрывает вовсе, по главам — только блок на весь мир. Одно условие на счётчик
 * `_count.summarySections` обзора, список разделов для читателя и ручку карты сайта: счётчик без
 * `hasText` звал бы на оглавление, а список отвечал бы `[]`. Ответы публичные и одинаковы для всех
 * стран — страну условие не читает и не должно.
 * `now` — потому что у блока есть срок (`expiresAt`), а константа застыла бы на старте процесса.
 */
export function summarySectionsVisibleWhere(now: Date) {
  const closing = worldwideSettledClaimBlockWhere(now, ClaimBlockScope.TEXT_READER);
  return {
    summaries: { some: { hasText: true } },
    rightsClaimAccessBlocks: { none: closing },
    book: {
      rightsClaimAccessBlocks: { none: { ...closing, scope: ClaimBlockScope.ENTIRE_BOOK } },
    },
  } satisfies Prisma.BookVersionWhereInput;
}

/** Счётчик разделов пересказа для `_count` обзора книги — правилом `summarySectionsVisibleWhere`. */
export function summarySectionsCount(now: Date) {
  return {
    where: { bookVersion: summarySectionsVisibleWhere(now) },
  } satisfies Prisma.BookVersionCountOutputTypeCountSummarySectionsArgs;
}

/**
 * Карточка книги — одна форма на все пути, которые её отдают: `/books/cards` в разрезах
 * и страница автора (`AuthorService.getPublishedBookCards`, F02-1). Чистые функции без DI:
 * `AuthorService` не может внедрить `BookService` (`BookModule` уже импортирует
 * `AuthorModule`), а вторая копия преобразования разошлась бы с первой на первом же поле
 * (решение арбитра 14.10.2026, `decisions-log.md`, `F02 | F02-1`).
 */
export const BOOK_CARD_SELECT = {
  id: true,
  bookId: true,
  slug: true,
  title: true,
  author: true,
  authorId: true,
  coverImageUrl: true,
  type: true,
  publishedAt: true,
  _count: {
    select: {
      chapters: true,
      audioChapters: true,
      summaries: SUMMARIES_WITH_TEXT_COUNT,
      analyses: ANALYSES_WITH_CORE_COUNT,
    },
  },
  categories: { select: { categoryId: true } },
  book: { select: { slug: true } },
} as const satisfies Prisma.BookVersionSelect;

export type BookCardRow = Prisma.BookVersionGetPayload<{
  select: typeof BOOK_CARD_SELECT;
}>;

export type BookCardRating = { avg: number | null; count: number };

/** Средняя оценка и число оценок по книгам — одним запросом (`LEGACY-216`). */
export async function loadBookCardRatings(
  prisma: { bookRating: Prisma.BookRatingDelegate },
  bookIds: string[],
): Promise<Map<string, BookCardRating>> {
  if (bookIds.length === 0) return new Map();
  const groups = await prisma.bookRating.groupBy({
    by: ['bookId'],
    where: { bookId: { in: bookIds } },
    _avg: { score: true },
    _count: { score: true },
  });
  return new Map(
    groups.map((g) => [g.bookId, { avg: g._avg.score ?? null, count: g._count.score }]),
  );
}

/**
 * Слаг ссылки на книгу: свой слаг версии, а без него — слаг книги. Публичная страница
 * (`BookService.getOverview`) ищет по `BookVersion.slug` и `Book.slug`, по id версии — нет:
 * прежний запасной `row.id` давал ссылку в 404 (`LEGACY-472`). `||`, а не `??`: пустая строка
 * дала бы ссылку `/{lang}/book/`.
 */
export function bookCardSlug(row: { slug: string | null; book: { slug: string } }): string {
  return row.slug || row.book.slug;
}

/**
 * Строка версии в карточку. `authorSlug` — слаг автора **на языке карточки** или `null`:
 * карточка ведёт на `/{lang}/author/...`, и чужой слаг дал бы ссылку в никуда.
 *
 * `hasAudio` — по наличию аудиоглав, а не по `type` версии: бейдж обещает, что книгу можно
 * послушать, а это подтверждают только главы (решение арбитра 14.10.2026, `F02 | F02-1`).
 * `hasSummary` — у этой версии есть пересказ: карточка в блоке «Похожие пересказы» ведёт
 * на `/{lang}/book/{slug}/summary`, и без него ссылка вела бы в 404.
 */
export function toBookCardDto(
  row: BookCardRow,
  rating: BookCardRating | undefined,
  authorSlug: string | null,
): BookCardDto {
  return {
    id: row.bookId,
    slug: bookCardSlug(row),
    title: row.title,
    author: row.author,
    authorSlug,
    coverImageUrl: row.coverImageUrl,
    rating: rating?.avg ?? null,
    ratingsCount: rating?.count ?? 0,
    hasText: row._count.chapters > 0 || row.type === BookType.text,
    hasAudio: row._count.audioChapters > 0,
    hasSummary: row._count.summaries > 0,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    categoryIds: row.categories.map((c) => c.categoryId),
  };
}
