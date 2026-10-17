import { BookType } from '@prisma/client';
import {
  BOOK_CARD_SELECT,
  type BookCardRow,
  SUMMARIES_WITH_TEXT_COUNT,
  toBookCardDto,
} from './book-card';

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
    _count: { chapters: 1, audioChapters: 0, summaries: 0 },
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

  // Карточка «Похожие пересказы» ведёт на `/book/{slug}/summary`: признак - пересказ этой версии.
  it('hasSummary - по пересказу этой версии', () => {
    expect(toBookCardDto(row(), undefined, null).hasSummary).toBe(false);
    const withSummary = row({ _count: { chapters: 1, audioChapters: 0, summaries: 1 } });
    expect(toBookCardDto(withSummary, undefined, null).hasSummary).toBe(true);
  });

  // Признак пересказа считается только по строкам с видимым текстом (`BookSummary.hasText`).
  it('BOOK_CARD_SELECT считает пересказы по hasText', () => {
    expect(BOOK_CARD_SELECT._count.select.summaries).toEqual({ where: { hasText: true } });
    expect(SUMMARIES_WITH_TEXT_COUNT).toEqual({ where: { hasText: true } });
  });
});
