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

- [ ] 9. CategoriesModule
- Ответственность: категории и связь с версиями.
- Эндпоинты: GET /categories, POST /categories (admin), PATCH /categories/:id (admin), DELETE /categories/:id (admin),
  GET /categories/:slug/books, POST /versions/:id/categories (attach), DELETE /versions/:id/categories/:categoryId (detach).
- Ограничения: Category.slug уникален; BookCategory уникальность (bookVersionId, categoryId).

- [ ] 10. BookshelfModule
- Ответственность: полка пользователя.
- Эндпоинты: GET /me/bookshelf, POST /me/bookshelf/:versionId, DELETE /me/bookshelf/:versionId.
- Ограничения: 1 запись на (userId, bookVersionId) — защитить на уровне сервис + уникальный индекс.

- [ ] 11. CommentsModule
- Ответственность: древовидные комментарии к версии/главе/аудио-главе.
- Эндпоинты: GET /comments?target=version|chapter|audio&targetId=..., POST /comments, PATCH /comments/:id, DELETE /comments/:id.
- Политика: parentId опционален, children через relation; soft-delete/hidden для модерации.
- Ограничения: взаимоисключающие fk (ровно один из bookVersionId|chapterId|audioChapterId задан).

- [ ] 12. LikesModule
- Ответственность: лайки к версии или комменту.
- Эндпоинты: POST /likes, DELETE /likes, GET /likes/count?target=...&targetId=...
- Ограничения: уникальность (userId, commentId) и (userId, bookVersionId); проверка, что задан ровно один target.
- Счётчики: инкремент/декремент агрегатов (опционально материализованные поля или view).

- [ ] 13. ViewStatsModule
- Ответственность: запись просмотров и агрегации.
- Эндпоинты: POST /views (или interceptor), GET /views/aggregate?versionId&period=day|week|month.
- Индексы: (bookVersionId, timestamp), userId.
- Кэш: Redis на агрегаты.

- [ ] 14. ReadingProgressModule
- Ответственность: прогресс чтения/прослушивания.
- Эндпоинты: GET /me/progress/:versionId, PUT /me/progress/:versionId.
- Ограничения: уникальность (userId, bookVersionId); валидация главы/позиции.

- [ ] 15. UploadsModule (инфра)
- Ответственность: pre-signed URL для обложек/аудио; привязка к полям coverImageUrl/audioUrl.
- Эндпоинты: POST /uploads/presign (type=cover|audio, contentType, size).
- Политика: роли/лимиты, валидация MIME, cleanup старых файлов.

- [ ] 16. Integrations/Tasks (BullMQ)
- Очереди обработки медиа (генерация превью, нормализация аудио), ретраи, DLT.
- Хелсчек, админ эндпоинты очередей (GET /queues/:name/stats).

— Общие согласования между модулями

- Каскады/целостность: запрет удаления Book/Version при наличии связанных сущностей, или soft-delete политика.
- Транзакции: создание версии + SEO + категории; удаление версии + cleanup зависимостей.
- Кэш инвалидация: при изменениях версий/категорий/SEO/глав — чистить ключи списков и детальных карточек.
- Авторизация: права на создание/редактирование контента (admin/editor), пользователи — только собственные ресурсы (полка, прогресс, лайки, комментарии).
- Нагрузочное: пагинация по id/createdAt, лимиты на списки, индексация из раздела 2.

<!-- Принял. Коротко по приоритету — что логичнее взять следующим и почему:

AudioChaptersModule — лучший следующий шаг
Причины: почти полный аналог Chapters (быстрый delivery, низкий риск), модель уже есть в Prisma (AudioChapter), уникальность (bookVersionId, number) задана.
Что войдёт: DTO (audioUrl, duration), CRUD эндпоинты как у глав, RBAC (admin|content_manager) на write, e2e по happy/forbidden и уникальности.
Альтернативы (после аудио-глав):

SeoModule — 1:1 с BookVersion, простая реализация, сразу добавляет ценность для SEO.
CategoriesModule — CRUD категорий (admin) + attach/detach к версиям; у нас уже есть связи и сиды, останется API и тесты.
BookSummariesModule — upsert 1 summary на версию; небольшой объём.
Рекомендация: начинаем с AudioChaptersModule, затем SeoModule или CategoriesModule (зависит от приоритета продуктовых задач). -->
