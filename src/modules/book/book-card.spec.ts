import { BookType, GeoBlockScope, RightsClaimBlockStatus, RightsClaimStatus } from '@prisma/client';
import {
  BOOK_CARD_SELECT,
  type BookCardRow,
  SUMMARIES_WITH_TEXT_COUNT,
  ANALYSES_WITH_CORE_COUNT,
  summarySectionsCount,
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
  it('BOOK_CARD_SELECT считает пересказы по hasText', () => {
    expect(BOOK_CARD_SELECT._count.select.summaries).toEqual({ where: { hasText: true } });
    expect(SUMMARIES_WITH_TEXT_COUNT).toEqual({ where: { hasText: true } });
  });

  // Условие окончённой претензии без страны — общее для анализа и разделов пересказа.
  const anyCountry = {
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

  // F03: анализ считается только с заполненным ядром (решение арбитра А8). Блок окончённой
  // претензии анализ не закрывает ни по стране, ни на весь мир (правило владельца 07.11.2026,
  // `T163`): фильтр претензии в счётчике прячет анализ со страницы книги, hreflang и карты сайта.
  it('BOOK_CARD_SELECT и обзор считают анализ по hasCore без фильтра претензий', () => {
    const expected = { where: { hasCore: true } };
    expect(ANALYSES_WITH_CORE_COUNT).toEqual(expected);
    expect(BOOK_CARD_SELECT._count.select.analyses).toEqual(expected);
  });

  // Разделы пересказа закрывает только блок окончённой претензии на весь мир (`countryCode: null`):
  // блок одной страны разделы не прячет нигде (правило владельца 07.11.2026, `T163`, `LEGACY-490`).
  // Без `countryCode: null` блок одной страны снова прячет оглавление и карту сайта везде.
  it('разделы пересказа закрывает только блок окончённой претензии на весь мир', () => {
    const closing = { ...anyCountry, countryCode: null };
    expect(summarySectionsCount(now)).toEqual({
      where: {
        bookVersion: {
          summaries: { some: { hasText: true } },
          rightsClaimAccessBlocks: { none: closing },
          book: {
            rightsClaimAccessBlocks: {
              none: { ...closing, scope: GeoBlockScope.ENTIRE_BOOK },
            },
          },
        },
      },
    });
  });
});
