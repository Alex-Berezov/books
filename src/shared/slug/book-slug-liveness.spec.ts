import { Language, Prisma } from '@prisma/client';
import { isBookSlugLive } from './book-slug-liveness';

const makeTx = (version: { id: string } | null, book: { id: string } | null) => ({
  bookVersion: { findFirst: jest.fn().mockResolvedValue(version) },
  book: { findFirst: jest.fn().mockResolvedValue(book) },
});

const asTx = (tx: ReturnType<typeof makeTx>): Prisma.TransactionClient =>
  tx as unknown as Prisma.TransactionClient;

describe('isBookSlugLive (LEGACY-395 / LEGACY-320)', () => {
  it('asks published versions with the full language list first and stops on a hit', async () => {
    const tx = makeTx({ id: 'v1' }, null);

    await expect(isBookSlugLive(asTx(tx), 'idiot')).resolves.toBe(true);

    expect(tx.bookVersion.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.bookVersion.findFirst).toHaveBeenCalledWith({
      where: { slug: 'idiot', status: 'published', language: { in: Object.values(Language) } },
      select: { id: true },
    });
    expect(tx.book.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to Book.slug of another book when no published version holds the slug', async () => {
    const tx = makeTx(null, { id: 'b2' });

    await expect(isBookSlugLive(asTx(tx), 'idiot')).resolves.toBe(true);

    expect(tx.book.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.book.findFirst).toHaveBeenCalledWith({
      where: { slug: 'idiot' },
      select: { id: true },
    });
  });

  it('reports the slug dead when neither a published version nor a book holds it', async () => {
    const tx = makeTx(null, null);

    await expect(isBookSlugLive(asTx(tx), 'idiot')).resolves.toBe(false);
  });
});
