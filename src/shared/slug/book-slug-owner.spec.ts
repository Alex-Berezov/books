import { Language } from '@prisma/client';
import { pickSlugOwner } from './book-slug-owner';

/**
 * Порядок первых двух шагов `getOverview`: версия в языке адреса, затем первая из пришедших
 * (вызывающий упорядочил их `language asc`). Третий шаг — `Book.slug` — у вызывающего.
 */
describe('pickSlugOwner', () => {
  const rows = [
    { language: Language.en, bookId: 'book-en' },
    { language: Language.fr, bookId: 'book-fr' },
    { language: Language.ru, bookId: 'book-ru' },
  ];

  it('takes the version in the address language even when it is not first', () => {
    expect(pickSlugOwner(rows, Language.ru)?.bookId).toBe('book-ru');
    expect(pickSlugOwner(rows, Language.fr)?.bookId).toBe('book-fr');
  });

  it('falls back to the first row when no version is in the address language', () => {
    expect(pickSlugOwner(rows, Language.es)?.bookId).toBe('book-en');
  });

  it('keeps the caller order and does not sort by itself', () => {
    const reversed = [...rows].reverse();
    expect(pickSlugOwner(reversed, Language.es)?.bookId).toBe('book-ru');
  });

  it('returns undefined for no rows, leaving the Book.slug step to the caller', () => {
    expect(pickSlugOwner([], Language.en)).toBeUndefined();
  });
});
