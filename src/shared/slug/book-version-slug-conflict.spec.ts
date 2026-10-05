import { Language, Prisma } from '@prisma/client';
import {
  findBookSlugConflict,
  findVersionSlugConflict,
  lockBookSlugs,
} from './book-version-slug-conflict';

const makeTx = (
  version: { bookId: string; language: Language } | null,
  book: { id: string } | null,
) => ({
  bookVersion: { findFirst: jest.fn().mockResolvedValue(version) },
  book: { findFirst: jest.fn().mockResolvedValue(book) },
  $queryRaw: jest.fn().mockResolvedValue([]),
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
  const sameLanguageCall = (where: object) => ({ where, select: { bookId: true } });
  const anyLanguageCall = (where: object) => ({
    where,
    select: { bookId: true, language: true },
  });

  it('with an own book: same language minus the version, then Book.slug and any language of another book', async () => {
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
      anyLanguageCall({ slug: 'hamlet', language: allLanguages, NOT: { bookId: 'book-1' } }),
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

  it('a version of another book in another language is a conflict of another book, without a language', async () => {
    const tx = makeTx(null, null);
    tx.bookVersion.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bookId: 'book-2', language: Language.es });

    await expect(
      findVersionSlugConflict(asTx(tx), 'hamlet', Language.ru, { bookId: 'book-1' }),
    ).resolves.toEqual({ bookId: 'book-2', slug: 'hamlet', language: null });

    expect(tx.bookVersion.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.book.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
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
      anyLanguageCall({ slug: 'hamlet', language: allLanguages }),
    );
    expect(tx.book.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.book.findFirst).toHaveBeenCalledWith({
      where: { slug: 'hamlet' },
      select: { id: true },
    });
  });
});

/**
 * `LEGACY-437`: старый адрес — тоже адрес. Книжный редирект с этого слага в **любом** языке, цель
 * которого держит другая книга, держит слаг: версия отвечает на адрес во всех языках, фронт
 * спрашивает редирект только после 404, а `SlugRedirectService.record` при смене слага на него
 * снял бы этот редирект. Редирект и держатель цели читаются одним оператором (решение арбитра
 * 05.10.2026, круг 3): здесь закреплена форма оператора, его поведение на базе — в e2e
 * `test/book-version-slug-conflict.e2e-spec.ts`.
 */
describe('old addresses (SlugRedirect) in the slug rule', () => {
  const sqlOf = (tx: ReturnType<typeof makeTx>) =>
    ((tx.$queryRaw.mock.calls[0] as unknown[])[0] as readonly string[]).join('?');
  const valuesOf = (tx: ReturnType<typeof makeTx>) =>
    (tx.$queryRaw.mock.calls[0] as unknown[]).slice(1);

  it('an old address of another book is a conflict for a version, without a language', async () => {
    const tx = makeTx(null, null);
    tx.$queryRaw.mockResolvedValue([{ bookId: 'book-2' }]);

    await expect(
      findVersionSlugConflict(asTx(tx), 'hamlet', Language.ru, {
        versionId: 'version-1',
        bookId: 'book-1',
      }),
    ).resolves.toEqual({ bookId: 'book-2', slug: 'hamlet', language: null });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('one statement: book redirects from the slug in every language, joined to the holders of the target', async () => {
    const tx = makeTx(null, null);

    await findBookSlugConflict(asTx(tx), 'hamlet', 'book-1');

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(tx);
    expect(sql).toMatch(
      /FROM "SlugRedirect" r\s+JOIN "BookVersion" bv\s+ON bv\.slug = r\."newSlug"/,
    );
    expect(sql).toMatch(/JOIN "Book" b ON b\.slug = r\."newSlug"/);
    expect(sql).toContain('UNION ALL');
    // 🔴 Без языка запрос к `BookVersion` читает таблицу целиком: индекс только `@@unique([language, slug])`.
    expect(sql).toMatch(/bv\.language = ANY\(\?::"Language"\[\]\)/);
    expect(sql).toContain(`r."entityType" = 'book'`);
    // Статус версии-держателя не учитывается: правило строже `getOverview`, но не мягче.
    expect(sql).not.toContain('status');
    const values = valuesOf(tx);
    expect(values).toContain('hamlet');
    expect(values).toContain('book-1');
    expect(values).toContainEqual(Object.values(Language));
  });

  it('without an own book the own-book filter is off (null), not an empty id', async () => {
    const tx = makeTx(null, null);

    await findBookSlugConflict(asTx(tx), 'hamlet', undefined);

    const values = valuesOf(tx);
    expect(values).toContain(null);
    expect(values).not.toContain(undefined);
  });

  it('no holder of any target - no conflict', async () => {
    const tx = makeTx(null, null);

    await expect(
      findVersionSlugConflict(asTx(tx), 'hamlet', Language.ru, { bookId: 'book-1' }),
    ).resolves.toBeNull();
    expect(tx.bookVersion.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.book.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

/**
 * `LEGACY-437`, обратная сторона: `Book.slug` языконезависим, поэтому его держат `Book.slug`, версия
 * и старый адрес другой книги в **любом** языке.
 */
describe('findBookSlugConflict', () => {
  it('Book.slug of another book answers first, as a refusal and not P2002', async () => {
    const tx = makeTx({ bookId: 'book-3', language: Language.es }, { id: 'book-2' });

    await expect(findBookSlugConflict(asTx(tx), 'hamlet', 'book-1')).resolves.toEqual({
      bookId: 'book-2',
    });
    expect(tx.book.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.book.findFirst).toHaveBeenCalledWith({
      where: { slug: 'hamlet', NOT: { id: 'book-1' } },
      select: { id: true },
    });
    expect(tx.bookVersion.findFirst).not.toHaveBeenCalled();
  });

  it('a version of another book in any language is a conflict', async () => {
    const tx = makeTx({ bookId: 'book-2', language: Language.es }, null);

    await expect(findBookSlugConflict(asTx(tx), 'hamlet', 'book-1')).resolves.toEqual({
      bookId: 'book-2',
    });
    expect(tx.bookVersion.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.bookVersion.findFirst).toHaveBeenCalledWith({
      where: { slug: 'hamlet', language: allLanguages, NOT: { bookId: 'book-1' } },
      select: { bookId: true, language: true },
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('an old address of another book is a conflict of that book', async () => {
    const tx = makeTx(null, null);
    tx.$queryRaw.mockResolvedValue([{ bookId: 'book-2' }]);

    await expect(findBookSlugConflict(asTx(tx), 'hamlet', 'book-1')).resolves.toEqual({
      bookId: 'book-2',
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('without an own book (creation) any match is a conflict; a free slug is free', async () => {
    const tx = makeTx(null, null);

    await expect(findBookSlugConflict(asTx(tx), 'hamlet', undefined)).resolves.toBeNull();
    expect(tx.book.findFirst).toHaveBeenCalledWith({
      where: { slug: 'hamlet' },
      select: { id: true },
    });
    expect(tx.bookVersion.findFirst).toHaveBeenCalledWith({
      where: { slug: 'hamlet', language: allLanguages },
      select: { bookId: true, language: true },
    });
  });
});

describe('lockBookSlugs', () => {
  const sqlOf = (call: unknown[]) => (call[0] as readonly string[]).join('?');

  it('one slug: one lock on hashtext(slug), the key every single-slug writer takes', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ locked: true }]);
    const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;

    await lockBookSlugs(tx, 'alpha', null, undefined, 'alpha');

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf(queryRaw.mock.calls[0] as unknown[])).toContain('hashtext(');
    expect(queryRaw.mock.calls[0].slice(1)).toEqual([831_427_005, 'alpha']);
  });

  it('several slugs: locks are taken in the order of their keys, not of the slugs', async () => {
    // Ключи от базы приходят уже отсортированными и без повторов (`ORDER BY key`, `DISTINCT`):
    // при совпавшем хеше двух слагов порядок по строкам у встречных транзакций мог бы разойтись.
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ key: -7 }, { key: 42 }])
      .mockResolvedValue([{ locked: true }]);
    const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;

    await lockBookSlugs(tx, 'zeta', 'alpha', 'zeta');

    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(sqlOf(queryRaw.mock.calls[0] as unknown[])).toMatch(
      /DISTINCT hashtext\(s\).*ORDER BY key/s,
    );
    expect(queryRaw.mock.calls[0].slice(1)).toEqual([['zeta', 'alpha']]);
    expect(queryRaw.mock.calls.slice(1).map((call: unknown[]) => call.slice(1))).toEqual([
      [831_427_005, -7],
      [831_427_005, 42],
    ]);
  });

  it('no slugs: no query', async () => {
    const queryRaw = jest.fn();
    const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;

    await lockBookSlugs(tx, null, undefined);

    expect(queryRaw).not.toHaveBeenCalled();
  });
});
