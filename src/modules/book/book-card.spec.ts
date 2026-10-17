import { BookType } from '@prisma/client';
import { type BookCardRow, toBookCardDto } from './book-card';

describe('toBookCardDto', () => {
  const row = (over: Partial<BookCardRow> = {}): BookCardRow => ({
    id: 'version-uuid',
    bookId: 'book-uuid',
    slug: 'a-christmas-carol',
    title: 'A Christmas Carol',
    author: 'Charles Dickens',
    authorId: null,
    coverImageUrl: 'cover.jpg',
    type: BookType.text,
    publishedAt: null,
    _count: { chapters: 1, audioChapters: 0 },
    categories: [],
    book: { slug: 'christmas-carol' },
    ...over,
  });

  it('ведёт на слаг версии, когда он есть', () => {
    expect(toBookCardDto(row(), undefined, null).slug).toBe('a-christmas-carol');
  });

  // Публичная страница ищет по `BookVersion.slug` и `Book.slug`, по id версии - нет: id давал 404.
  it('без слага версии ведёт на слаг книги, а не на id версии', () => {
    expect(toBookCardDto(row({ slug: null }), undefined, null).slug).toBe('christmas-carol');
  });

  it('пустой слаг версии - тоже слаг книги, а не ссылка /{lang}/book/', () => {
    expect(toBookCardDto(row({ slug: '' }), undefined, null).slug).toBe('christmas-carol');
  });
});
