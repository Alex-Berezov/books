import { Prisma } from '@prisma/client';

/**
 * Состав автора в публичном списке `GET /:lang/authors` (`LEGACY-214`).
 *
 * 🔴 Причина существования константы — утечка, которая живёт в `AuthorService.list()`
 * до сих пор. Тот метод читает переводы через `include: { translations: { include:
 * { seo: true } } }`, то есть отдаёт анониму **каждый перевод каждого автора целиком**:
 * биографию на всю длину, `quotes`, `faq`, `similarSlugs` и вложенный `Seo` со всеми
 * полями. На странице в двадцать четыре карточки это сотни килобайт, из которых
 * рисуется имя и кружок с портретом.
 *
 * Здесь список **белый**, а не `omit`. `omit` пропустил бы новую колонку схемы молча —
 * тот же довод, что в `PUBLIC_BOOK_VERSION_SELECT`. Новое поле в ответе не появится,
 * пока его не впишут сюда руками.
 *
 * ⚠️ `list()` этим списком **не** чинится и вообще не трогается: он ходит из админки,
 * где полный состав перевода уместен, и его правка — отдельная задача (`LEGACY-214`).
 */

/**
 * Соседние переводы автора — ровно то, из чего строится языковая альтернатива.
 *
 * 🔴 Три поля, и ни одним больше. `slug` — потому что корневой слаг в списке
 * английский, и ссылка на `/ru/author/<корневой>` даёт 404 (инцидент
 * `sun-tzu` / `sun-czy`, комментарий в `HomePageContent.tsx:100-106`). `name` —
 * потому что подписи под портретами на главной берутся отсюда же
 * (`getAuthorDisplayName`), и без него они станут пустыми строками.
 */
export const PUBLIC_AUTHOR_TRANSLATION_SELECT = {
  language: true,
  slug: true,
  name: true,
} satisfies Prisma.AuthorTranslationSelect;

/**
 * Автор и его языковые слаги. Читается одним запросом на всю страницу списка.
 *
 * Биографии здесь нет намеренно: она нужна только на языке страницы и только для
 * того, чтобы посчитать `shortBio`. Тянуть её на пять языков ради одной обрезки —
 * это `@db.Text` × 5 × размер страницы.
 */
export const PUBLIC_AUTHOR_SELECT = {
  id: true,
  birthDate: true,
  deathDate: true,
  translations: { select: PUBLIC_AUTHOR_TRANSLATION_SELECT },
} satisfies Prisma.AuthorSelect;

/**
 * Перевод на язык страницы: имя, слаг и портрет для карточки.
 *
 * ⚠️ `biography` здесь нет намеренно. Она `@db.Text`, и читать её целиком на все
 * двадцать четыре карточки ради ста шестидесяти знаков — это мегабайты по сети
 * ради строки под именем. Начало биографии приходит отдельной колонкой того же
 * запроса, что считает счётчики: `left(t.biography, SHORT_BIO_SOURCE_LIMIT)`
 * обрезает её на стороне базы. Полная биография не покидает сервер вовсе.
 */
export const PUBLIC_AUTHOR_PAGE_TRANSLATION_SELECT = {
  authorId: true,
  slug: true,
  name: true,
  photoUrl: true,
} satisfies Prisma.AuthorTranslationSelect;

/** Языковая альтернатива автора: язык, слаг и имя на этом языке. */
export interface PublicAuthorTranslation {
  language: string;
  slug: string;
  name: string;
}

/**
 * Элемент публичного списка авторов. Ответ собирается только из этих полей —
 * перечислением, не спредом сущности (`B08`).
 */
export interface PublicAuthorListItem {
  id: string;
  slug: string;
  name: string;
  birthDate: string | null;
  deathDate: string | null;
  photoUrl: string | null;
  shortBio: string | null;
  booksCount: number;
  audioCount: number;
  translations: PublicAuthorTranslation[];
}
