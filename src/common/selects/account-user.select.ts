import { Prisma } from '@prisma/client';

/**
 * Поля пользователя для собственного профиля и админского списка (`LEGACY-116`).
 *
 * 🔴 Причина существования константы — `passwordHash`. Чтения пользователя в
 * `users.service.ts` шли без `select` и без `omit`, поэтому argon2-хеш всегда
 * лежал в памяти и в объекте, который шёл дальше по коду. Наружу он не уходил
 * по единственной причине: каждый метод собирал ответ ручным перечислением
 * одиннадцати полей. Одна строка `return { ...u, roles }` в `list` — и хеши
 * всей страницы уезжают в админский ответ, а оттуда в логи и в кэш. Ни типы,
 * ни линт, ни тесты этого не ловили.
 *
 * ⚠️ Список **белый**, а не `omit: { passwordHash: true }`. `omit` пропустит
 * новую колонку схемы молча — тот же довод, что в комментарии к
 * `PUBLIC_BOOK_VERSION_SELECT`. Здесь новое поле не появится в ответе, пока его
 * не впишут сюда руками.
 *
 * 🔴 Это **не** публичный селект, и назван он так намеренно: внутри `email`.
 * Анониму пользователь отдаётся другим списком — `PUBLIC_COMMENT_USER_SELECT`
 * (`id`, `name`, `nickname`, `avatarUrl`), и почты там нет с 10.08.2026
 * (`LEGACY-089`). Этот список допустим только там, где пользователь смотрит на
 * себя (`/users/me`) или где маршрут закрыт `RolesGuard` (админский список).
 */
export const ACCOUNT_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  firstName: true,
  lastName: true,
  nickname: true,
  isActive: true,
  avatarUrl: true,
  languagePreference: true,
  createdAt: true,
  lastLogin: true,
} satisfies Prisma.UserSelect;

/**
 * Пользователь в том виде, в каком его отдают маршруты аккаунта.
 *
 * ⚠️ Использовать в сигнатурах вместо `User` и вместо `Omit<User, 'passwordHash'>`.
 * `Omit` выглядит барьером, но им не является: он ловит спред только там, где
 * им аннотирован возврат, а `findMany` не ограничивает никак — в `list` ответ
 * собирался литералом без аннотации вовсе.
 */
export type AccountUser = Prisma.UserGetPayload<{ select: typeof ACCOUNT_USER_SELECT }>;
