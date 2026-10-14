import { BookType, Prisma } from '@prisma/client';
import { BookCardDto } from './dto/book-card.dto';

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
  _count: { select: { chapters: true, audioChapters: true } },
  categories: { select: { categoryId: true } },
} as const satisfies Prisma.BookVersionSelect;

export type BookCardRow = Prisma.BookVersionGetPayload<{ select: typeof BOOK_CARD_SELECT }>;

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
 * Строка версии в карточку. `authorSlug` — слаг автора **на языке карточки** или `null`:
 * карточка ведёт на `/{lang}/author/...`, и чужой слаг дал бы ссылку в никуда.
 *
 * `hasAudio` — по наличию аудиоглав, а не по `type` версии: бейдж обещает, что книгу можно
 * послушать, а это подтверждают только главы (решение арбитра 14.10.2026, `F02 | F02-1`).
 */
export function toBookCardDto(
  row: BookCardRow,
  rating: BookCardRating | undefined,
  authorSlug: string | null,
): BookCardDto {
  return {
    id: row.bookId,
    slug: row.slug ?? row.id,
    title: row.title,
    author: row.author,
    authorSlug,
    coverImageUrl: row.coverImageUrl,
    rating: rating?.avg ?? null,
    ratingsCount: rating?.count ?? 0,
    hasText: row._count.chapters > 0 || row.type === BookType.text,
    hasAudio: row._count.audioChapters > 0,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    categoryIds: row.categories.map((c) => c.categoryId),
  };
}
