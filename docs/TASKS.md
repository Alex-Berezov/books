# План работ для backend (от текущего состояния до продакшена)

### Легенда статусов и метаданные

- [ ] — запланировано
- [x] — сделано
- [WIP] — выполняется
- [BLOCKED: причина] — заблокировано

Метаданные (опционально) после пункта: PR #, commit, дата, assignee, миграция (да/нет).

## 0. Текущее состояние (готово)

- NestJS приложение, базовый модуль Books с CRUD-эндпоинтами.
- Prisma ORM, схема с сущностями (Book, BookVersion, Chapter, AudioChapter, User, Bookshelf, Comment, Like, Category, ViewStat, ReadingProgress, Seo).
- Валидация slug (строгий regex), DTO, глобальный ValidationPipe.
- Swagger (OpenAPI) подключён, базовые примеры.
- Seeds: базовые категории и пример книги/версии, Prisma Studio.
- ESLint/Prettier настроены, базовые e2e тесты.

---

См. также: подробный итерационный план с краткими ТЗ — файл `docs/ITERATION_TASKS.md`.

## 1. Инфраструктура разработки и стандарты

- Добавить Husky + lint-staged, pre-commit: lint, format, typecheck, test:unit быстр.
- В .vscode/tasks.json: задачи для lint/test/migrate/seed/dev.
- Обновить README: сценарии запуска, переменные, миграции, тесты, Studio.
- В docs/AGENT_CONTEXT.md: правила для агента, договорённости по стилю/кодогенерации.

## 2. Локальная среда и базы данных

- Docker Compose для: PostgreSQL, Redis (dev). Переменные в .env/.env.example.
- Проверить индексы/уникальные ограничения в Prisma:
  - BookVersion: уникальность (bookId, language).
  - Seo: 1:1 c BookVersion через уникальный внешний ключ.
- Генерация и применение миграций; обновление сидов под новые ограничения.

## 3. Модуль Пользователи и аутентификация

- Регистрация/логин, хэш паролей (argon2), валидации, e2e.
- JWT (access/refresh), Passport JWT, guards, декораторы CurrentUser.
- Роли (user/admin), RoleGuard, примеры защищённых эндпоинтов.
- Документация в Swagger, негативные тесты (403/401).

## 4. Контент: книги и версии (расширение домена)

- DTO/валидаторы для: BookVersion, Chapter, AudioChapter, BookSummary, Seo.
- Эндпоинты:
  - Получение книги по slug + список доступных языков (версий).
  - Управление SEO (1:1 с версией): чтение/обновление.
- Обновить Swagger примерами и схемами.
- Юнит и e2e тесты для основных сценариев.

## 5. Книгохранилище, лайки, комментарии

- Bookshelf: добавить/удалить версию книги в полку пользователя; список полки.
- Likes: лайк на комментарий или на версию книги (взаимоисключающие поля); счётчики.
- Comments: древовидные ответы, пагинация, модерация (soft-delete/hidden), e2e.
- Ограничения/индексы, сиды примеров, Swagger.

## 6. Прогресс чтения и статистика просмотров

- ReadingProgress: апи update/get, поддержка текста и аудио (позиция/номер главы).
- ViewStat: middleware/интерсептор для фиксации источника (text/audio/referral), async запись.
- Агрегаты: просмотры по книге/версии, top N за период. Кэширование в Redis.
- Тесты производности (минимум e2e на happy-path + агрегаты).

## 7. Хранилище файлов (S3-совместимое)

- Конфиг клиента S3, загрузки обложек/медиа через pre-signed URLs.
- Настройка CORS, валидация content-type/размера.
- Ссылки/метаданные в БД (coverImageUrl/audioUrl), ротация/удаление.
- Документация по загрузке для фронтенда.

## 8. Очереди и фоновые задачи (BullMQ)

- Подключить BullMQ к Redis, выделить очередь для долгих задач (обработка аудио/изображений, генерация превью).
- Воркеры, ретраи, dead-letter queue, health endpoints.
- Метрики по очередям.

## 9. Международизация и SEO

- Политика выбора версии по языку: header/param, фолбэк.
- Canonical/og/twitter мета через Seo модель; правила генерации slug и canonical.
- Sitemap, robots.txt (отдача через gateway/Nginx, но генерация на бэке).

## 10. Безопасность и продвинутый runtime

- CORS, Helmet, rate limiting, body size limits.
- Логирование (pino) + request-id, маскирование секретов.
- Healthchecks/Readiness (nestjs/terminus), Prometheus метрики.
- Sentry для ошибок.

## 11. Тестирование и качество

- Unit тесты сервисов + мок Prisma (или тестовый контейнер).
- E2E в изолированной тест-БД (docker), миграции перед ранном, сиды для тестов.
- Покрытие и пороги, быстрый smoke suite для CI.

## 12. CI/CD

- GitHub Actions: матрица задач — lint, typecheck, unit, e2e (docker services), build, prisma validate.
- Артефакты: docker build + push в реестр (GHCR/DOCR).
- Авто-генерация OpenAPI спеков и публикация артефакта.

## 13. Деплой

- Dockerfile(prod) + multi-stage build.
- docker-compose.prod.yml (API + Postgres + Redis + Nginx) или Kubernetes манифесты.
- Миграции на старте контейнера: `prisma migrate deploy`.
- Менеджер процессов (systemd/PM2) при bare-metal.
- SSL (Let’s Encrypt), обратный прокси, сжатие, кэш статик.
- Переменные окружения, секреты, ротация ключей.

## 14. Наблюдаемость и эксплуатация

- Дашборды: Grafana/Prometheus, алерты.
- Логи: агрегирование (Loki/ELK), алерты по ошибкам.
- Бэкапы БД/файлов, процедуры восстановления.

## 15. Пост-MVP улучшения

- Реферальные ссылки (Amazon): валидация, UTM-трекинг, отчёты по конверсиям.
- Роли редакторов/модераторов, админ-панель (отдельный фронт).
- Квоты, антиспам для комментариев, модерирование контента.

---

### Примечания

- Все новые ограничения в Prisma — через миграции и обновлённые сиды.
- Для публичных эндпоинтов — кэш в Redis и инвалидация после изменений.
- Для всех эндпоинтов — полные описания в Swagger с примерами и схемами.

— Кэш и рейт-лимит (архитектурное решение)

- На нулевом этапе Redis не подключаем. В проекте введены абстракции:
  - CacheService (дефолт: in-memory), модуль `CacheModule`.
  - RateLimiter (дефолт: in-memory), модуль `RateLimitModule`. Глобально выключен флагом `RATE_LIMIT_ENABLED`.
- Переключение на Redis в будущем — через замену провайдеров этих токенов и включение флагов в .env.
- До появления трафика полагаемся на индексы БД, корректные ответы кэша браузера/CDN и инвалидацию на уровне приложения.

---

## Приложение A. Бэклог модулей по сущностям (NestJS + Prisma)

Ниже — конкретные задачи по созданию модулей. Для каждого: controller + service + module, DTO/валидаторы, Swagger, guards, unit/e2e, и интеграция с Prisma. Все роуты RESTful, ответы — DTO, пагинация через общий PaginationDto.

- [x] 1. UsersModule — каркас, эндпоинты me/update-me, временная авторизация через JwtAuthGuard
  - [x] Ответственность: профиль, предпочтения языка, аватар
  - [x] Эндпоинты: GET /users/me, PATCH /users/me, GET /users/:id (admin), DELETE /users/:id (admin)
  - [x] Валидация: email уникален, name длина, avatarUrl URL
  - [x] Безопасность: JWT Guard; RolesGuard для admin-роутов
  - [x] Тесты: доступ/запрет, обновление профиля

- [x] 1a. UsersModule — роли и права (расширение)
  - [x] Роли: admin, content_manager, user (enum + хранение/проверка)
  - [x] Политика: управление контентом (chapters/versions) доступно admin|content_manager
  - [x] Источник ролей: хранение в БД + фолбэк по переменным окружения (ADMIN_EMAILS, CONTENT_MANAGER_EMAILS)
  - [x] Guards/Decorators: Roles, RolesGuard обновлён — читает роли из БД
  - [x] Swagger: базовое описание ролей через декоратор Roles
  - [x] Тесты: e2e на доступ/запрет (401/403), управление ролями (assign/revoke)

- [x] 2. AuthModule — готово
  - [x] Унификация DTO между контроллером и сервисом (используем Prisma $Enums.Language в DTO)
  - [x] Эндпоинты: POST /auth/register, POST /auth/login
  - [x] Эндпоинты: POST /auth/refresh, POST /auth/logout
  - [x] Секреты/TTL для access/refresh через переменные окружения (.env/.env.example)
  - [x] Swagger: описать DTO/ответы, примеры
  - [x] Роли и guard (admin) — базовая реализация через ADMIN_EMAILS (env)
  - [x] e2e тесты: register/login/refresh

- [x] 3. BooksModule — готово
- Расширить: поиск по slug, списки с фильтрами, связка с версиями.

- [x] 4. BookVersionsModule — базовая реализация
  - [x] Каркас: controller / service / module
  - [x] DTO + валидация (Language, BookType, boolean isFree, Url поля, optional SEO metaTitle/metaDescription)
  - [x] Swagger (tag, операции, query params) + расширенный (ответные DTO, seo fragment)
  - [x] Эндпоинты: GET /books/:bookId/versions, POST /books/:bookId/versions, GET /versions/:id, PATCH /versions/:id, DELETE /versions/:id
  - [x] Фильтры: language, type, isFree + сортировка createdAt desc
  - [x] Транзакция: создание версии + опциональный Seo (атомарно)
  - [x] e2e тесты: CRUD + проверка уникальности (кодовый пре-чек)
    - [x] Уникальность (bookId, language) на уровне БД — cleanup + миграция применены (`cleanup-duplicate-book-versions.ts` + reset)
    - [x] Индекс (bookId, language, type, isFree) — создан миграцией `20250812142005_add_book_version_constraints`
    - [x] Скрипт очистки дубликатов добавлен: `prisma/scripts/cleanup-duplicate-book-versions.ts` (dry-run / APPLY=1)
  - [x] Расширенный Swagger (ответные схемы моделей) — готово
  - [x] Unit тесты сервиса (моки Prisma) — готово (`book-version.service.spec.ts`)

- [x] 5. ChaptersModule — готово
  - [x] Каркас: controller / service / module
  - [x] DTO + валидация (number >= 1, title, content)
  - [x] Эндпоинты: GET /versions/:bookVersionId/chapters, GET /chapters/:id, POST /versions/:bookVersionId/chapters, PATCH /chapters/:id, DELETE /chapters/:id
  - [x] Ограничения: уникальность (bookVersionId, number) — добавлен индекс в Prisma + миграция
  - [x] Swagger теги/описания
  - [x] Unit тесты сервиса (моки Prisma)
  - [ ] Массовые операции: bulk upsert/ре-нумерация — отложено

- [x] 6. AudioChaptersModule — готово
  - [x] Каркас: controller / service / module
  - [x] DTO + валидация (number >= 1, title, audioUrl, duration)
  - [x] Эндпоинты: GET /versions/:bookVersionId/audio-chapters, GET /audio-chapters/:id, POST /versions/:bookVersionId/audio-chapters, PATCH /audio-chapters/:id, DELETE /audio-chapters/:id
  - [x] Ограничения: уникальность (bookVersionId, number) — добавлен индекс в Prisma + миграция
  - [x] Swagger теги/описания
  - [x] RBAC: создание/изменение/удаление — только admin|content_manager (JwtAuthGuard + RolesGuard)
  - [x] e2e тесты: CRUD + пагинация + запреты (401/403) + проверка уникальности

- [x] 7. BookSummariesModule — готово
  - [x] Каркас: controller / service / module
  - [x] DTO + валидация: summary (required), analysis/themes (optional)
  - [x] Эндпоинты: GET /versions/:bookVersionId/summary, PUT /versions/:bookVersionId/summary (upsert)
  - [x] Политика: 1 summary на версию (upsert через findFirst+create/update)
  - [x] RBAC: PUT — только admin|content_manager
  - [x] e2e тесты: GET пусто, запреты (401/403), upsert, повторный GET

- [x] 8. SeoModule — готово
  - [x] Каркас: controller / service / module
  - [x] DTO + валидация (все поля опциональны; URL/ISO8601 проверяются)
  - [x] Эндпоинты: GET /versions/:bookVersionId/seo, PUT /versions/:bookVersionId/seo (upsert)
  - [x] Ограничения: 1:1 через уникальный fk в BookVersion (seoId) — схема уже включает @unique
  - [x] Swagger теги/описания
  - [x] RBAC: PUT — только admin|content_manager (JwtAuthGuard + RolesGuard)
  - [x] e2e тесты: GET null/данные, запреты (401/403), upsert и повторный GET

- [x] 9. CategoriesModule — готово
  - [x] Ответственность: категории и связь с версиями.
  - [x] Эндпоинты: GET /categories, POST /categories (admin), PATCH /categories/:id (admin), DELETE /categories/:id (admin),
        GET /categories/:slug/books, POST /versions/:id/categories (attach), DELETE /versions/:id/categories/:categoryId (detach),
        GET /categories/:id/children, GET /categories/tree.
  - [x] Ограничения: Category.slug уникален; BookCategory уникальность (bookVersionId, categoryId) — добавлен @@unique в Prisma + миграция.
  - [x] RBAC: write-операции — только admin|content_manager (JwtAuthGuard + RolesGuard)
  - [x] Swagger теги/описания
  - [x] Тесты: e2e CRUD + attach/detach, idempotency duplicate attach

- [x] 10. BookshelfModule — готово
  - [x] Ответственность: полка пользователя.
  - [x] Эндпоинты: GET /me/bookshelf, POST /me/bookshelf/:versionId, DELETE /me/bookshelf/:versionId.
  - [x] Ограничения: уникальность (userId, bookVersionId) — добавлен @@unique в Prisma + миграция.
  - [x] Идемпотентность: повторный POST не создаёт дубликат, DELETE всегда 204.
  - [x] Пагинация: общий PaginationDto + метаданные total/hasNext.
  - [x] DTO ответов: BookshelfItemDto, BookshelfListDto (+ Swagger описания).
  - [x] Тесты: e2e доступ/запрет (401), happy path add/list/delete, 404 на несуществующую версию.

- [x] 11. CommentsModule
  - [x] Ответственность: древовидные комментарии к версии/главе/аудио-главе.
  - [x] Эндпоинты: GET /comments?target=version|chapter|audio&targetId=..., POST /comments, PATCH /comments/:id, DELETE /comments/:id.
  - [x] Политика: parentId опционален, children через relation; soft-delete (isDeleted)/hidden (isHidden) для модерации.
  - [x] Ограничения: взаимоисключающие fk (ровно один из bookVersionId|chapterId|audioChapterId задан) — проверка на уровне сервиса.
  - [x] Индексы: добавлены @@index для target-полей и parentId.
  - [x] RBAC: права модерации admin|content_manager; фолбэк по env ADMIN_EMAILS/CONTENT_MANAGER_EMAILS.
  - [x] Тесты: e2e happy/negative, модерация, soft-delete, взаим.исключающие поля.
        Опционально на будущее:
  - [ ] Добавить XOR CHECK-constraint в БД (raw SQL миграция).
  - [ ] Включить rate limiting/антиспам для POST /comments.

- [x] 12. LikesModule — готово
- [x] Ответственность: лайки к версии или комменту.
- [x] Эндпоинты:
  - POST /likes (ровно один target: commentId | bookVersionId)
  - DELETE /likes (тот же target)
  - GET /likes/count?target=...&targetId=...
- [x] Ограничения/БД:
  - @@unique(userId, commentId) и @@unique(userId, bookVersionId)
  - Индексы по targetId для быстрых count
  - (Опционально) CHECK XOR на уровне БД — отложено (нужна raw SQL миграция)
- [x] Валидация: взаимоисключающие поля (ровно одно)
- [x] Права: POST/DELETE — авторизованный пользователь (JwtAuthGuard)
- [x] Тесты e2e: happy path (like/unlike, idempotent DELETE 204), запреты (401), повторный POST (409 Conflict), счётчики (count увеличивается/уменьшается)
- [x] Swagger: DTO для запросов/ответов, описания
- [x] Кэш: count в in-memory CacheService (TTL 5с), инвалидация при like/unlike

- [x] 13. ViewStatsModule — готово (PR: migration added, e2e)
- [x] Ответственность: запись просмотров и агрегации.
- [x] Эндпоинты: POST /views, GET /views/aggregate, GET /views/top
- [x] Индексы: (bookVersionId, timestamp), userId — миграция добавлена
- [x] Кэш: in-memory CacheService (TTL 30s), ключи views:agg/... и views:top/...

- [x] 14. ReadingProgressModule — готово
- [x] Ответственность: прогресс чтения/прослушивания.
- [x] Эндпоинты: GET /me/progress/:versionId, PUT /me/progress/:versionId.
- [x] Ограничения: уникальность (userId, bookVersionId) — добавлен @@unique в Prisma + миграция
- [x] Валидация: XOR chapterNumber|audioChapterNumber; существование главы/аудио-главы; допустимость position
- [x] Безопасность: JwtAuthGuard для обоих эндпоинтов
- [x] Swagger: DTO + примеры
- [x] Тесты e2e: 401, happy-path upsert, валидации, повторный GET

- [x] 15. UploadsModule (инфра)
- Ответственность: pre-signed URL для обложек/аудио; привязка к полям coverImageUrl/audioUrl.
- Эндпоинты: POST /uploads/presign (type=cover|audio, contentType, size).
- Политика: роли/лимиты, валидация MIME, cleanup старых файлов.

  План итераций (стабильный API, переключение драйвера через env):
  - [x] 15.1 Uploads (local, для MVP)
    - StorageModule: интерфейс IStorage и драйвер local (файлы в ./var/uploads; ServeStatic → /static).
    - UploadsModule ручки:
      - POST /uploads/presign → key + подписанный URL на POST /uploads/direct (local) + headers, TTL.
      - POST /uploads/direct → приём файла по одноразовому токену, сохранение по key, ответ: publicUrl.
    - POST /uploads/confirm → возвращает итоговый publicUrl и метаданные; БД не изменяет.
  - Привязка URL осуществляется отдельным PATCH /versions/:id (coverImageUrl|audioUrl) с доменной валидацией/правами.
    - DELETE /uploads?key=... → удаление файла.
    - Валидации: contentType/size по типу (cover|audio). RBAC: admin|content_manager. RateLimitGuard. Swagger.
    - Тесты e2e: presign → direct → GET /static → confirm, негативные кейсы. Без миграций БД (если не обновляем URL на confirm).
    - Swagger: DTO + примеры

  - [ ] 15.2 Uploads (Cloudflare R2)
    - Драйвер R2 на основе @aws-sdk/client-s3 + presign (PUT), endpoint Cloudflare R2, forcePathStyle=true.
    - CORS для пресайн-URL (PUT + Content-Type). Публичные URL через R2_PUBLIC_BASE_URL (или null, если приватно).
  - Те же ручки: /uploads/presign теперь отдаёт presigned PUT для R2; фронт не меняется.
  - Опционально: отдельный admin-эндпоинт "confirm+attach" одним запросом (только после стабилизации 15.1/PATCH-флоу).
    - Тесты e2e: минимальный интеграционный (или с MinIO как S3-совместимым стендом). Скрипт миграции локальных файлов — опционально.
    - Переключение: STORAGE*DRIVER=r2, R2*\* переменные в .env.

  Когда выполнять:
  - 15.1 — следующая итерация (сейчас), чтобы фронт и бэк полноценно работали на локалке.
  - 15.2 — на этапе подготовки к депloю на сервер и подключению Cloudflare R2.

  Краткий конфиг (.env):
  - Общие: STORAGE_DRIVER=local|r2; UPLOADS_MAX_IMAGE_MB=5; UPLOADS_MAX_AUDIO_MB=100; UPLOADS_PRESIGN_TTL_SEC=600;
    UPLOADS_ALLOWED_IMAGE_CT=image/jpeg,image/png,image/webp; UPLOADS_ALLOWED_AUDIO_CT=audio/mpeg,audio/mp4,audio/aac,audio/ogg.
  - Local: LOCAL_UPLOADS_DIR=./var/uploads; LOCAL_PUBLIC_BASE_URL=http://localhost:3000/static.
  - R2: R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com; R2_ACCESS_KEY_ID; R2_SECRET_ACCESS_KEY; R2_BUCKET=books;
    R2_FORCE_PATH_STYLE=true; R2_PUBLIC_BASE_URL=https://static.example.com (опц.).

- [ ] 16. Integrations/Tasks (BullMQ)
- Очереди обработки медиа (генерация превью, нормализация аудио), ретраи, DLT.
- Хелсчек, админ эндпоинты очередей (GET /queues/:name/stats).

— Общие согласования между модулями

- Каскады/целостность: запрет удаления Book/Version при наличии связанных сущностей, или soft-delete политика.
- Транзакции: создание версии + SEO + категории; удаление версии + cleanup зависимостей.
- Кэш инвалидация: при изменениях версий/категорий/SEO/глав — чистить ключи списков и детальных карточек.
- Авторизация: права на создание/редактирование контента (admin/editor), пользователи — только собственные ресурсы (полка, прогресс, лайки, комментарии).
- Нагрузочное: пагинация по id/createdAt, лимиты на списки, индексация из раздела 2.

— Миграции статусов публикации (добавлено в рамках 18)

- Добавлен enum `PublicationStatus` и поля `BookVersion.status`, `BookVersion.publishedAt`.
- Требуется локально выполнить: `yarn prisma:migrate && yarn prisma:generate` для генерации клиента.
- После генерации включить фильтрацию черновиков в сервисах (см. пометки WIP в коде) и дописать e2e.

### Доп задачи

- [x] 1. Rate limiting для POST /comments (commit, e2e, 2025-08-24)
  - [x] Вешаем Guard на POST/PATCH/DELETE /comments
  - [x] По умолчанию выключен: RATE_LIMIT_ENABLED=false (включается в тесте через env)
  - [x] Ошибка при превышении: 429 Too Many Requests
  - [x] e2e тест добавлен: comments-rate-limit.e2e-spec.ts
  - [x] Драйвер InMemory через RateLimitModule; ключ = userId или IP
  - [x] Параметры лимита через env: RATE_LIMIT_COMMENTS_PER_MINUTE, RATE_LIMIT_COMMENTS_WINDOW_MS

- [x] 2. CHECK XOR в БД (comments и likes) — готово (миграция, e2e, 2025-08-24)
  - [x] Добавлена raw SQL миграция: `20250824153000_add_xor_checks_comments_likes`
  - [x] Комментарии: ровно один target из (bookVersionId|chapterId|audioChapterId)
  - [x] Лайки: ровно один target из (bookVersionId|commentId)
  - [x] Безопасная очистка dev-данных в миграции (DELETE несоответствующих строк перед CHECK)
  - [x] Тесты e2e зелёные; приложение работает с новыми ограничениями
