# Changelog

Все заметные изменения в проекте документируются в этом файле.

Формат: Дата — Краткое название — Детали.

## 2025-08-25 — Категории: иерархия

- Добавлен self-relation `Category.parentId` + индекс, миграция `20250825140000_add_category_hierarchy`.
- Сервис/контроллер: create/update с `parentId`, запрет циклов/самопривязки, запрет удаления при наличии детей.
- Новые эндпоинты: `GET /categories/:id/children`, `GET /categories/tree`.
- Swagger: общий DTO `CategoryTreeNodeDto` для дерева и детей.
- E2E: сценарии добавлены в `test/categories.e2e-spec.ts` (дети, дерево, запрет удаления родителя, перенос ветки).
- Документация обновлена: `README.md`, `docs/ITERATION_TASKS.md`, добавлен `docs/AGENT_CONTEXT.md`.

## 2025-08-25 — Теги и Prisma обновление

## 2025-08-26 — Медиа-библиотека (MVP)

- Добавлена модель `MediaAsset` (key @unique, url, meta, createdById?, isDeleted) и связь с `User`.
- Реализован `MediaModule` с ручками:
  - `POST /media/confirm` — подтверждение/создание записи по key из `/uploads` (идемпотентно).
  - `GET /media` — листинг с фильтрами `q`, `type`, пагинация.
  - `DELETE /media/:id` — soft-delete + попытка удаления файла.
- Доступ к медиа-ручкам ограничен ролями admin|content_manager.
- Документация: обновлён `docs/ITERATION_TASKS.md` (задача 23 отмечена как выполненная, добавлены примечания и пошаговые инструкции по миграциям).

- Добавлены модели `Tag` и `BookTag` в Prisma, связь `BookVersion.tags`. Эндпоинты CRUD тегов и привязка/отвязка к версиям, публичная выборка по слагу тега. Добавлен модуль `TagsModule` и e2e `test/tags.e2e-spec.ts`.
- Миграционные конфликты с дублирующимися индексами `Like_*` решены путём замены `CREATE UNIQUE INDEX` на `CREATE UNIQUE INDEX IF NOT EXISTS` в соответствующих миграциях, после чего выполнен dev reset и повторное применение миграций.
- Обновлены версии Prisma: `prisma` 6.14.0, `@prisma/client` 6.14.0. В `schema.prisma` установлен `generator client { output = "../node_modules/.prisma/client" }`.
- README дополнен разделом о версиях Prisma, output и троблшутинге миграций.

## 2025-08-26 — Языки: политика выбора и расширяемость

- Добавлена утилита `shared/language/language.util.ts` (парсер Accept-Language, политика резолвинга: `?lang` → Accept-Language → DEFAULT_LANGUAGE).
- Применено в `GET /books/:slug/overview`, а также расширено на `GET /categories/:slug/books` и `GET /tags/:slug/books` (фильтрация по языку, `availableLanguages` в ответе, поддержка `?lang` и `Accept-Language`).
- E2E: `test/language-policy.e2e-spec.ts` и `test/language-policy-categories-tags.e2e-spec.ts` проверяют приоритеты и фолбэки.
- Документация обновлена: README (раздел про языки), `docs/ITERATION_TASKS.md` (помечено как выполнено), ADR `docs/adr/2025-08-26-language-policy-and-extensibility.md` (решение — остаться на Prisma enum `Language`).
- Конфигурация e2e переведена на последовательный режим (`maxWorkers: 1` в `test/jest-e2e.json`) для стабильности в dev-среде.
- Дополнение: публичный листинг `GET /books/:bookId/versions` теперь учитывает `Accept-Language`, если `?language` не задан. Добавлены README-примеры и e2e `test/book-versions-list-language.e2e-spec.ts`.

## 2025-08-30 — Мультисайт i18n: админ-контекст языка (листинги/создание)

- Добавлен заголовок `X-Admin-Language` (приоритетнее `:lang` в пути админки) для единого контекста языка.
- Pages (admin):
  - `GET /admin/:lang/pages` — фильтрация по эффективному языку.
  - `POST /admin/:lang/pages` — язык берётся из контекста; поле `language` в DTO сделано опциональным и игнорируется при создании.
- BookVersions (admin):
  - `GET /admin/:lang/books/:bookId/versions` — по умолчанию фильтрация по эффективному языку; `?language` переопределяет.
  - `POST /admin/:lang/books/:bookId/versions` — новый эндпоинт создания в выбранном админ-языке.
- Сервисы скорректированы: проверки дублей и сохранение учитывают эффективный язык.
- Обновлён Swagger (описания и заголовок `X-Admin-Language`).

## 2025-08-30 — Мультисайт i18n: SEO resolve по языку

- Добавлен учёт языка в публичном резолвере SEO:
  - Новый маршрут: `GET /:lang/seo/resolve` (язык пути приоритетнее `lang` и `Accept-Language`).
  - Расширен маршрут: `GET /seo/resolve?type=book|version|page&id=...&lang=...` + заголовок `Accept-Language`.
- Правила canonical:
  - `version` — всегда без префикса: `/versions/:id`.
  - `book`/`page` — с префиксом языка: `/:lang/books/:slug`, `/:lang/pages/:slug`.
- Реализация: метод `resolvePublic` в `SeoService`; контроллер получил маршруты и Swagger-декораторы.
- E2E: добавлен `test/seo-i18n.e2e-spec.ts` (приоритет пути, корректный canonical).

## 2025-08-30 — Таксономии через переводы (CategoryTranslation/TagTranslation)

- Prisma: добавлены модели `CategoryTranslation` и `TagTranslation`; уникальность slug перенесена в переводы (`@@unique([language, slug])`), на базовых `Category.slug`/`Tag.slug` снята `@unique`. Добавлены индексы и обратные связи.
- Публичные ручки категорий/тегов резолвят по `(language, slug)` перевода; маршруты доступны через `/:lang/categories/:slug/books` и `/:lang/tags/:slug/books`.
- Совместимость: сохранены legacy-маршруты без префикса языка — `GET /categories/:slug/books` и `GET /tags/:slug/books`; язык выбирается по `?lang` или `Accept-Language`.
- Админ-CRUD переводов:
  - `GET/POST /categories/:id/translations`, `PATCH/DELETE /categories/:id/translations/:language`.
  - `GET/POST /tags/:id/translations`, `PATCH/DELETE /tags/:id/translations/:language`.
- Seed: автодобавление перевода по умолчанию (en) для базовых категорий; upsert по slug заменён на `findFirst` + `create` из-за снятия уникальности на базовом slug.
- README/ENDPOINTS обновлены.

## 2025-09-05 — Dev-воркфлоу: Husky + lint-staged + pre-commit

- Добавлены dev-зависимости: husky, lint-staged.
- Добавлен скрипт `prepare` для инициализации Husky.
- Создан хук `.husky/pre-commit`: запускает `lint-staged` (eslint --fix + prettier) и быстрый `yarn typecheck`.
- В `package.json`:
  - Добавлен скрипт `typecheck` (`tsc --noEmit`).
  - Добавлена секция `lint-staged` с правилами для `*.{ts,tsx,js}` и `*.{md,yml,yaml,json}`.
- Документация обновлена: `docs/ITERATION_TASKS.md` (пункт 1 выполнен), README дополнен разделом о pre-commit проверках.

## 2025-09-05 — VS Code задачи (.vscode/tasks.json)

- Добавлен файл `.vscode/tasks.json` с задачами: `dev`, `lint`, `typecheck`, `test:e2e`, `test:e2e:serial`, `prisma:generate`, `prisma:migrate`, `prisma:seed`, `prisma:studio`.
- Настроены problem matchers: `$eslint-stylish` для lint, `$tsc` для typecheck. Фоновые задачи помечены `isBackground`.
- Обновлена документация: `docs/ITERATION_TASKS.md` (п. «2 — VS Code задачи» помечен как выполненный), README — раздел «VS Code задачи».

## 2025-09-05 — README актуализация

- Дополнен README: требования окружения, быстрый запуск, раздел `.env` с ключами и дефолтами, заметки по тестам, раздел про статические файлы `/static` и локальные загрузки, уточнение по Swagger (`/api/docs-json`).
- Цель — чтобы разработчик мог поднять проект без обращения к внешним источникам.

## 2025-09-05 — Docker Compose (dev): Postgres + Redis

- Добавлен `docker-compose.yml` с сервисами Postgres 14 и Redis 7 (alpine), healthchecks и volume `postgres_data`.
- Обновлён `.env.example`: `DATABASE_URL` по умолчанию указывает на compose (postgres/postgres), добавлены переменные `POSTGRES_DB|USER|PASSWORD|PORT`, `REDIS_PORT` для переопределений.
- README: новый раздел «Запуск через Docker Compose (dev)» с шагами `docker compose up -d` → `yarn prisma:migrate` → `yarn prisma:generate` → `yarn start:dev`.
- Цель — единая локальная среда для быстрого старта без ручной установки БД/Redis.

## 2025-09-05 — DevContainer и Makefile алиасы

- Добавлен `.devcontainer/` (VS Code): `devcontainer.json` + вспомогательный `docker-compose.devcontainer.yml` с сервисом `app` (Node 22). Автокоманда `yarn && yarn prisma:generate` после создания.
- Добавлен `Makefile` с алиасами: `up/down/logs/ps`, `migrate/generate/seed`, `dev`, `reset`, `prisma-studio`.
- README дополнен разделами «VS Code Dev Container» и «Makefile алиасы».
- Тюнинг DevContainer: добавлены `NODE_OPTIONS=--enable-source-maps --max-old-space-size=4096`, bash как терминал по умолчанию, расширение `ms-azuretools.vscode-docker`.
- Makefile дополнен целями `lint`, `typecheck`, `e2e`, `e2e-serial`.

## 2025-09-05 — AGENT_CONTEXT и инженерные правила

- Добавлен документ `docs/AGENT_CONTEXT.md`: золотые правила, контракт итерации, стиль и соглашения, тестирование, миграции Prisma, переменные окружения, VS Code задачи, шаблон PR, границы/безопасность, быстрые команды.
- Обновлён README (ссылка на документ) и `docs/ITERATION_TASKS.md` (п. 12.4 помечен выполненным с деталями).

## 2025-09-05 — .env.example расширение

-

## 2025-09-06 — BullMQ (интеграция базовая)

- Добавлены зависимости `bullmq` и `ioredis`.
- Новый модуль `QueueModule`: подключение к Redis из env, очередь `demo`, `Worker` с простым обработчиком, сервис и контроллер.
- Админ-ручки: `GET /queues/status`, `GET /queues/demo/stats`, `POST /queues/demo/enqueue`.
- Health/Readiness: Redis-проверка заменена на реальный `PING` через `ioredis` (если Redis настроен), иначе `skipped`.
- Документация: README (раздел про очереди), `.env.example` (`REDIS_*`, `BULLMQ_*`), `docs/ENDPOINTS.md` (ручки очередей), `docs/ITERATION_TASKS.md` (помечено как выполнено).

### 2025-09-06 — SecurityModule и воркер BullMQ: доработки

- SecurityModule теперь экспортирует `JwtAuthGuard` вместе с `RolesGuard` для единообразного подключения в контроллерах.
- Доработан демо‑воркер BullMQ:
  - Поддержан `BULLMQ_WORKER_LOG_LEVEL` (debug|info|warn|error) и `BULLMQ_WORKER_SHUTDOWN_TIMEOUT_MS` (таймаут graceful shutdown, по умолчанию 5000 мс).
  - Переключатель `BULLMQ_IN_PROCESS_WORKER`: `0|false` — выключить in‑process воркер (по умолчанию включён).
- Документация обновлена: README — раздел «Shared modules: Prisma/Security» и параметры воркера; `.env.example` дополнен новыми ключами; `docs/ENDPOINTS.md` — примечания к очередям.

## 2025-09-05 — Юнит‑тесты: контентные сущности (книги и версии)

- Добавлены unit‑тесты согласно плану (итерация 3):
  - `src/modules/book/book.service.spec.ts` — агрегатор overview (языковая политика, SEO‑фолбэки, флаги наличия разделов).
  - `src/modules/book-version/book-version.service.spec.ts` — доп. сценарии: list с Accept-Language, publish/unpublish, getPublic для draft = 404, listAdmin без фильтра по статусу.
  - `src/modules/book-summary/book-summary.service.spec.ts` — getByVersion (404 на отсутствующую версию) и upsert (create/update).

## 2025-09-06 — Прод: Dockerfile и docker-compose.prod

- Добавлен `Dockerfile` (multi-stage: builder → runner) с прод-окружением и запуском через `scripts/docker-entrypoint.sh`.
- Добавлен `docker-compose.prod.yml` для локального запуска prod-подобной связки `app + postgres`.
- Добавлен `.dockerignore` для оптимизации контекста сборки.
- Написаны unit-тесты для devops-артефактов: `src/devops/dockerfiles.spec.ts` (валидирует наличие и ключевые элементы конфигов).
- README дополнен разделом «Продакшн-сборка: Dockerfile + docker-compose.prod.yml» с примерами запуска.
- Все unit‑тесты проходят (`yarn test`). Документация обновлена: `docs/UNIT_TESTING_PLAN.md`, `docs/ITERATION_TASKS.md`.

## 2025-09-05 — Юнит‑тесты: таксономии и фильтрация

- Добавлены unit‑тесты согласно плану (итерация 4):
  - `src/modules/category/category.service.spec.ts` — проверки иерархии (цикл), запрет удаления при наличии детей, публичные резолверы с фильтрацией по языку и фолбэком на базовый slug, 404 при detach отсутствующей связи.
  - `src/modules/tags/tags.service.spec.ts` — публичные резолверы: фильтрация по языку, фолбэк к базовому slug; attach идемпотентен; detach идемпотентен.
- Запуск `yarn test` — все тесты зелёные. Обновлены `docs/UNIT_TESTING_PLAN.md` и `docs/ITERATION_TASKS.md`.

- Обновлён `.env.example`:
  - Добавлены переменные `PORT`, `HOST` (с комментариями, соответствуют дефолтам в коде).
  - Добавлена `CONTENT_MANAGER_EMAILS` для назначения роли `content_manager` по списку email.
  - Уточнено поведение `LOCAL_PUBLIC_BASE_URL` (SEO/Sitemap vs локальное хранилище) и рекомендованное dev-значение.
  - Оставлены и прокомментированы опциональные ключи для uploads/cache/rate-limit/CORS.
- README дополнен описаниями: `CONTENT_MANAGER_EMAILS`, `CORS_ORIGIN`, уточнение по `LOCAL_PUBLIC_BASE_URL`.
- `docs/ITERATION_TASKS.md`: задача «14. 6 — .env.example расширение» помечена выполненной, добавлены детали реализации и критерии приёмки.

### Дополнение: тестовое окружение

- Добавлен файл `.env.test.example` с примером переменных для e2e.
- README дополнен разделом про `.env.test` и механизм временной БД (`PRISMA_TEST_*`).

## 2025-09-06 — Юнит‑тесты: SEO, Sitemap и Public резолверы

- Добавлены unit‑тесты согласно плану (итерация 6):
  - `src/modules/seo/seo.service.spec.ts` — проверены фолбэки мета/OG/Twitter и canonical:
    - `type=version` — canonical всегда `/versions/:id`, без языкового префикса и без переопределения из SEO.
    - `type=book`/`type=page` — canonical с префиксом `/:lang`, язык выбирается по приоритету: path > query > `Accept-Language` > default.
  - `src/modules/sitemap/sitemap.service.spec.ts` — `robots.txt`, индекс sitemap по всем языкам (из Prisma enum `Language`), per-language sitemap (страницы и книги), кэширование по TTL (fake timers), уникальность слугов книг.
  - `src/modules/pages/pages.service.spec.ts` — public resolver с политикой языка и `setStatus` (publish/unpublish), 404 для отсутствующих сущностей.

## 2025-09-06 — Юнит‑тесты: Медиа и загрузки

- Добавлены unit‑тесты согласно плану (итерация 7):

## 2025-09-06 — Безопасность: Helmet, CORS, лимиты тела

- Добавлен централизованный конфиг безопасности `src/common/security/app-security.config.ts` и подключение в `main.ts`.
- Включены Helmet (CSP off в dev), CORS (`CORS_ORIGIN`), лимиты для JSON/URL-encoded (`BODY_LIMIT_JSON|URLENCODED`), raw 110 МБ для `/api/uploads/direct`, статика `/static`.
- Обновлены `.env.example` и README (секция про безопасность).
- Юнит‑тесты `src/common/security/app-security.config.spec.ts`: проверка security-заголовков, CORS preflight и 413 для больших тел.

## 2025-09-07 — Документация для фронтенд‑агентов

- Добавлена папка `docs/frontend-agents/` с материалами для разработки фронтенда (Next.js App Router, React Query/SWR, Auth.js):
  - `README.md`, `architecture-and-routing.md`, `auth-next-auth.md`, `data-fetching-and-types.md`,
    `api-cheatsheet.md`, `pages-contracts.md`, `seo.md`, `error-handling.md`, `quickstart.md`.
- Источник: синхронизировано с бэкенд‑доками `docs/ENDPOINTS.md` и e2e‑тестами (i18n/SEO/overview).
- Цель: скопировать в FE‑репозиторий, чтобы ИИ‑агенты могли опираться на актуальные контракты и политику i18n/SEO.
  - `src/modules/uploads/uploads.service.spec.ts` — presign (валидации CT/размера, генерация key/token/headers, запись токена в cache), directUpload (проверки токена/пользователя/CT/размера, сохранение и очистка токена), delete/publicUrl — делегирование стораджу.
  - `src/modules/media/media.service.spec.ts` — confirm (идемпотентность, снятие isDeleted), обработка P2002 при гонке, list с фильтрами q/type и исключением deleted, remove — soft‑delete + best‑effort удаление файла.
- Документация: обновлены `docs/UNIT_TESTING_PLAN.md` (п.7 отмечен как выполненный) и `docs/MEDIA_LIBRARY.md` (раздел про тесты).
- Все unit‑тесты проходят (`yarn test`). Обновлены: `docs/UNIT_TESTING_PLAN.md` (итерация 6 помечена выполненной, добавлены детали) и краткие пояснения в `docs/ITERATION_TASKS.md`.

## 2025-09-06 — Юнит‑тесты: хранилище и кэш (итерация 8)

- Добавлены unit‑тесты для общих слоёв хранения и кэша:
  - `src/shared/storage/storage.interface.spec.ts` — контракт StorageService через in‑memory реализацию (save/delete/exists/stat/getPublicUrl, потоковый ввод).
  - `src/shared/storage/local.storage.spec.ts` — драйвер локального стораджа: запись/чтение/статистика, идемпотентное удаление (ENOENT → no‑op), защита от directory traversal, формирование публичного URL.
  - `src/shared/cache/inmemory.cache.spec.ts` — InMemoryCacheService: set/get/del и TTL‑экспирация через fake timers.
- Документация обновлена: `docs/UNIT_TESTING_PLAN.md` (п. 8 помечен выполненным), `docs/ITERATION_TASKS.md` (статус юнит‑тестов обновлён).
- Результат: `yarn test` — все тесты зелёные; интерфейсы устойчивы к расширениям.

## 2025-09-06 — Юнит‑тесты: 9. Прочее (Users/Auth/ViewStats/Public)

- Добавлены unit‑тесты:
  - `src/modules/users/users.service.spec.ts` — me/update/delete (каскад), assign/revoke roles, list со staff‑фильтрами и ENV‑повышениями ролей.
  - `src/modules/auth/auth.service.spec.ts` — register (конфликт email, happy), login (неверный пароль/успех), refresh; моки Jwt/argon2/Config.
  - `src/modules/view-stats/view-stats.service.spec.ts` — create (валидация версии и времени), aggregate/top с in‑memory кэшем и суммой.
  - `src/modules/public/public.controller.spec.ts` — делегации и приоритет языка пути над query/header.
- Документация обновлена: `docs/UNIT_TESTING_PLAN.md` — пункт «9. Прочее» помечен выполненным, добавлены примечания.

## 2025-09-06 — Дополнение: расширены юнит‑кейсы

- AuthService: refresh — невалидный/протухший токен → Unauthorized; logout → success=true.
- UsersService: assignRole/revokeRole — NotFound для отсутствующих пользователя/роли; list — пагинация и staff=exclude.
- ViewStatsService: aggregate/top — фильтрация по source; валидация from>to; подтверждено кеширование.

## 2025-09-06 — Health/Readiness endpoints

- Добавлен `HealthModule` с `GET /health/liveness` и `GET /health/readiness`.
- Readiness проверяет Prisma (`SELECT 1`) и опционально Redis (через простой `RedisProbe` из env: `REDIS_URL|REDIS_HOST`). Если Redis не сконфигурирован — `redis: skipped`.
- Liveness не зависит от внешних сервисов; возвращает `status`, `uptime`, `timestamp`.
- Документация обновлена: `docs/ENDPOINTS.md`, `docs/ITERATION_TASKS.md`.
- Unit‑тесты: `src/modules/health/health.service.spec.ts`, `src/modules/health/health.controller.spec.ts` покрывают сценарии up/down/skipped.

## 2025-09-06 — Prometheus метрики

- Добавлен `MetricsModule` с `/metrics` на основе `prom-client`.
- Собираются default process‑метрики и HTTP‑гистограмма `http_request_duration_seconds` с лейблами `method`, `route`, `status_code`.
- Глобальный `MetricsInterceptor` измеряет длительность запросов и проставляет статус.
- Unit‑тесты: `src/modules/metrics/metrics.service.spec.ts`, `src/modules/metrics/metrics.controller.spec.ts`, `src/modules/metrics/metrics.interceptor.spec.ts`.

## 2025-09-06 — CI провайдер‑независимый (portable)

- Добавлен скрипт `scripts/ci.sh`, который выполняет линт, typecheck, unit‑тесты, опционально e2e (по `CI_E2E=1` и при наличии `DATABASE_URL`), и сборку.
- В `package.json` добавлен скрипт `ci`; в `Makefile` — цель `ci`; в `.vscode/tasks.json` — задача `ci`.
- Добавлены шаблоны: `.github/workflows/ci.yml` и `.gitlab-ci.yml`, оба вызывают `yarn ci`.
- Документация обновлена: `docs/ITERATION_TASKS.md` (пункт «11 — CI» помечен выполненным, добавлен раздел), README — раздел «CI (portable)».
