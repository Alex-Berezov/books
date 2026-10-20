import { BookType, type Language, type Prisma, type PrismaClient } from '@prisma/client';

/**
 * Общая часть служебных книг приёмки (`seed-analyses.ts`, `seed-summaries.ts`): книга за цепочкой
 * прав, версия книги, снятие версий вне набора и главы версии. Остальное содержимое версии
 * (анализ, пересказ, разделы, гео-правила, `Seo`) каждый сид заводит сам.
 *
 * Книги приёмки - вне `SEO_CATALOG_BOOKS`, точные числа каталога в `test/seed-dataset.e2e-spec.ts`
 * от них не меняются.
 */

/** Права книги - та же цепочка, что у каталога в `seed.ts`. */
export type EnsureRights = (
  bookSlug: string,
  candidate: { title: string; author: string; summaryRu: string },
) => Promise<{ intake: { id: string }; profile: { id: string }; review: { id: string } }>;

const ACCEPTANCE_AUTHOR = 'Bibliaris Acceptance';

export interface AcceptanceBookRights {
  bookId: string;
  profileId: string;
  reviewId: string;
}

/**
 * Книга по слагу. Она заводится сразу за цепочкой прав и вне транзакции содержимого, как у
 * каталога (`seed.ts`): сорвись содержимое - книга с цепочкой уже есть, и следующий прогон её
 * найдёт, а не заведёт вторую цепочку (LEGACY-200, комментарий у `ensureRightsChain`).
 */
export async function upsertAcceptanceBook(
  prisma: PrismaClient,
  ensureRights: EnsureRights,
  slug: string,
  candidate: { title: string; summaryRu: string },
): Promise<AcceptanceBookRights> {
  const { intake, profile, review } = await ensureRights(slug, {
    ...candidate,
    author: ACCEPTANCE_AUTHOR,
  });
  const rights = {
    rightsIntakeId: intake.id,
    currentRightsProfileId: profile.id,
    approvedRightsReviewId: review.id,
    rightsCreatedAt: new Date(),
  };
  const book = await prisma.book.upsert({
    where: { slug },
    update: rights,
    create: { slug, ...rights },
    select: { id: true },
  });
  return { bookId: book.id, profileId: profile.id, reviewId: review.id };
}

/**
 * Версия книги приёмки на языке: по `(bookId, language)`, поля из набора пишутся при каждом
 * прогоне. Права снимка те же, что у каталога (`seed.ts`), клиренс сид не ведёт. `seoId` - для
 * редакторского `noindex` набора.
 */
export async function upsertAcceptanceVersion(
  tx: Prisma.TransactionClient,
  rights: AcceptanceBookRights,
  version: {
    slug: string;
    language: Language;
    title: string;
    description: string;
    status?: 'published' | 'draft';
  },
): Promise<{ id: string; seoId: number | null }> {
  const fields = {
    title: version.title,
    slug: version.slug,
    author: ACCEPTANCE_AUTHOR,
    description: version.description,
    status: version.status ?? ('published' as const),
    rightsProfileId: rights.profileId,
    approvedRightsReviewId: rights.reviewId,
  };
  const row = await tx.bookVersion.upsert({
    where: { bookId_language: { bookId: rights.bookId, language: version.language } },
    update: fields,
    create: {
      ...fields,
      bookId: rights.bookId,
      language: version.language,
      coverImageUrl: 'https://example.com/cover.jpg',
      type: BookType.text,
      isFree: true,
      rightsStatus: 'APPROVED',
      rightsAllowedCountryCodes: ['US', 'GB', 'ES', 'FR', 'PT', 'BR', 'RU'],
      rightsBlockedCountryCodes: [],
      rightsLicenseRequiredCountryCodes: [],
      rightsPendingCountryCodes: [],
    },
    select: { id: true, seoId: true },
  });
  return row;
}

/** Версии книги приёмки на языках вне набора снимаются вместе со своими строками (каскад). */
export async function pruneAcceptanceVersions(
  tx: Prisma.TransactionClient,
  bookId: string,
  languages: Language[],
): Promise<void> {
  await tx.bookVersion.deleteMany({ where: { bookId, language: { notIn: languages } } });
}

/** Главы версии приёмки - ровно номера набора: лишние снимаются, остальные пишутся целиком. */
export async function upsertAcceptanceChapters(
  tx: Prisma.TransactionClient,
  versionId: string,
  numbers: number[],
  chapterOf: (number: number) => { title: string; content: string },
): Promise<void> {
  await tx.chapter.deleteMany({ where: { bookVersionId: versionId, number: { notIn: numbers } } });
  for (const number of numbers) {
    const chapter = chapterOf(number);
    await tx.chapter.upsert({
      where: { bookVersionId_number: { bookVersionId: versionId, number } },
      update: chapter,
      create: { ...chapter, bookVersionId: versionId, number },
      select: { id: true },
    });
  }
}
