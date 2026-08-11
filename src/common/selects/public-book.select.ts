import { Prisma } from '@prisma/client';

/**
 * Поля версии книги, которые можно показать анониму (`LEGACY-090`).
 *
 * 🔴 Причина существования этой константы — не аккуратность, а утечка. Публичные
 * маршруты тянули версии через `include` без выборки полей, и в ответе уезжала
 * **вся модель**: 66 полей, из которых 29 — внутренний правовой контур.
 * Замеры на живом API 10.08.2026 показали среди прочего:
 *
 * - `rightsPendingCountryCodes` — страны, где права ещё не подтверждены, при
 *   том что книга там показывается; для правообладателя это готовый материал;
 * - `rightsContentHashInput` — полный внутренний снимок контента;
 * - `rightsGeoBlockVerifiedByUserId` — кто из сотрудников проверял геоблок;
 * - `rightsStaleReasonRu`, `rightsGeoBlockNotesRu` — служебные заметки;
 * - `rightsRequiredActions` — правовые задачи с их статусами.
 *
 * ⚠️ Список **белый**, и это принципиально. Чёрный список («убрать поля на
 * `rights*`») пропустил бы следующее добавленное поле молча: новая колонка в
 * схеме попадала бы в публичный ответ сама, без единой строки кода и без
 * единого упавшего теста. Здесь новое поле не появится, пока его не впишут
 * сюда руками.
 */
export const PUBLIC_BOOK_VERSION_SELECT = {
  id: true,
  bookId: true,
  language: true,
  status: true,
  type: true,
  title: true,
  author: true,
  authorId: true,
  slug: true,
  coverImageUrl: true,
  coverAlt: true,
  description: true,
  shortDescription: true,
  isFree: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BookVersionSelect;

/**
 * Версия книги в том виде, в каком её видит анонимный посетитель.
 *
 * ⚠️ Использовать в сигнатурах публичных методов вместо `BookVersion`. Полный
 * тип модели там — не мелочь: он молча разрешает вернуть любое поле, и
 * компилятор не возразит, когда в выдачу снова заедет правовой контур.
 */
export type PublicBookVersion = Prisma.BookVersionGetPayload<{
  select: typeof PUBLIC_BOOK_VERSION_SELECT;
}>;

/**
 * Поля версии для страницы книги — `GET /books/:slug/overview` и её языковой
 * близнец `GET /:lang/books/:slug/overview`.
 *
 * 🔴 Эта константа появилась 11.08.2026, когда сверка выката нашла, что
 * `PUBLIC_BOOK_VERSION_SELECT` наложен не везде: `getOverview` продолжал грузить
 * версии голым `include` и отдавать модель целиком. Замер анонимного запроса —
 * **6.1 МБ, 66 полей на версию, 29 из них `rights*`**, включая
 * `rightsContentHashInput` на 1.18 МБ (`LEGACY-090`, `LEGACY-046`). Это самый
 * посещаемый публичный маршрут: фронт зовёт его на каждой отрисовке страницы
 * книги.
 *
 * ⚠️ Почему это отдельный список, а не общий `PUBLIC_BOOK_VERSION_SELECT`:
 * страница книги рендерит редакционную обвязку, которой нет в карточках, —
 * `themes`, `characters`, `quotes`, `faq`, `symbols`, `originalTitle`,
 * `alternativeTitles`. Наложить сюда карточный список означало бы вычистить со
 * страницы половину содержимого. Обратный ход — добавить эти поля в общий
 * список — раздул бы каждую карточку в каждом списке.
 *
 * ⚠️ Список остаётся **белым** по той же причине, что и карточный: чёрный
 * пропустил бы следующее добавленное в схему поле молча.
 */
export const PUBLIC_BOOK_VERSION_OVERVIEW_SELECT = {
  ...PUBLIC_BOOK_VERSION_SELECT,
  firstPublishedYear: true,
  editionPublishedYear: true,
  originalLanguage: true,
  originalTitle: true,
  copyrightStatus: true,
  authorPageUrl: true,
  alternativeTitles: true,
  characters: true,
  quotes: true,
  faq: true,
  themes: true,
  symbols: true,
} satisfies Prisma.BookVersionSelect;

/**
 * Поля книги-контейнера, которые можно показать анониму.
 *
 * 🔴 Добавлено после того, как e2e поймал недоделку: версии я закрыл, а сам
 * `Book` — нет, и наружу продолжали ехать `rightsIntakeId`,
 * `currentRightsProfileId`, `approvedRightsReviewId`, `rightsCreatedAt`. Та же
 * ошибка, что была с авторами: закрыть часть путей и счесть класс закрытым.
 *
 * ⚠️ Идентификаторы правовых сущностей выглядят безобидно — это «просто uuid».
 * Но по ним открываются правовые маршруты, и они же связывают книгу с
 * внутренним делом о правах; отдавать их анониму незачем.
 */
export const PUBLIC_BOOK_SELECT = {
  id: true,
  slug: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BookSelect;
