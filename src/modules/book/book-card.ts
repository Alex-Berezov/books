import { BookType, Prisma } from '@prisma/client';
import { ClaimBlockScope } from '../rights-claims/rights-claim-interface';
import { settledClaimBlockWhere } from '../rights-claims/settled-claim-block';
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
 * пересчитывается при каждом сохранении) у версии, которую не закрывает блок окончённой
 * претензии ни по какой стране — ни на самой версии, ни на всей книге. Одна функция на карточки,
 * список книг (по нему карта сайта строит адреса анализа и hreflang) и обзор книги (кнопка,
 * переключатель языка) — решения арбитра А8 и `F03 | F03-2` (`decisions-log.md`).
 *
 * Страну счётчик не читает намеренно: ответ списка и обзора кэшируется публично и одинаков для
 * всех стран. Блок по одной стране убирает адрес из карты сайта и кнопку везде, а сам доступ
 * закрывает только в стране блока — middleware фронта по списку `GET analyses/claim-closures`.
 * `now` — потому что у блока есть срок (`expiresAt`), а константа застыла бы на старте процесса.
 */
export function analysesWithCoreCount(now: Date) {
  const closing = settledClaimBlockWhere(now, ClaimBlockScope.TEXT_READER);
  return {
    where: {
      hasCore: true,
      bookVersion: {
        rightsClaimAccessBlocks: { none: closing },
        book: {
          rightsClaimAccessBlocks: { none: { ...closing, scope: ClaimBlockScope.ENTIRE_BOOK } },
        },
      },
    },
  } satisfies Prisma.BookVersionCountOutputTypeCountAnalysesArgs;
}

/**
 * Карточка книги — одна форма на все пути, которые её отдают: `/books/cards` в разрезах
 * и страница автора (`AuthorService.getPublishedBookCards`, F02-1). Чистые функции без DI:
 * `AuthorService` не может внедрить `BookService` (`BookModule` уже импортирует
 * `AuthorModule`), а вторая копия преобразования разошлась бы с первой на первом же поле
 * (решение арбитра 14.10.2026, `decisions-log.md`, `F02 | F02-1`).
 */
export function bookCardSelect(now: Date) {
  return {
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
        analyses: analysesWithCoreCount(now),
      },
    },
    categories: { select: { categoryId: true } },
    book: { select: { slug: true } },
  } as const satisfies Prisma.BookVersionSelect;
}

export type BookCardRow = Prisma.BookVersionGetPayload<{
  select: ReturnType<typeof bookCardSelect>;
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
