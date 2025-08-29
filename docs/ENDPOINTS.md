# API Endpoints Catalogue

Сборник всех доступных REST-эндпоинтов, сгруппированных по модулям и выстроенных в логической последовательности для поэтапного тестирования в Insomnia.

Легенда доступа:

- Public — без авторизации
- Auth — требуется JWT (Bearer)
- Roles — требуются роли: admin | content_manager (вместе с Auth)

Примечания:

- Параметры пагинации: page, limit (по умолчанию зависят от обработчика)
- Политика языка (мультисайт): публичные ручки используют префикс `/:lang` (en|fr|es|pt). Префикс имеет приоритет над `?lang` и `Accept-Language`.

- Базовый URL (dev): http://localhost:5000
- Глобальный префикс маршрутов: /api. В списке ниже пути указаны без префикса; реальный URL = /api + указанный путь (например, GET /auth/login ⇒ GET /api/auth/login). Для публичных ручек добавляется языковой префикс: `/api/:lang/...`.

---

## 1) [x] Auth

- POST /auth/register — Public — регистрация
  {
  "email": "user_1724745600@example.com",
  "password": "password123"
  }
- POST /auth/login — Public — вход
- POST /auth/refresh — Public — обновление токенов
- POST /auth/logout — Public — статeless заглушка

## 2) [x] Users

- GET /users/me — Auth — профиль текущего пользователя
  - Возвращает профиль + вычисленные роли (`roles: [user|admin|content_manager]`) — роли собираются из БД и ENV (ADMIN_EMAILS/CONTENT_MANAGER_EMAILS)
- PATCH /users/me — Auth — обновление профиля (name, avatarUrl, languagePreference)
- GET /users — Auth + Roles(admin) — список пользователей (пагинация: page, limit; поиск: q по email/name)
  - Фильтры: `q` — поиск по email/name; `staff=only|exclude` — выделить сотрудников (admin|content_manager) или исключить их
  - Каждый элемент включает те же поля, что и /users/me, плюс `roles` (вычисленные)
- GET /users/:id — Auth + Roles(admin) — получить пользователя по id
- DELETE /users/:id — Auth + Roles(admin) — удалить пользователя
- GET /users/:id/roles — Auth + Roles(admin) — список ролей пользователя
- POST /users/:id/roles/:role — Auth + Roles(admin) — выдать роль (user|admin|content_manager)
- DELETE /users/:id/roles/:role — Auth + Roles(admin) — отозвать роль

## 3) Uploads (raw файлы) ➜ Media

- POST /uploads/presign — Auth + Roles(admin|content_manager) — получить presign-токен для прямой загрузки
- POST /uploads/direct — Auth — прямая бинарная загрузка по токену (Rate-limit включён)
- POST /uploads/confirm?key=... — Auth + Roles(admin|content_manager) — подтверждение объекта, возврат publicUrl
- DELETE /uploads?key=... — Auth + Roles(admin|content_manager) — удалить объект по ключу

## 4) Media (повторное использование файлов)

- POST /media/confirm — Auth + Roles(admin|content_manager) — создать/обновить запись MediaAsset по key (идемпотентно)
- GET /media — Auth + Roles(admin|content_manager) — листинг (q, type, page, limit)
- DELETE /media/:id — Auth + Roles(admin|content_manager) — soft-delete записи и попытка удаления файла

## 5) Books

- POST /books — Auth + Roles(admin|content_manager) — создать книгу
- GET /:lang/books — Public — список книг (пагинация)
- GET /:lang/books/slug/:slug — Public — получить по slug
- GET /:lang/books/:id — Public — получить по id
- PATCH /books/:id — Auth + Roles(admin|content_manager) — обновить книгу
- DELETE /books/:id — Auth + Roles(admin|content_manager) — удалить книгу
- GET /:lang/books/:slug/overview — Public — обзор по slug (язык из префикса); показывает только опубликованные версии

## 6) Book Versions

- GET /:lang/books/:bookId/versions — Public — список опубликованных версий (язык из префикса); фильтры: language (опц., override), type, isFree
  - Примечание: includeDrafts=true — только для админов/контент-менеджеров (Auth + Roles), иначе игнорируется
- POST /books/:bookId/versions — Auth + Roles(admin|content_manager) — создать версию (draft)
- GET /admin/books/:bookId/versions — Auth + Roles(admin|content_manager) — админ-листинг (включая draft)
- GET /versions/:id — Public — получить версию (только published)
- PATCH /versions/:id — Auth + Roles(admin|content_manager) — обновить версию
- DELETE /versions/:id — Auth + Roles(admin|content_manager) — удалить версию (204)
- PATCH /versions/:id/publish — Auth + Roles(admin|content_manager) — опубликовать версию
- PATCH /versions/:id/unpublish — Auth + Roles(admin|content_manager) — снять с публикации (draft)

## 7) Chapters (текстовые главы)

- GET /versions/:bookVersionId/chapters — Public — список глав (пагинация)
- POST /versions/:bookVersionId/chapters — Auth + Roles(admin|content_manager) — создать главу
- GET /chapters/:id — Public — получить главу
- PATCH /chapters/:id — Auth + Roles(admin|content_manager) — обновить главу
- DELETE /chapters/:id — Auth + Roles(admin|content_manager) — удалить (204)

## 8) Audio Chapters (аудио-главы)

- GET /versions/:bookVersionId/audio-chapters — Public — список аудио-глав (пагинация)
- POST /versions/:bookVersionId/audio-chapters — Auth + Roles(admin|content_manager) — создать аудио-главу
- GET /audio-chapters/:id — Public — получить аудио-главу
- PATCH /audio-chapters/:id — Auth + Roles(admin|content_manager) — обновить аудио-главу
- DELETE /audio-chapters/:id — Auth + Roles(admin|content_manager) — удалить (204)

## 9) Book Summaries (пересказ/выжимка)

- GET /versions/:bookVersionId/summary — Public — получить пересказ версии (или null)
- PUT /versions/:bookVersionId/summary — Auth + Roles(admin|content_manager) — upsert пересказ

## 10) SEO

- GET /versions/:bookVersionId/seo — Public — получить SEO-мета (или null)
- PUT /versions/:bookVersionId/seo — Auth + Roles(admin|content_manager) — upsert SEO-мета
- GET /seo/resolve?type=book|version|page&id=... — Public — резолв SEO-бандла с фолбэками

## 11) Categories

Примечание i18n: публичные ручки используют переводы таксономий — поиск категории ведётся по паре `(language, slug)` из `CategoryTranslation`.

- GET /categories — Public — список (пагинация)
- GET /categories/tree — Public — полное дерево категорий
- GET /categories/:id/children — Public — прямые дети категории
- POST /categories — Auth + Roles(admin|content_manager) — создать категорию
- PATCH /categories/:id — Auth + Roles(admin|content_manager) — обновить категорию
- DELETE /categories/:id — Auth + Roles(admin|content_manager) — удалить (204); запрещено при наличии дочерних
- GET /:lang/categories/:slug/books — Public — версии по слагу категории (язык из префикса); ответ включает availableLanguages
- POST /versions/:id/categories — Auth + Roles(admin|content_manager) — привязать категорию к версии
- DELETE /versions/:id/categories/:categoryId — Auth + Roles(admin|content_manager) — отвязать (204)

## 12) Tags

Примечание i18n: публичные ручки используют переводы таксономий — поиск тега ведётся по паре `(language, slug)` из `TagTranslation`.

- GET /tags — Public — список (пагинация)
- POST /tags — Auth + Roles(admin|content_manager) — создать тег
- PATCH /tags/:id — Auth + Roles(admin|content_manager) — обновить тег
- DELETE /tags/:id — Auth + Roles(admin|content_manager) — удалить (204)
- GET /:lang/tags/:slug/books — Public — версии по слагу тега (язык из префикса); ответ включает availableLanguages
- POST /versions/:id/tags — Auth + Roles(admin|content_manager) — привязать тег к версии
- DELETE /versions/:id/tags/:tagId — Auth + Roles(admin|content_manager) — отвязать (204)

## 13) Bookshelf (полка пользователя)

- GET /me/bookshelf — Auth — список моих версий (пагинация)
- POST /me/bookshelf/:versionId — Auth — добавить версию
- DELETE /me/bookshelf/:versionId — Auth — удалить (204); идемпотентно

## 14) Reading Progress (прогресс чтения/прослушивания)

- GET /me/progress/:versionId — Auth — получить мой прогресс по версии
- PUT /me/progress/:versionId — Auth — upsert прогресса (chapterNumber|audioChapterNumber, position)

## 15) Comments

- GET /comments?target=version|chapter|audio&targetId=...&page&limit — Public — список комментариев
- POST /comments — Auth — создать комментарий (Rate-limit)
- GET /comments/:id — Public — получить комментарий
- PATCH /comments/:id — Auth — обновить (Rate-limit; владелец может редактировать текст; модераторы — скрывать/раскрывать)
- DELETE /comments/:id — Auth — soft-delete (204; Rate-limit)

## 16) Likes

- POST /likes — Auth — поставить лайк (ровно один target: commentId | bookVersionId)
- DELETE /likes — Auth — убрать лайк (204; идемпотентно)
- GET /likes/count?target=comment|bookVersion&targetId=... — Public — счетчик лайков
- PATCH /likes/toggle — Auth — переключить лайк; возвращает текущее состояние и count

## 17) View Stats (просмотры)

- POST /views — Public (Rate-limit) — записать просмотр (userId опционален)
- GET /views/aggregate?versionId=...&period=day|week|month|all&from&to&source — Public — агрегация по дням
- GET /views/top?period=...&limit&source — Public — топ просматриваемых версий за период

## 18) Pages (CMS)

- GET /:lang/pages/:slug — Public — публичная страница (только published; язык из префикса)
- GET /admin/pages — Auth + Roles(admin|content_manager) — листинг страниц (draft+published)
- POST /admin/pages — Auth + Roles(admin|content_manager) — создать страницу
- PATCH /admin/pages/:id — Auth + Roles(admin|content_manager) — обновить
- DELETE /admin/pages/:id — Auth + Roles(admin|content_manager) — удалить (204)
- PATCH /admin/pages/:id/publish — Auth + Roles(admin|content_manager) — опубликовать
- PATCH /admin/pages/:id/unpublish — Auth + Roles(admin|content_manager) — снять с публикации

## 19) Status (админ)

- GET /status/rate-limit — Auth + Roles(admin) — текущая конфигурация rate limit

## 20) Root

- GET / — Public — health-заглушка (getHello)

---

## Рекомендуемый порядок тестирования в Insomnia

1. Auth → Users (me/roles) — получить токены, проверить профиль и роли
2. Uploads → Media — загрузка и подтверждение медиа-объектов
3. Books → Book Versions → Chapters → Audio Chapters — создание контента, публикация
4. Book Summaries → SEO (upsert) → SEO Resolve — метаданные и SEO-бандл
5. Categories → Tags — CRUD и привязка к версиям; публичные ручки по slug (+политика языка)
6. Pages — админ CRUD и публичная выдача published
7. Bookshelf → Reading Progress — пользовательские данные
8. Comments → Likes — социальные взаимодействия (в т.ч. rate-limit)
9. View Stats — запись и агрегация просмотров
10. Status — админ-инфо по rate limit
11. Root — простой smoke

Hint: для ручек с поддержкой языка приоритет ?lang над Accept-Language; затем фолбэк на DEFAULT_LANGUAGE; если ни один недоступен — берётся первый доступный.
