import { Language, Prisma } from '@prisma/client';
import { getSupportedLanguages } from '../language/language.util';

/** Кто владеет проверяемым слагом: редактируемая версия и её книга. */
export interface VersionSlugOwner {
  versionId?: string;
  bookId?: string;
}

/**
 * Может ли языковая версия взять этот слаг — одно правило на подсказку админки
 * (`BookService.checkVersionSlugExists`) и на запись (`BookVersionService` create/update).
 *
 * Повторяет то, как публичный `getOverview` резолвит адрес: версия в языке пути, затем версия
 * с этим слагом в любом языке, затем `Book.slug` (как и `isBookSlugLive` рядом). Поэтому слаг
 * занят, если его держит
 * (а) другая версия того же языка — ключ `@@unique([language, slug])`;
 * (б) `Book.slug` другой книги;
 * (в) версия другой книги в любом языке.
 * (б) и (в) молча увели бы живой адрес другой книги на эту. Совпадение со своей книгой
 * (её `Book.slug`, её версии в других языках) ведёт в ту же книгу и конфликтом не считается.
 * Статус версии не учитывается: черновик занимает адрес в момент публикации. Без своей книги
 * конфликт — любое совпадение.
 *
 * 🔴 `language: { in: ... }` — у `BookVersion` нет индекса с ведущим `slug`, только
 * `@@unique([language, slug])`; без языка запрос читает таблицу целиком (как у `isBookSlugLive`).
 *
 * @returns Книга и слаг конфликта и язык занявшей его версии (`null` — занял `Book.slug`),
 *   или `null`, если слаг свободен.
 */
export async function findVersionSlugConflict(
  db: Prisma.TransactionClient,
  slug: string,
  language: Language,
  owner: VersionSlugOwner,
): Promise<{ bookId: string; slug: string; language: Language | null } | null> {
  const select = { bookId: true, language: true } as const;

  // (а) Первой — версия того же языка: её отказ называет язык, а не чужую книгу.
  const sameLanguage = await db.bookVersion.findFirst({
    where: { slug, language, ...(owner.versionId ? { NOT: { id: owner.versionId } } : {}) },
    select,
  });
  if (sameLanguage) return { bookId: sameLanguage.bookId, slug, language };

  // (в) Версия другой книги в любом языке; без своей книги — любая версия.
  const otherBook = await db.bookVersion.findFirst({
    where: {
      slug,
      language: { in: getSupportedLanguages() },
      ...(owner.bookId ? { NOT: { bookId: owner.bookId } } : {}),
    },
    select,
  });
  if (otherBook) return { bookId: otherBook.bookId, slug, language: otherBook.language };

  // (б) `Book.slug` другой книги.
  const book = await db.book.findFirst({
    where: { slug, ...(owner.bookId ? { NOT: { id: owner.bookId } } : {}) },
    select: { id: true },
  });
  return book ? { bookId: book.id, slug, language: null } : null;
}
