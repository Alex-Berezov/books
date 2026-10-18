import { BookType, GeoBlockScope, RightsClaimBlockStatus, RightsClaimStatus } from '@prisma/client';
import {
  bookCardSelect,
  type BookCardRow,
  SUMMARIES_WITH_TEXT_COUNT,
  analysesWithCoreCount,
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
    _count: { chapters: 1, audioChapters: 0, summaries: 0, analyses: 0 },
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
    const withSummary = row({
      _count: { chapters: 1, audioChapters: 0, summaries: 1, analyses: 0 },
    });
    expect(toBookCardDto(withSummary, undefined, null).hasSummary).toBe(true);
  });

  const now = new Date('2026-10-18T12:00:00Z');

  // Признак пересказа считается только по строкам с видимым текстом (`BookSummary.hasText`).
  it('bookCardSelect считает пересказы по hasText', () => {
    expect(bookCardSelect(now)._count.select.summaries).toEqual({ where: { hasText: true } });
    expect(SUMMARIES_WITH_TEXT_COUNT).toEqual({ where: { hasText: true } });
  });

  // F03: анализ считается только с заполненным ядром (решение арбитра А8) и без действующего блока
  // окончённой претензии ни по какой стране — на версии или на всей книге (`F03 | F03-2`). Условие
  // прибито литералом: без фильтра претензии адрес закрытого анализа уходит в карту сайта.
  it('bookCardSelect и обзор считают анализ по hasCore без закрытых претензией', () => {
    const closing = {
      status: RightsClaimBlockStatus.ACTIVE,
      scope: {
        in: [GeoBlockScope.ENTIRE_BOOK, GeoBlockScope.LANGUAGE_EDITION, GeoBlockScope.TEXT_READER],
      },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      rightsClaim: {
        status: {
          in: [
            RightsClaimStatus.RESOLVED_VALID,
            RightsClaimStatus.RESOLVED_INVALID,
            RightsClaimStatus.WITHDRAWN,
            RightsClaimStatus.CLOSED,
          ],
        },
      },
    };
    const expected = {
      where: {
        hasCore: true,
        bookVersion: {
          rightsClaimAccessBlocks: { none: closing },
          book: {
            rightsClaimAccessBlocks: { none: { ...closing, scope: GeoBlockScope.ENTIRE_BOOK } },
          },
        },
      },
    };
    expect(analysesWithCoreCount(now)).toEqual(expected);
    expect(bookCardSelect(now)._count.select.analyses).toEqual(expected);
  });
});
