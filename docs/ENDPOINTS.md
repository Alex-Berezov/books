# API Endpoints Catalogue

Сборник всех доступных REST-эндпоинтов, сгруппированных по модулям и выстроенных в логической последовательности для поэтапного тестирования в Insomnia.

Легенда доступа:

- Public — без авторизации
- Auth — требуется JWT (Bearer)
- Roles — требуются роли: admin | content_manager (вместе с Auth)

Примечания:

- Параметры пагинации: page, limit (по умолчанию зависят от обработчика)
- Политика языка (мультисайт): публичные ручки используют префикс `/:lang` (en|fr|es|pt). Префикс имеет приоритет над `?lang` и `Accept-Language`.
- Совместимость: для категорий и тегов (а также страниц) сохранены legacy-маршруты без `/:lang` для обратной совместимости; они принимают `?lang` и/или заголовок `Accept-Language` для выбора языка.

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

Примечание i18n (совет): на экранах авторизации/регистрации UI передаёт текущий язык заголовком `Accept-Language` и параметром `redirect=/:lang/...` для возврата после входа. Самих `/:lang` префиксов в путях auth нет.

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

## 3) [x] Uploads (raw файлы) ➜ Media

- POST /uploads/presign — Auth + Roles(admin|content_manager) — получить presign-токен для прямой загрузки
- POST /uploads/direct — Auth — прямая бинарная загрузка по токену (Rate-limit включён)
- POST /uploads/confirm?key=... — Auth + Roles(admin|content_manager) — подтверждение объекта, возврат publicUrl
- DELETE /uploads?key=... — Auth + Roles(admin|content_manager) — удалить объект по ключу

## 4) [x] Media (повторное использование файлов)

- POST /media/upload — Auth + Roles(admin|content_manager) — ОДНИМ запросом загрузить файл (multipart/form-data) и зафиксировать его в медиа-библиотеке (внутри: presign → direct → media.confirm); ответ: MediaAsset
- POST /media/confirm — Auth + Roles(admin|content_manager) — создать/обновить запись MediaAsset по key (идемпотентно)
- GET /media — Auth + Roles(admin|content_manager) — листинг (q, type, page, limit)
- DELETE /media/:id — Auth + Roles(admin|content_manager) — soft-delete записи и попытка удаления файла

## 5) [x] Books

- POST /books — Auth + Roles(admin|content_manager) — создать книгу
- GET /books — Public — список книг (пагинация)
- GET /books/slug/:slug — Public — получить по slug
- GET /books/:id — Public — получить по id
- PATCH /books/:id — Auth + Roles(admin|content_manager) — обновить книгу
- DELETE /books/:id — Auth + Roles(admin|content_manager) — удалить книгу
- GET /:lang/books/:slug/overview — Public — обзор по slug (язык из префикса); показывает только опубликованные версии

Примечание SEO/i18n:

- Канонический публичный URL книги — `/:lang/books/:slug` (overview-страница). Списки и lookup контейнера (`/books`, `/books/slug/:slug`, `/books/:id`) остаются нейтральными по языку и не включаются в sitemap.

## 6) [x] Book Versions

**⚠️ ВАЖНО: Public vs Admin endpoints**

Версии книг имеют два набора endpoints:

- **Public** (`/api/versions/{id}`) — возвращает ТОЛЬКО опубликованные версии (`status: 'published'`)
- **Admin** (`/api/admin/versions/{id}`) — возвращает версии в ЛЮБОМ статусе (`draft`, `published`)

**Для админ-панели используйте ТОЛЬКО admin endpoints!**

См. подробную документацию: [`docs/FIX_BOOK_VERSION_404.md`](FIX_BOOK_VERSION_404.md)

### Public Endpoints (только published)

- GET /books/:bookId/versions — Public — список опубликованных версий (фильтры: language (опц., override), type, isFree; при отсутствии language используется Accept-Language)
- **GET /versions/:id** — Public — **получить версию (ТОЛЬКО published)**

### Admin Endpoints (любой статус: draft/published)

- POST /books/:bookId/versions — Auth + Roles(admin|content_manager) — создать версию (draft)
- POST /admin/:lang/books/:bookId/versions — Auth + Roles(admin|content_manager) — создать версию в выбранном админ-языке (заголовок X-Admin-Language приоритетнее языка пути)
- GET /admin/:lang/books/:bookId/versions — Auth + Roles(admin|content_manager) — админ-листинг (включая draft; по умолчанию фильтрует по эффективному админ-языку, можно переопределить ?language)
- **GET /admin/versions/:id** — Auth + Roles(admin|content_manager) — **получить версию (ЛЮБОЙ статус: draft/published)**
- PATCH /versions/:id — Auth + Roles(admin|content_manager) — обновить версию
- DELETE /versions/:id — Auth + Roles(admin|content_manager) — удалить версию (204)
- PATCH /versions/:id/publish — Auth + Roles(admin|content_manager) — опубликовать версию
- PATCH /versions/:id/unpublish — Auth + Roles(admin|content_manager) — снять с публикации (draft)

**⚠️ Типичная ошибка:**

```typescript
// ❌ НЕПРАВИЛЬНО для админ-панели
GET / api / versions / { id }; // Возвращает 404 для черновиков!

// ✅ ПРАВИЛЬНО для админ-панели
GET / api / admin / versions / { id }; // Возвращает любой статус
```

## 7) [x] Chapters (текстовые главы)

- GET /versions/:bookVersionId/chapters — Public — список глав (пагинация)
- POST /versions/:bookVersionId/chapters — Auth + Roles(admin|content_manager) — создать главу
- GET /chapters/:id — Public — получить главу
- PATCH /chapters/:id — Auth + Roles(admin|content_manager) — обновить главу
- DELETE /chapters/:id — Auth + Roles(admin|content_manager) — удалить (204)

## 8) [x] Audio Chapters (аудио-главы)

- GET /versions/:bookVersionId/audio-chapters — Public — список аудио-глав (пагинация)
- POST /versions/:bookVersionId/audio-chapters — Auth + Roles(admin|content_manager) — создать аудио-главу
- GET /audio-chapters/:id — Public — получить аудио-главу
- PATCH /audio-chapters/:id — Auth + Roles(admin|content_manager) — обновить аудио-главу
- DELETE /audio-chapters/:id — Auth + Roles(admin|content_manager) — удалить (204)

## 9) [x] Book Summaries (пересказ/выжимка)

- GET /versions/:bookVersionId/summary — Public — получить пересказ версии (или null)
- PUT /versions/:bookVersionId/summary — Auth + Roles(admin|content_manager) — upsert пересказ

## 10) [x] SEO

- GET /versions/:bookVersionId/seo — Public — получить SEO-мета (или null)
- PUT /versions/:bookVersionId/seo — Auth + Roles(admin|content_manager) — upsert SEO-мета
- GET /seo/resolve?type=book|version|page&id=... — Public — резолв SEO-бандла с фолбэками
  - Параметры i18n: `lang` (query), `Accept-Language` (header); для book/page канонический URL включает префикс языка
  - Приоритет: `:lang` в пути (см. ниже) > `lang` в query > `Accept-Language` > DEFAULT_LANGUAGE
- GET /:lang/seo/resolve?type=book|version|page&id=... — Public — i18n-резолв SEO с префиксом языка (приоритетнее query/header)
  - Для `type=version` канонический URL всегда без префикса: `/versions/:id`
  - Для `type=book` | `page` канонический URL включает префикс: `/:lang/books/:slug` | `/:lang/pages/:slug`
  - Дополнительно: для `type=book` ответ включает `breadcrumbPath` (если есть привязанные категории у выбранной версии) — массив от корня до родителя категории: `[{ id, slug, name }]`

### 10.2) [x] SEO i18n рекомендации (для фронта/генераторов)

- Hreflang-кластер на каждой языковой странице: `<link rel="alternate" hreflang="en|fr|es|pt|x-default" href="..."/>` — ссылки на все доступные языковые URL книги/страницы + x-default.
- Self-canonical: у каждой языковой версии свой канонический URL (включая `/:lang`). Для версий книг — каноникалы без префикса (`/versions/:id`).
- Заголовок `Content-Language: <lang>` для публичных страниц.
- Карты сайта: в `/sitemap-:lang.xml` и/или через расширение `xhtml:link` указывать alternates для связанного URL на других языках.
- Тех/нейтральные ручки не индексировать (по месту, например, через meta robots или X-Robots-Tag) и не включать в sitemap (версии уже исключены).

## 10.1) [x] Sitemap/Robots (i18n)

- GET /sitemap.xml — Public — индекс с картами сайта по каждому языку (`/sitemap-en.xml`, `/sitemap-es.xml`, ...)
- GET /sitemap-:lang.xml — Public — карта сайта для конкретного языка; URL содержат языковой префикс `/:lang`
- GET /robots.txt — Public — базовый robots с ссылкой на `/sitemap.xml`

Примечания:

- Источник базового публичного адреса берётся из `LOCAL_PUBLIC_BASE_URL` (env), по умолчанию `http://localhost:3000`.
- В sitemap включены опубликованные страницы (`Page.status=published`) и книги (канонические URL книг на основе опубликованных версий по языку). Версии (`/versions/:id`) в sitemap не включаются.

## 11) [x] Categories

Примечание i18n: публичные ручки используют переводы таксономий — поиск категории ведётся по паре `(language, slug)` из `CategoryTranslation`.

- GET /categories — Public — список (пагинация)
- GET /categories/tree — Public — полное дерево категорий
- GET /categories/:id/children — Public — прямые дети категории
- GET /categories/:id/ancestors — Public — предки категории от корня до родителя (для хлебных крошек)
- POST /categories — Auth + Roles(admin|content_manager) — создать категорию (базовую)
- PATCH /categories/:id — Auth + Roles(admin|content_manager) — обновить категорию (базовую)
- DELETE /categories/:id — Auth + Roles(admin|content_manager) — удалить (204); запрещено при наличии дочерних
- GET /:lang/categories/:slug/books — Public — версии по слагу перевода категории (язык из префикса); ответ включает availableLanguages
- GET /categories/:slug/books — Public — legacy-маршрут без префикса языка; язык выбирается по `?lang` (приоритетнее) или `Accept-Language`; ответ включает availableLanguages
- POST /versions/:id/categories — Auth + Roles(admin|content_manager) — привязать категорию к версии
- DELETE /versions/:id/categories/:categoryId — Auth + Roles(admin|content_manager) — отвязать (204)
- GET /categories/:id/translations — Auth + Roles(admin|content_manager) — список переводов
- POST /categories/:id/translations — Auth + Roles(admin|content_manager) — создать перевод
- PATCH /categories/:id/translations/:language — Auth + Roles(admin|content_manager) — обновить перевод
- DELETE /categories/:id/translations/:language — Auth + Roles(admin|content_manager) — удалить перевод (204)

## 12) [x] Tags

Примечание i18n: публичные ручки используют переводы таксономий — поиск тега ведётся по паре `(language, slug)` из `TagTranslation`.

- GET /tags — Public — список (пагинация)
- POST /tags — Auth + Roles(admin|content_manager) — создать тег (базовый)
- PATCH /tags/:id — Auth + Roles(admin|content_manager) — обновить тег (базовый)
- DELETE /tags/:id — Auth + Roles(admin|content_manager) — удалить (204)
- GET /:lang/tags/:slug/books — Public — версии по слагу перевода тега (язык из префикса); ответ включает availableLanguages
- GET /tags/:slug/books — Public — legacy-маршрут без префикса языка; язык выбирается по `?lang` (приоритетнее) или `Accept-Language`; ответ включает availableLanguages
- POST /versions/:id/tags — Auth + Roles(admin|content_manager) — привязать тег к версии
- DELETE /versions/:id/tags/:tagId — Auth + Roles(admin|content_manager) — отвязать (204)
- GET /tags/:id/translations — Auth + Roles(admin|content_manager) — список переводов
- POST /tags/:id/translations — Auth + Roles(admin|content_manager) — создать перевод
- PATCH /tags/:id/translations/:language — Auth + Roles(admin|content_manager) — обновить перевод
- DELETE /tags/:id/translations/:language — Auth + Roles(admin|content_manager) — удалить перевод (204)

## 13) [x] Bookshelf (полка пользователя)

- GET /me/bookshelf — Auth — список моих версий (пагинация)
- POST /me/bookshelf/:versionId — Auth — добавить версию
- DELETE /me/bookshelf/:versionId — Auth — удалить (204); идемпотентно

## 14) [x] Reading Progress (прогресс чтения/прослушивания)

- GET /me/progress/:versionId — Auth — получить мой прогресс по версии
- PUT /me/progress/:versionId — Auth — upsert прогресса (chapterNumber|audioChapterNumber, position)

## 15) [x] Comments

- GET /comments?target=version|chapter|audio&targetId=...&page&limit — Public — список комментариев
- POST /comments — Auth — создать комментарий (Rate-limit)
  Body: ровно одно из полей цели обязательно (XOR): bookVersionId | chapterId | audioChapterId. Для ответа на комментарий используйте parentId (опционально).

  Примеры:

  Комментарий к версии:
  {
  "bookVersionId": "{{ versionId }}",
  "text": "Отличная книга!"
  }

## 16) [x] Queues (BullMQ) — admin only

- GET /queues/status — Auth + Roles(admin) — статус подсистемы очередей (enabled)
- GET /queues/demo/stats — Auth + Roles(admin) — счётчики demo-очереди
- POST /queues/demo/enqueue — Auth + Roles(admin) — добавить демо-задачу `{ delayMs?: number }`

Примечания по очередям и безопасности:

- Доступ к админ-ручкам обеспечивается комбинацией `JwtAuthGuard` + `RolesGuard`. Оба гварда предоставляются глобальным `SecurityModule` и подключаются на контроллерах через `@UseGuards`.
- Воркер может работать in‑process или отдельно: переключение через `BULLMQ_IN_PROCESS_WORKER=0|1`. Отдельный процесс воркера запускается командой `yarn worker:demo`.
- Конфигурация воркера: `BULLMQ_WORKER_LOG_LEVEL` (debug|info|warn|error) и `BULLMQ_WORKER_SHUTDOWN_TIMEOUT_MS` для graceful shutdown.

  Комментарий к главе:
  {
  "chapterId": "{{ chapterId }}",
  "text": "Полезная глава."
  }

  Комментарий к аудио‑главе:
  {
  "audioChapterId": "{{ audioChapterId }}",
  "text": "Классная озвучка!"
  }

  Ответ на комментарий (reply) к версии:
  {
  "bookVersionId": "{{ versionId }}",
  "parentId": "{{ commentId }}",
  "text": "Согласен!"
  }

  Замечание: поля target и targetId не поддерживаются — используйте конкретные _\_Id поля как выше. При передаче более одного целевого _\_Id вернётся 400 (ровно одно должно быть задано).

- GET /comments/:id — Public — получить комментарий
- PATCH /comments/:id — Auth — обновить (Rate-limit; владелец может редактировать текст; модераторы — скрывать/раскрывать)
  Примеры:

  Обновление текста (только владелец):
  {
  "text": "Обновлённый текст комментария"
  }

  Скрыть/раскрыть (только модератор admin|content_manager):
  {
  "isHidden": true
  }

- DELETE /comments/:id — Auth — soft-delete (204; Rate-limit)

## 16) [x] Likes

- POST /likes — Auth — поставить лайк (ровно один target: commentId | bookVersionId)
- DELETE /likes — Auth — убрать лайк (204; идемпотентно)
- GET /likes/count?target=comment|bookVersion&targetId=... — Public — счетчик лайков
- PATCH /likes/toggle — Auth — переключить лайк; возвращает текущее состояние и count

## 17) View Stats (просмотры)

- POST /views — Public (Rate-limit) — записать просмотр (userId опционален)
- GET /views/aggregate?versionId=...&period=day|week|month|all&from&to&source — Public — агрегация по дням
- GET /views/top?period=...&limit&source — Public — топ просматриваемых версий за период

## 18) [x] Pages (CMS)

- GET /:lang/pages/:slug — Public — публичная страница (только published; язык из префикса)
- GET /pages/:slug — Public — legacy-маршрут без префикса; язык выбирается по ?lang (приоритетнее) или Accept-Language
- GET /admin/:lang/pages — Auth + Roles(admin|content_manager) — листинг страниц (draft+published; эффективный язык берётся из X-Admin-Language, иначе из :lang)
- POST /admin/:lang/pages — Auth + Roles(admin|content_manager) — создать страницу (язык берётся из админ-контекста; поле language в DTO игнорируется)
- PATCH /admin/:lang/pages/:id — Auth + Roles(admin|content_manager) — обновить
- DELETE /admin/:lang/pages/:id — Auth + Roles(admin|content_manager) — удалить (204)
- PATCH /admin/:lang/pages/:id/publish — Auth + Roles(admin|content_manager) — опубликовать
- PATCH /admin/:lang/pages/:id/unpublish — Auth + Roles(admin|content_manager) — снять с публикации

Примечание SEO (legacy):

- В проде для `GET /pages/:slug` (без префикса) рекомендуется `noindex` или `rel=canonical` на соответствующий `/:lang/pages/:slug`, чтобы поисковики индексировали i18n-страницы и не конкурировали с legacy-URL.

## 19) [x] Status (админ)

- GET /status/rate-limit — Auth + Roles(admin) — текущая конфигурация rate limit
- POST /status/sentry-test — Auth + Roles(admin) — сгенерировать тестовую 500‑ошибку; при включённом Sentry (см. env SENTRY_DSN) событие улетит в Sentry

## 20) [x] Root / Health

- GET / — Public — редирект на Swagger UI (`/api/docs`) — удобно для прод/стейджа
- GET /health — Public — health JSON
  {
  "status": "ok",
  "uptime": 12.34,
  "timestamp": "2025-09-04T12:34:56.789Z"
  }

Дополнительно (Terminus-like):

- GET /health/liveness — Public — статус процесса (без внешних зависимостей)
- GET /health/readiness — Public — готовность внешних зависимостей (Prisma + Redis опц.)
  {
  "status": "up|down",
  "details": {
  "prisma": "up|down",
  "redis": "up|down|skipped"
  }
  }

---

## Рекомендуемый порядок тестирования в Insomnia

1. Auth → Users (me/roles) — получить токены, проверить профиль и роли
2. Uploads → Media — загрузка и подтверждение медиа-объектов
3. Books → Book Versions → Chapters → Audio Chapters — создание контента, публикация
4. Book Summaries → SEO (upsert) → SEO Resolve — метаданные и SEO-бандл
5. Categories → Tags — CRUD и привязка к версиям; публичные ручки по slug (+политика языка)
6. Pages — админ CRUD (через /admin/:lang и X-Admin-Language) и публичная выдача published (в т.ч. legacy /pages/:slug)
7. Bookshelf → Reading Progress — пользовательские данные
8. Comments → Likes — социальные взаимодействия (в т.ч. rate-limit)
9. View Stats — запись и агрегация просмотров
10. Status — админ-инфо по rate limit
11. Root — простой smoke

Hint: для ручек с поддержкой языка приоритет ?lang над Accept-Language; затем фолбэк на DEFAULT_LANGUAGE; если ни один недоступен — берётся первый доступный.
