import { Language, Prisma } from '@prisma/client';
import { findVersionSlugConflict } from './book-version-slug-conflict';

const makeTx = (
  version: { bookId: string; language: Language } | null,
  book: { id: string } | null,
) => ({
  bookVersion: { findFirst: jest.fn().mockResolvedValue(version) },
  book: { findFirst: jest.fn().mockResolvedValue(book) },
});

const asTx = (tx: ReturnType<typeof makeTx>): Prisma.TransactionClient =>
  tx as unknown as Prisma.TransactionClient;

const allLanguages = { in: Object.values(Language) };

/**
 * Одно правило слага языковой версии на подсказку и на запись: занят слаг другой версии того же
 * языка, `Book.slug` другой книги и слаг версии другой книги в любом языке - так, как публичный
 * `getOverview` разрешает адрес. Свои слаги ведут в ту же книгу и свободны.
 */
describe('findVersionSlugConflict', () => {
  const sameLanguageCall = (where: object) => ({
    where,
    select: { bookId: true, language: true },
  });

  it('with an own book: same language minus the version, then any language of another book, then Book.slug', async () => {
    const tx = makeTx(null, null);

    await expect(
      findVersionSlugConflict(asTx(tx), 'hamlet', Language.ru, {
        versionId: 'version-1',
        bookId: 'book-1',
      }),
    ).resolves.toBeNull();

    expect(tx.bookVersion.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.bookVersion.findFirst).toHaveBeenNthCalledWith(
      1,
      sameLanguageCall({ slug: 'hamlet', language: Language.ru, NOT: { id: 'version-1' } }),
    );
    expect(tx.bookVersion.findFirst).toHaveBeenNthCalledWith(
      2,
      sameLanguageCall({ slug: 'hamlet', language: allLanguages, NOT: { bookId: 'book-1' } }),
    );
    expect(tx.book.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.book.findFirst).toHaveBeenCalledWith({
      where: { slug: 'hamlet', NOT: { id: 'book-1' } },
      select: { id: true },
    });
  });

  it('a version of the same language answers first, with the language', async () => {
    const tx = makeTx({ bookId: 'book-2', language: Language.ru }, null);

    await expect(
      findVersionSlugConflict(asTx(tx), 'hamlet', Language.ru, { bookId: 'book-1' }),
    ).resolves.toEqual({ bookId: 'book-2', slug: 'hamlet', language: Language.ru });

    expect(tx.bookVersion.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.book.findFirst).not.toHaveBeenCalled();
  });

  it('a version of another book in another language answers before Book.slug', async () => {
    const tx = makeTx(null, null);
    tx.bookVersion.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bookId: 'book-2', language: Language.es });

    await expect(
      findVersionSlugConflict(asTx(tx), 'hamlet', Language.ru, { bookId: 'book-1' }),
    ).resolves.toEqual({ bookId: 'book-2', slug: 'hamlet', language: Language.es });

    expect(tx.bookVersion.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.book.findFirst).not.toHaveBeenCalled();
  });

  it('Book.slug of another book is a conflict without a language', async () => {
    const tx = makeTx(null, { id: 'book-2' });

    await expect(
      findVersionSlugConflict(asTx(tx), 'hamlet', Language.ru, { bookId: 'book-1' }),
    ).resolves.toEqual({ bookId: 'book-2', slug: 'hamlet', language: null });
    expect(tx.book.findFirst).toHaveBeenCalledTimes(1);
  });

  it('without an own book every match is a conflict', async () => {
    const tx = makeTx(null, null);

    await findVersionSlugConflict(asTx(tx), 'hamlet', Language.en, {});

    expect(tx.bookVersion.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.bookVersion.findFirst).toHaveBeenNthCalledWith(
      2,
      sameLanguageCall({ slug: 'hamlet', language: allLanguages }),
    );
    expect(tx.book.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.book.findFirst).toHaveBeenCalledWith({
      where: { slug: 'hamlet' },
      select: { id: true },
    });
  });
});
