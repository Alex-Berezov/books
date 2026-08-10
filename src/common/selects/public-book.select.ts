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
