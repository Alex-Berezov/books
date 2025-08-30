# Итерационный план (реализуем по шагам)

Ниже — упорядоченный список задач, каждая с кратким ТЗ для однозначного исполнения в отдельной итерации. Список расширяемый: добавляйте новые пункты и подзадачи по мере выявления потребностей.

Принципы формата ТЗ:

- Цель — что меняется и зачем.
- Объём — ключевые изменения/файлы.
- Критерии приёмки — как проверяем готовность.
- Замечания — границы/не-цели.

---

## Очередь выполнения (мастер-порядок)

В этом списке задачи перечислены в том порядке, в котором их стоит выполнять сейчас (без пересборки разделов ниже):

1. 18 — Черновики/публикация для книг и версий — [x] (2025-08-25)
2. 19 — Обзор книги и доступность разделов (флаги/URL) — [x] (2025-08-25)
3. 20 — Категории: Подкатегории (иерархия) — [x] (2025-08-25)
4. 21 — Теги: модель и привязка к версиям — [x] (2025-08-25)
5. 22 — CMS-страницы приложения (Page) — [x] (2025-08-26)
6. 23 — Медиа-библиотека (повторное использование) — [x] (2025-08-26) — см. docs/MEDIA_LIBRARY.md
7. 24 — Языки: политика выбора и расширяемость набора — [x] (2025-08-26)
8. 25 — SEO bundle сервис (OG/Twitter/Canonical) — [x] (2025-08-26)

9. 26 — Мультисайт i18n: базовая маршрутизация и Page unique (language, slug) — [x] (2025-08-30)
10. 27 — Мультисайт i18n: админ-контекст языка (листинги/создание) — [x] (2025-08-30)
11. 28 — Мультисайт i18n: SEO resolve по языку и e2e — [x] (2025-08-30)
12. 29 — Мультисайт i18n: таксономии через переводы (\*Translation)
13. 30 — Мультисайт i18n: sitemap/robots per-language

Далее — инфраструктурные и платформенные задачи (их можно выполнять параллельно, но ниже основной приоритет):

9. 1 — Dev-воркфлоу: Husky + lint-staged + pre-commit
10. 2 — VS Code задачи (.vscode/tasks.json)
11. 3 — README актуализация
12. 4 — docs/AGENT_CONTEXT.md
13. 5 — Docker Compose (dev): Postgres + Redis
14. 6 — .env.example расширение
15. 7 — Юнит-тесты (первый пакет)
16. 8 — Безопасность: Helmet, CORS, лимиты тела
17. 9 — Health/Readiness (terminus)
18. 10 — Prometheus метрики
19. 11 — GitHub Actions (CI)
20. 12 — Dockerfile(prod) + docker-compose.prod.yml
21. 14 — SEO: sitemap.xml и robots.txt
22. 15 — BullMQ (интеграция базовая)
23. 16 — Sentry (ошибки)
24. 17 — Uploads (R2, Cloudflare) — отложено

## 1) Dev-воркфлоу: Husky + lint-staged + pre-commit

- Цель: Блокировать коммиты с линт/формат/тип-ошибками; ускорить локальную проверку качества.
- Объём:
  - Добавить devDeps: husky, lint-staged.
  - Инициализировать Husky; создать `.husky/pre-commit`.
  - В `package.json` добавить `lint-staged` конфиг: eslint --fix, prettier --write для ts/yml/md; быстрый `tsc --noEmit`.
- Критерии приёмки: при попытке `git commit` с ошибками линтера/типов — коммит блокируется; без ошибок — проходит.
- Замечания: unit-тесты в pre-commit не запускаем (будут отдельной задачей).

Примечание по пакетному менеджеру:

- В проекте используем только yarn (classic). Не использовать npm. Все команды в задачах и скриптах — через yarn.

## 2) VS Code задачи (.vscode/tasks.json)

- Цель: Быстрые команды из VS Code: lint, typecheck, test:e2e, dev, prisma-сценарии.
- Объём: Создать `.vscode/tasks.json` с задачами: `lint`, `typecheck`, `test:e2e`, `dev`, `prisma:migrate`, `prisma:seed`, `prisma:studio`.
- Критерии приёмки: задачи видны и запускаются в VS Code; ошибки подсвечиваются в Problems.
- Замечания: использовать текущие скрипты `yarn` из `package.json`.

## 3) README актуализация

- Цель: Документация запуска и разработки.
- Объём: Переписать `README.md` разделы: требования (Node/Yarn/Docker), `.env` переменные, миграции/сиды, запуск, Swagger, статические файлы `/static`, тесты (unit/e2e), оговорки про локальные загрузки.
- Критерии приёмки: новый разработчик поднимает проект по README без внешней помощи.
- Замечания: ссылку на Swagger и на этот план добавить.

## 4) docs/AGENT_CONTEXT.md

- Цель: Правила для ИИ-агента (стиль, формат PR, границы изменений, как работать с миграциями/тестами).
- Объём: Создать `docs/AGENT_CONTEXT.md` с практиками и соглашениями по коду.
- Критерии приёмки: документ существует, покрывает основное; ссылка добавлена в README.
- Замечания: лаконично, по делу.

## 5) Docker Compose (dev): Postgres + Redis

- Цель: Единая локальная среда без ручной установки сервисов.
- Объём: Добавить `docker-compose.yml` (postgres, redis, волюмы, healthcheck), `DATABASE_URL` в `.env.example` для compose, makefile-алиасы (опц.).
- Критерии приёмки: `docker compose up -d` поднимает БД/Redis; приложение подключается; `yarn prisma:migrate` успешно применяет миграции.
- Замечания: данные в именованных volume, экспонировать 5432/6379 только локально.

## 6) .env.example расширение

- Цель: Все переменные, которые использует код, должны быть отражены в примере.
- Объём: Добавить/обновить: RATE_LIMIT_ENABLED, RATE_LIMIT_COMMENTS_WINDOW_MS, RATE_LIMIT_COMMENTS_PER_MINUTE, LOCAL_UPLOADS_DIR, LOCAL_PUBLIC_BASE_URL, UPLOADS_MAX_IMAGE_MB, UPLOADS_MAX_AUDIO_MB, UPLOADS_PRESIGN_TTL_SEC, UPLOADS_ALLOWED_IMAGE_CT, UPLOADS_ALLOWED_AUDIO_CT, CONTENT_MANAGER_EMAILS, CORS_ORIGIN, PORT.
- Критерии приёмки: при копировании `.env.example` → `.env` приложение стартует; значения по умолчанию соответствуют коду.
- Замечания: поясняющие комментарии к каждому ключу.

## 7) Юнит-тесты (первый пакет)

- Цель: Базовое покрытие ключевых сервисов без БД.
- Объём: Добавить `*.spec.ts` для 2–3 сервисов (например: BookVersionService, LikesService, CommentsService) с моками Prisma/кэша. Настроить jest для unit (rootDir/paths уже есть).
- Критерии приёмки: `yarn test` проходит; минимум по 2–3 теста на сервис (happy + 1 edge).
- Замечания: e2e не трогаем.

## 8) Безопасность: Helmet, CORS, лимиты тела

- Цель: Базовая защита HTTP, корректный CORS, предсказуемые лимиты тела.
- Объём: В `main.ts` подключить Helmet; CORS по `CORS_ORIGIN`; общий `json/raw` body limit из env (кроме `/uploads/direct`, где уже задано).
- Критерии приёмки: приложение стартует; preflight проходит; e2e зелёные.
- Замечания: не включать строгие политики, лояльные дефолты для dev.

## 9) Health/Readiness (terminus)

- Цель: Эндпоинты `/health/liveness`, `/health/readiness` (DB+Redis).
- Объём: Подключить `@nestjs/terminus`; создать модуль/контроллер; проверки Prisma и Redis (если Redis недоступен — readiness=false, liveness=true).
- Критерии приёмки: корректные коды/JSON для обоих эндпоинтов.
- Замечания: Redis клиент реиспользовать/провайдить; для dev можно заглушку, если Redis не сконфигурирован.

## 10) Prometheus метрики

- Цель: `/metrics` с базовыми метриками процесса и HTTP.
- Объём: `prom-client`, коллекция default metrics; middleware/interceptor для HTTP duration/код ответа; endpoint `/metrics`.
- Критерии приёмки: curl `/metrics` возвращает текстовую экспозицию; значения растут/изменяются при запросах.
- Замечания: без аутентификации на dev.

## 11) GitHub Actions (CI)

- Цель: Автоматическая проверка PR.
- Объём: workflow матрица: lint, typecheck, unit, e2e (services: postgres, redis), build, prisma validate; кеш npm/yarn; артефакт coverage.
- Критерии приёмки: pipeline проходит в репозитории; статусы видны.
- Замечания: e2e запускать в `--runInBand`.

## 12) Dockerfile(prod) + docker-compose.prod.yml

- Цель: Повторяемая сборка и запуск.
- Объём: Мультистейдж Dockerfile (build+runtime), `.dockerignore`; `docker-compose.prod.yml` (api+postgres+redis+nginx опц.). Скрипт старта: `prisma migrate deploy` перед `node dist/main`.
- Критерии приёмки: локальная сборка успешна; контейнер стартует; миграции применяются.
- Замечания: переменные окружения передавать через compose/секреты.

## 13) Политика выбора языка версии

- Цель: Единые правила выбора `BookVersion` по языку.
- Объём: Поддержать `?lang=` и заголовок `Accept-Language`; фолбэк на язык книги/дефолт из env; утилита + e2e на 2–3 сценария.
- Критерии приёмки: корректный выбор и фолбэк; документировано в README.
- Замечания: не трогаем бизнес-логику CRUD.

## 14) SEO: sitemap.xml и robots.txt

- Цель: Базовая SEO-отдача.
- Объём: Endpoint `GET /sitemap.xml` (версии книг с canonical), `GET /robots.txt` (лояльный дефолт). Кэшировать на 30–60с.
- Критерии приёмки: корректный content-type; XML/текст валидны; e2e smoke.
- Замечания: без приоритезации/lastmod — MVP.

## 15) BullMQ (интеграция базовая)

## 26) Мультисайт i18n: базовая маршрутизация и Page unique — [x] (2025-08-30)

- Цель: Перевести публичные ручки на `/:lang` и разрешить одинаковые `slug` для страниц на разных языках.
- Объём:
  - [x] Prisma: изменить модель Page — `slug` без `@unique`, добавить `@@unique([language, slug])`, `@@index([language])`; миграция `20250830120000_page_unique_language_slug`.
  - [x] Роутинг: введён префикс `/:lang(en|fr|es|pt)` для публичных ручек (новый контроллер `PublicController`).
  - [x] Контроллеры книг/страниц: `GET /:lang/books/:slug/overview` и `GET /:lang/pages/:slug` используют язык из пути с наивысшим приоритетом; публичный `GET /pages/:slug` сохраняет совместимость и использует политику выбора языка (query/header → default).
  - [x] E2E: добавлен `test/i18n-routing.e2e-spec.ts` — smoke по `/:lang` и приоритету языка пути над `?lang` и `Accept-Language`.
- Критерии приёмки: страницы и книги доступны по локализованным URL; миграция применяется; тесты зелёные.
- Замечания:
  - Совместимость с `?lang`/`Accept-Language` сохранена как fallback для публичных ручек без префикса.
  - SEO-резолвер по языку пути отложен в задачу 28 (см. ниже), canonical пока без `/:lang`.
  - Категории/теги пока не локализованы — фильтрация по языку версий выполнена ранее, их локализация — задача 29.

Примечания по реализации:

- Файлы:
  - Prisma: `prisma/schema.prisma` (Page @@unique([language, slug]) + @@index([language])) и миграция `prisma/migrations/20250830120000_page_unique_language_slug/`.
  - Новый модуль: `src/modules/public/public.module.ts` и `public.controller.ts` — публичные URL с префиксом `/:lang`.
  - Pages: расширен сервис `PagesService` методами `getPublicBySlug(slug, language?)` и `getPublicBySlugWithPolicy(slug, queryLang?, acceptLanguage?)`; контроллер `pages.controller.ts` поддерживает `?lang` и `Accept-Language` для совместимости.
  - AppModule: подключён `PublicModule`.
- Тесты: `test/i18n-routing.e2e-spec.ts` покрывает приоритет языка пути и доступ страниц по `(language, slug)`.

Миграции БД:

- В dev-среде применить: `yarn prisma:migrate --name page_unique_language_slug` (уже добавлен SQL для безопасного дропа индекса `Page_slug_key` и создания составного уникального индекса). При необходимости выполните reset на dev.

## 27) Мультисайт i18n: админ-контекст языка — [x] (2025-08-30)

- Цель: Управлять языком контента из админки и сохранять/фильтровать по нему.
- Объём (выполнено):
  - Добавлен заголовок `X-Admin-Language` (имеет приоритет над языком пути `/admin/:lang`).
  - Pages admin:
    - `GET /admin/:lang/pages` — фильтрует по эффективному языку (заголовок > путь).
    - `POST /admin/:lang/pages` — язык берётся из админ-контекста; поле `language` в DTO сделано опциональным и игнорируется при создании.
  - BookVersion admin:
    - `GET /admin/:lang/books/:bookId/versions` — по умолчанию фильтрует по эффективному языку (можно переопределить `?language=`).
    - `POST /admin/:lang/books/:bookId/versions` — новый эндпоинт; язык берётся из админ-контекста (заголовок > путь), `dto.language` игнорируется.
  - Сервисы обновлены: проверки дублей и создание учитывают эффективный язык.
- Критерии приёмки: листинги фильтруются по языку; новые Page/BookVersion сохраняются в выбранном языке; Swagger обновлён для заголовка `X-Admin-Language` и новых ручек.
- Замечания:
  - Изменение языка у существующей Page возможно через PATCH; уникальность `(language, slug)` проверяется.
  - Публичные ручки `/:lang/...` не трогались в этой итерации.
  - Агрегированная сводка статусов версий по языкам — вынесена в последующий этап админ-UI.

## 28) Мультисайт i18n: SEO resolve по языку — [x] (2025-08-30)

- Цель: Корректный SEO-бандл с учётом языка для публичных страниц/книг, канонические URL с языковым префиксом.
- Объём (выполнено):
  - [x] Контроллер SEO:
    - `GET /seo/resolve` — добавлены `lang` query и заголовок `Accept-Language`.
    - `GET /:lang/seo/resolve` — новый публичный маршрут; язык пути имеет высший приоритет.
  - [x] Сервис SEO:
    - Новый метод `resolvePublic(type, id, { pathLang?, queryLang?, acceptLanguage? })` с политикой выбора языка.
    - Для `type=version` canonical всегда без префикса (как и прежде): `/versions/:id`.
    - Для `type=book`/`page` canonical включает `/:lang` по эффективному языку, выбранному по правилу приоритетов.
  - [x] E2E:
    - `test/seo-i18n.e2e-spec.ts` — проверка приоритета языка пути над query/header, префикса в canonical для `book` и `page`.
  - [x] Документация: `docs/ENDPOINTS.md` и `README.md` — описаны новые маршруты и политика.
- Критерии приёмки: новые e2e проходят; canonical формируется корректно; поведение `type=version` не изменено.
- Замечания:
  - Публичный старый маршрут без префикса сохранён для совместимости и понимает `lang`+`Accept-Language`.
  - Значение `DEFAULT_LANGUAGE` берётся из env (по умолчанию `en`).
  - В будущем `sitemap.xml` должен использовать локализованные canonical (см. задачу 30).

## 29) Мультисайт i18n: таксономии через переводы (\*Translation)

- Цель: Локализовать категории и теги через переводческие таблицы.
- Объём:
  - Prisma:
    - Добавить модели `CategoryTranslation` и `TagTranslation`.
    - Перенести уникальность slug с базовых сущностей в переводы: для базовых `Category.slug`/`Tag.slug` снять `@unique` (если есть); в переводах ввести `@@unique([language, slug])` и индексы по `language`.
    - Миграция данных: для каждого существующего Category/Tag создать перевод в дефолтном языке из текущих `name/slug`.
  - Backend:
    - CRUD для переводов (admin).
    - Публичные резолверы категорий/тегов и фильтрации перевести на поиск по `(language, slug)` перевода.
    - Обновить существующие контроллеры/сервисы, где slug использовался из базовой сущности.
  - Тесты: e2e на создание/редактирование перевода; публичный поиск по `/:lang/:slug` для категорий и тегов; корректность привязок к версиям.
- Критерии приёмки: переводы создаются/редактируются; поиск по slug перевода работает; привязки к версиям корректны; уникальные ограничения применены в БД.
- Замечания: вариант B принят как основной (без варианта A); при необходимости совместимость по старым slug может быть реализована отдельной задачей (редирект/алиасы).

## 30) Мультисайт i18n: sitemap/robots per-language

- Цель: Отдавать карты сайта с локализованными URL.
- Объём: обновить генератор `/sitemap.xml` для `/:lang` URL; правки `robots.txt` при необходимости.
- Критерии приёмки: валидный sitemap с разделением по языкам.

- Цель: Готовность к фоновым задачам.
- Объём: Модуль очередей, подключение к Redis, 1 пример job-та (no-op), health-ручка со статистикой.
- Критерии приёмки: очередь создаётся; health возвращает счетчики; e2e smoke.
- Замечания: бизнес-джобы вне диапазона этой итерации.

## 16) Sentry (ошибки)

- Цель: Сбор ошибок prod/staging.
- Объём: Инициализация SDK, фильтры Nest для необработанных ошибок, конфиг через env (dsn, env, release), маскирование секретов.
- Критерии приёмки: в dev можно отключить; ручной тест генерирует событие при включении.
- Замечания: performance tracing опционально.

## 17) Uploads (R2, Cloudflare) — отложено

- Цель: S3-совместимый драйвер и presigned PUT.
- Объём: Драйвер R2, presign для PUT, переменные R2\_\*, совместимость API `/uploads/presign`.
- Критерии приёмки: интеграционный smoke с MinIO или моками; документация.
- Замечания: выполнять после стабилизации локального драйвера и деплой-инфры.

---

Расширение списка

- Если в ходе ревью функциональных модулей обнаружатся пробелы, добавляйте новые пункты по этому же шаблону (Цель/Объём/Критерии/Замечания) и указывайте приоритет/порядок.

## 18) Черновики/публикация для книг и версий

- Цель: Возможность готовить контент до публикации.
- Объём:
  - [x] Prisma: добавлены поля `BookVersion.status` (draft|published), `publishedAt` и enum `PublicationStatus`; миграция применена.
  - [x] Backend: эндпоинты `PATCH /versions/:id/publish` и `PATCH /versions/:id/unpublish` (только admin|content_manager).
  - [x] Публичные методы и листинги учитывают статус (возвращают только published).
  - [x] Админский листинг: `GET /admin/books/:bookId/versions` — включает черновики; также `GET /books/:bookId/versions?includeDrafts=true` (корректно для авторизованных админов/контент-менеджеров).
  - [x] e2e: добавлен сценарий черновик/публикация/скрытие (см. `test/book-version.e2e-spec.ts`).
- Критерии приёмки: статусы корректно соблюдаются во всех списках/деталях (покрыто e2e).
- Замечания: для глав/аудио-глав — можно унаследовать от версии (или отдельные статусы вынести в отдельную последующую задачу).

Примечания по реализации:

- Новые версии создаются со статусом `draft` по умолчанию.
- Публичный GET `/versions/:id` возвращает 404 для черновиков.
- READMЕ обновлён: раздел про публикацию версий, примеры запросов.

## 19) Обзор книги и доступность разделов (флаги/URL)

- Цель: Для фронтенда возвращать агрегированные флаги наличия разделов и их URL/идентификаторы.
- Объём:
  - [x] Эндпоинт: `GET /books/:slug/overview?lang=xx` → { book, availableLanguages[], hasText, hasAudio, hasSummary, versionIds: {text?, audio?}, seo: { main/read/listen/summary } }.
  - [x] Реализация на базе `Book`, `BookVersion`, `BookSummary`, `Seo` (учёт статуса публикации).
- Критерии приёмки: для книги с текстом/аудио/пересказом флаги и SEO заполнены корректно; для отсутствующих — false/null; e2e на 2–3 сценария.
- Замечания: SEO берём из `Seo` версии с фолбэками; поля H1 — формируем из title/author по шаблонам (опц.).

Примечания по реализации:

- Публично учитываются только версии в статусе `published`.
- Доступные языки формируются из опубликованных версий.
- Выбор SEO: main → text > audio > referral; read → text; listen → audio; summary → text > audio.
- Добавлен e2e-тест `book-overview.e2e-spec.ts`.

## 20) Категории: Подкатегории (иерархия)

- Цель: Поддержать дерево категорий (родитель/дети) для группировок жанров и разделов.
- Объём:
  - [x] Prisma: `Category.parentId` (self-relation), индексы; миграция.
  - [x] Контроллер/сервис: создать/обновлять с `parentId`; `GET /categories/:id/children` и `GET /categories/tree`.
  - [x] Валидация: запрет циклов, `parentId != id`, проверка существования родителя.
  - [x] Удаление: запретить удаление, если есть дочерние.
- Критерии приёмки: CRUD работает; дерево возвращается с корректной вложенностью; e2e на создание цепочки и выборку.
- Замечания: удаление родителя с детьми — запрещено; перенос ветки — через PATCH с новым `parentId`.

Примечания:

- Дерево собирается в памяти из одного запроса `findMany` (поля: id, name, slug, type, parentId).
- DTO позволяют передавать `parentId: null` для снятия родителя.
- В будущем возможно расширение на материализованный путь/closure table при росте данных.
- Swagger: новые ручки задокументированы через переиспользуемый DTO `CategoryTreeNodeDto` с рекурсивным полем `children` (см. `src/modules/category/dto/category-tree-node.dto.ts`). Это обеспечивает единообразное описание узла дерева в нескольких эндпоинтах.
- Тесты: e2e сценарии для дерева/детей/запрета удаления родителя добавлены в `test/categories.e2e-spec.ts` (проверка: создание дочерней, `GET /categories/:id/children`, `GET /categories/tree`, запрет `DELETE` родителя при наличии детей, перенос ветки через `PATCH parentId: null`).
- Миграция БД: `prisma/migrations/20250825140000_add_category_hierarchy/` — добавляет `Category.parentId` (self FK ON DELETE SET NULL) и индекс по `parentId`.

## 21) Теги: модель и привязка к версиям книг — [x] (2025-08-25)

- Цель: Метить версии книг свободными тегами и фильтровать по ним.
- Объём:
  - [x] Prisma: добавлены модели `Tag` (id, name, slug @unique) и `BookTag` (id, bookVersionId, tagId, @@unique(bookVersionId, tagId), индексы); связь `BookVersion.tags: BookTag[]`.
  - [x] Backend: модуль `TagsModule` со следующим API:
    - [x] CRUD теги (только admin|content_manager):
      - `POST /tags` — создать тег.
      - `PATCH /tags/:id` — обновить тег.
      - `DELETE /tags/:id` — удалить тег.
      - `GET /tags?page&limit` — листинг тегов.
    - [x] Привязка тегов к версиям (только admin|content_manager):
      - `POST /versions/:id/tags` — attach тег к версии (идемпотентно).
      - `DELETE /versions/:id/tags/:tagId` — detach тег от версии (идемпотентно: 204 и при отсутствии связи).
    - [x] Публичная выборка:
      - `GET /tags/:slug/books` — версии по тегу (возвращаются связанные версии без доп. фильтрации по статусу — как и в категориях; можно расширить позже).
  - [x] Валидация slug (regex из `shared/validators/slug`).
  - [x] Swagger-аннотации, роли и guard совпадают со стилем категорий.
- Критерии приёмки: e2e CRUD и attach/detach; выборка по тегу возвращает корректные версии — покрыто тестом `test/tags.e2e-spec.ts`.
- Замечания: теги — плоские, без иерархии. Attach/Detach реализованы идемпотентно, что упрощает повторные вызовы с фронтенда.

Примечания по реализации:

- Файлы:
  - Prisma: обновлён `prisma/schema.prisma` (модели `Tag`, `BookTag`, связь в `BookVersion`).
  - Модуль: `src/modules/tags/*` (контроллер, сервис, DTO), подключён в `AppModule`.
  - Тесты: `test/tags.e2e-spec.ts` — сценарий создания/обновления/листинга тега, привязки/отвязки к версии и выборки версий по тегу.
- Безопасность: CRUD и attach/detach доступны только для ролей Admin и ContentManager (см. `JwtAuthGuard`, `RolesGuard`).
- Валидация: slug соответствует `^[a-z0-9]+(?:-[a-z0-9]+)*$` (см. `shared/validators/slug.ts`).

Примечания по миграции БД:

- На текущей базе обнаружена проблема с применением ранней миграции `20250825112250_qwerty` (ошибка дублирующегося индекса `Like_userId_commentId_key`). Это блокирует автоматическое создание новой миграции для тегов в shadow DB.
- Что сделано:
  - Обновлён `schema.prisma` и сгенерирован Prisma Client (`yarn prisma:generate`) — код компилируется и готов к запуску после починки миграций.
  - Новая миграция для моделей тегов не добавлена автоматически из‑за конфликта ранних миграций.
- Что нужно сделать для устранения конфликта (последовательно на dev-среде):
  1. Разрулить конфликтную миграцию `20250825112250_qwerty` (проверить содержимое и дублируемые unique-индексы для `Like`).
  2. После фикса выполнить: `prisma migrate dev --name add_tags_model_and_links` — создастся и применится миграция с `Tag/BookTag`.
  3. Перегенерировать клиент: `yarn prisma:generate` (если нужно).

После устранения конфликта миграций e2e-тест `Tags` должен проходить.

Дополнение (инфраструктура Prisma):

- Обновлены версии: `prisma` 6.14.0, `@prisma/client` 6.14.0.
- В `schema.prisma` настроен `generator client` с `output = "./node_modules/.prisma/client"`.
- README дополнён разделом о версиях Prisma, output и троблшутинге миграций (идемпотентные индексы + reset в dev).

## 22) CMS-страницы приложения (Page) — [x] (2025-08-26)

- Цель: Управлять контентными страницами приложения (общие страницы, шаблоны главных разделов).
- Объём:
  - [x] Prisma: добавлена модель `Page` (id, slug @unique, title, type enum: generic|category_index|author_index, content: String, status draft|published, language, seoId?, timestamps) и enum `PageType`; настроена 1:1-связь `Seo` ↔ `Page` с именованными relation.
  - [x] Backend (NestJS): модуль `PagesModule` с API:
    - [x] Публично: `GET /pages/:slug` — возвращает только `published`.
    - [x] Админ (admin|content_manager):
      - `GET /admin/pages?page&limit` — листинг всех страниц (включая draft).
      - `POST /admin/pages` — создать.
      - `PATCH /admin/pages/:id` — обновить поля.
      - `PATCH /admin/pages/:id/publish` — опубликовать.
      - `PATCH /admin/pages/:id/unpublish` — снять с публикации.
      - `DELETE /admin/pages/:id` — удалить.
  - [x] Swagger/валидации DTO (slug, enum type/language, status); роли/гварды повторяют стиль Categories/Tags.
  - [x] e2e: сценарий CRUD + publish/unpublish + публичная доступность (см. `test/pages.e2e-spec.ts`).
- Критерии приёмки: страница создаётся/редактируется/публикуется; публичная выдача корректна — покрыто e2e.
- Замечания:
  - Контент хранится как строка (в дальнейшем можно сменить на JSON с редактором).
  - Мультиязычие — отдельные записи `Page` на каждый язык.
  - Связь с `Seo` опциональна; добавлены именованные relation: `SeoForPage`, `SeoForBookVersion`.

Примечания по реализации:

- Файлы (основное):
  - Prisma: `prisma/schema.prisma` — модели `Page`, enum `PageType`, связи в `Seo`/`BookVersion`.
  - Бэкенд: `src/modules/pages/*` (controller, service, module, DTO) + подключение в `AppModule`.
  - Тесты: `test/pages.e2e-spec.ts` — создание (draft), 404 публично; publish — 200 публично; unpublish — снова 404; обновление/удаление и админ-список.

Примечания по миграции БД:

- В автоматическом окружении `prisma migrate dev` недоступна (неинтерактивная среда). Для локальной разработки выполните последовательно:
  1. Обновить schema: уже сделано в репозитории.
  2. Создать миграцию локально: `yarn prisma:migrate --name add_cms_pages`.
  3. Сгенерировать клиент: `yarn prisma:generate`.
  4. Применить миграции в dev БД. После этого e2e `pages` пройдут.
- Отдельное замечание: ранее упомянутая конфликтная миграция `20250825112250_qwerty` (дубликаты индексов в `Like`) может потребовать ручной коррекции в dev. После устранения — миграции для `Page` применяются без проблем.

## 23) Медиа-библиотека (повторное использование изображений/аудио) — [x] (2025-08-26)

Подробная спецификация и API: см. отдельный документ — `docs/MEDIA_LIBRARY.md`.

- Цель: Централизованно хранить и переиспользовать медиа-объекты (как в WordPress Media Library).
- Объём:
  - [x] Prisma: модель `MediaAsset` (id, key @unique, url, contentType?, size?, width?, height?, hash?, createdAt, createdById?, isDeleted=false) + связь с `User` (опционально).
  - [x] Backend (NestJS): модуль `MediaModule` с API:
    - [x] `POST /media/confirm` — подтверждение ранее загруженного объекта (из `/uploads`) и создание/обновление записи `MediaAsset` (идемпотентно по key).
    - [x] `GET /media?page&limit&q&type` — листинг с фильтрами (подстрока по key/url, префикс по contentType, пагинация).
    - [x] `DELETE /media/:id` — мягкое удаление (isDeleted=true) + попытка удаления файла из стораджа (best-effort).
  - [x] Интеграция со стораджем: возврат `publicUrl` из `StorageService.getPublicUrl(key)`; confirm принимает `key` и `url` (если url не передан — берём из стораджа).
  - [x] Роли/доступ: все ручки доступны только `admin|content_manager` (JwtAuthGuard + RolesGuard), как в tags/categories.
- Критерии приёмки: один и тот же файл может использоваться в нескольких местах без дублирования; confirm идемпотентен; листинг/удаление работают; e2e smoke для confirm/list/delete (добавить в последующей итерации при стабилизации миграций).
- Замечания:
  - Рефактор `BookVersion.coverImageUrl` → `mediaId` вынесен в отдельную задачу (миграция данных, обратная совместимость DTO).
  - Миграции в non-interactive окружении не создаются автоматически. См. раздел "Примечания по миграции БД" ниже.

Примечания по реализации:

- Файлы:
  - Prisma: `prisma/schema.prisma` — добавлена модель `MediaAsset` + обратная связь `User.mediaAssets`.
  - Бэкенд: `src/modules/media/*` (controller, service, module), подключён в `AppModule`.
  - Хранилище: используется уже существующий `StorageService` (локальный драйвер сохраняет файлы в `var/uploads`, доступ через `/static`).
- Поведение confirm:
  - Если запись с таким `key` существует — выполняется обновление метаданных и `isDeleted=false` (повторное использование).
  - Если нет — создаётся новая запись с привязкой к `createdById` (из JWT).
- Поиск в листинге: `q` ищет подстроку по `key` и `url`; `type` фильтрует по префиксу `contentType` (например, `image/`, `audio/`).

Примечания по миграции БД:

- В автоматической среде команда `prisma migrate dev` недоступна. Для локальной разработки:
  1. Создать миграцию: `yarn prisma:migrate --name add_media_asset`.
  2. Сгенерировать клиент: `yarn prisma:generate`.
  3. Применить миграции к dev БД.
- Если всё ещё встречается конфликт ранней миграции `20250825112250_qwerty` (дублирующиеся индексы Like), используйте подход из раздела задач по тегам: сделать индексы идемпотентными, выполнить reset в dev и повторно применить миграции.

## 24) Языки: политика выбора и расширяемость набора — [x] (2025-08-26)

- Цель: Устойчиво выбирать версию по языку и уметь добавлять новые языки.
- Объём:
  - [x] Политика выбора (см. задачу 13) + дефолт из env: реализована утилитой `shared/language/language.util.ts` (парсинг `Accept-Language`, приоритет `?lang`, фолбэк на `DEFAULT_LANGUAGE`).
  - [x] Применение политики в публичной ручке `GET /books/:slug/overview` (учёт доступных языков версии книги и заголовка `Accept-Language`).
  - [x] Расширение: та же политика применена к `GET /categories/:slug/books` и `GET /tags/:slug/books` (фильтрация по языку, `availableLanguages` в ответе, поддержка `?lang` и `Accept-Language`).
  - [x] Расширение: публичный листинг `GET /books/:bookId/versions` — при отсутствии `?language` использует `Accept-Language` → `DEFAULT_LANGUAGE` (задокументировано в README, покрыто e2e `test/book-versions-list-language.e2e-spec.ts`).
  - [x] Документация: README раздел "Языки" + Swagger-хедер `Accept-Language` у overview.
  - [x] E2E: `test/language-policy.e2e-spec.ts` и `test/language-policy-categories-tags.e2e-spec.ts` (приоритет `?lang` над `Accept-Language`, фолбэк к `DEFAULT_LANGUAGE`).
  - [x] E2E: `test/book-versions-list-language.e2e-spec.ts` — поведение листинга версий без параметра `language`.
  - [x] Техническое: e2e переведены на последовательный режим (`maxWorkers: 1` в `test/jest-e2e.json`) для стабильности в dev.
  - [x] ADR: принято решение остаться на Prisma enum `Language` и расширять список через миграции. Таблица `Language` — возможная альтернатива на будущее (см. `docs/adr/2025-08-26-language-policy-and-extensibility.md`).
- Критерии приёмки: после добавления нового языка миграцией Prisma API принимает и отдаёт этот язык; выбор версии корректен — покрыто e2e.
- Замечания: если появится требование управлять языками без миграций — вернёмся к варианту с отдельной таблицей и миграцией DTO на строковые коды ISO.

## 25) SEO bundle сервис (OG/Twitter/Canonical) — [x] (2025-08-26)

- Цель: Единая сборка SEO-мета с фолбэками и правилами.
- Объём:
  - [x] Сервис-компоновщик SEO в `SeoService.resolveByParams(type, id)`: при отсутствии явных полей `Seo` — используются адекватные фолбэки (title из версии/книги/страницы; canonical из публичного маршрута; OG/Twitter заполняются от meta).
  - [x] Эндпоинт: `GET /seo/resolve?type=book|version|page&id=...` — возвращает бандл: `{ meta, openGraph, twitter, schema.event? }`.
  - [x] Валидация query-параметров и 400 при неверном `type`.
  - [x] Кэширование существующих `Seo` по версии (reuse имеющейся карты из `SeoService`).
  - [x] E2E: smoke на `GET /seo/resolve` (version и book), файл `test/seo.e2e-spec.ts`.
- Критерии приёмки: фронтенд получает полный набор полей для сниппетов; e2e smoke проходит.
- Замечания:
  - Источник base URL: `LOCAL_PUBLIC_BASE_URL` (env), по умолчанию `http://localhost:3000`.
  - sitemap/robots остаются в задаче 14; здесь только сборка мета.
  - Для `type=book` используется slug книги, берётся последняя опубликованная версия для фолбэков title/description/cover.
  - Для `type=version` используется ID версии; для `type=page` — slug опубликованной страницы.

Примечания по реализации:

- Файлы (основное):
  - `src/modules/seo/seo.service.ts` — метод `resolveByParams`, вспомогательный `resolve`, фолбэки OG/Twitter/Canonical, поддержка schema.org/Event при наличии полей в Seo.
  - `src/modules/seo/seo.controller.ts` — хендлер `GET /seo/resolve` с проверкой `type` и делегированием в сервис.
  - `src/modules/seo/dto/resolve-seo.dto.ts` — типы запроса (используются в сервисе и для Swagger enum).
  - Тесты: `test/seo.e2e-spec.ts` — добавлен сценарий для `/seo/resolve` (version + book fallback).

Правила приоритетов и фолбэки:

- Meta.title → Seo.metaTitle → `<Version.title — Version.author>` → `Page.title` → `Book {slug}`.
- Meta.description → Seo.metaDescription → Version.description → отсутствует.
- Canonical → Seo.canonicalUrl → `${LOCAL_PUBLIC_BASE_URL}{canonicalPath}`.
- OpenGraph: title/description/url берутся из Meta/Canonical; image → Seo.ogImageUrl → coverImageUrl.
- Twitter: card → Seo.twitterCard → `summary_large_image` при наличии OG image, иначе `summary`.
- Schema.org/Event включается, если заполнены event-поля в Seo.

Критерии готовности (проверено):

- [x] Комpиляция, типы и линтер без ошибок.
- [x] E2E: `seo.e2e-spec.ts` зелёный, включая новый smoke по `/seo/resolve`.
