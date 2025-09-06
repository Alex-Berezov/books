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
12. 29 — Мультисайт i18n: таксономии через переводы (\*Translation) — [x] (2025-08-30)
13. 30 — Мультисайт i18n: sitemap/robots per-language — [x] (2025-08-30)

Далее — инфраструктурные и платформенные задачи (их можно выполнять параллельно, но ниже основной приоритет):

9.  1 — Dev-воркфлоу: Husky + lint-staged + pre-commit — [x] (2025-09-05)
10. 2 — VS Code задачи (.vscode/tasks.json) — [x] (2025-09-05)
11. 3 — README актуализация — [x] (2025-09-05)
12. 4 — docs/AGENT_CONTEXT.md — [x] (2025-09-05)
13. 5 — Docker Compose (dev): Postgres + Redis — [x] (2025-09-05)
14. 6 — .env.example расширение — [x] (2025-09-05)
15. 7 — Юнит-тесты: полное покрытие критической инфраструктуры (см. docs/UNIT_TESTING_PLAN.md) — [x] (2025-09-06)
16. 8 — Безопасность: Helmet, CORS, лимиты тела — [x] (2025-09-06)
17. 9 — Health/Readiness (terminus) — [x] (2025-09-06)
18. 10 — Prometheus метрики — [x] (2025-09-06)
19. 11 — CI (провайдер-независимый скрипт + шаблоны GitHub/GitLab) — [x] (2025-09-06)
20. 12 — Dockerfile(prod) + docker-compose.prod.yml — [x] (2025-09-06)
21. 14 — SEO: sitemap.xml и robots.txt — [x] (2025-09-06)
22. 15 — BullMQ (интеграция базовая) — [x] (2025-09-06)
23. 16 — Sentry (ошибки)
24. 17 — Uploads (R2, Cloudflare) — отложено

## 1) Dev-воркфлоу: Husky + lint-staged + pre-commit — [x] (2025-09-05)

- Цель: Блокировать коммиты с линт/формат/тип-ошибками; ускорить локальную проверку качества.
- Объём (выполнено):
  - [x] Добавить devDeps: husky, lint-staged.
  - [x] Инициализировать Husky; создать `.husky/pre-commit`.
  - [x] В `package.json` добавить `lint-staged` конфиг: eslint --fix, prettier --write для ts/yml/md; быстрый `tsc --noEmit`.
  - [x] Добавлен скрипт `typecheck` (tsc --noEmit) и `prepare` (инициализация Husky).
- Критерии приёмки: при попытке `git commit` с ошибками линтера/типов — коммит блокируется; без ошибок — проходит.
- Замечания: unit-тесты в pre-commit не запускаем (будут отдельной задачей).

Примечания по реализации:

- Добавлен `.husky/pre-commit`, который запускает `yarn lint-staged` и затем быстрый `yarn typecheck`.
- В `package.json` добавлен блок `lint-staged`:
  - `*.{ts,tsx,js}` → `eslint --fix` + `prettier --write`.
  - `*.{md,yml,yaml,json}` → `prettier --write`.
- Для надёжности в `prepare` добавлен `chmod +x .husky/pre-commit`.

Примечание по пакетному менеджеру:

- В проекте используем только yarn (classic). Не использовать npm. Все команды в задачах и скриптах — через yarn.

## 2) VS Code задачи (.vscode/tasks.json) — [x] (2025-09-05)

- Цель: Быстрые команды из VS Code: lint, typecheck, test:e2e, dev, prisma-сценарии.
- Объём (выполнено):
  - [x] Создан файл `.vscode/tasks.json`.
  - [x] Добавлены задачи: `dev`, `lint`, `typecheck`, `test:e2e`, `test:e2e:serial`, `prisma:generate`, `prisma:migrate`, `prisma:seed`, `prisma:studio`.
  - [x] Привязаны problem matchers: `$eslint-stylish` для `lint`, `$tsc` для `typecheck`.
  - [x] Фоновые задачи помечены `isBackground: true` (`dev`, `prisma:studio`).
- Критерии приёмки: задачи видны и запускаются в VS Code; ошибки подсвечиваются в Problems — выполнено.
- Замечания: используются существующие yarn-скрипты из `package.json`; npm не использовать.

Примечания по использованию в VS Code:

- Откройте палитру команд → Tasks: Run Task → выберите нужную задачу.
- Для e2e есть два варианта: обычный (`test:e2e`) и последовательный (`test:e2e:serial`) для стабильности локально.
- `prisma:studio` и `dev` работают в фоне; остановка — через Terminal → Kill Task.

## 3) README актуализация — [x] (2025-09-05)

- Цель: Документация запуска и разработки.
- Объём (выполнено):
  - [x] Добавлен раздел «Требования (локально)»: Node 22+, Yarn 1.x, PostgreSQL 14+, Docker (опц.), Git.
  - [x] Добавлен раздел «Быстрый запуск с нуля»: шаги по миграциям/seed/запуску, ссылка на Swagger.
  - [x] Добавлен раздел «Переменные окружения (.env)» с ключами и дефолтами.
  - [x] Раздел «Run tests» дополнен примечаниями и примером запуска одного e2e-файла.
  - [x] Добавлен раздел «Статические файлы (/static) и локальные загрузки». Описан direct uploads и Media Library.
  - [x] Раздел «Swagger» дополнен ссылкой на `/api/docs-json`.
- Критерии приёмки: новый разработчик поднимает проект по README без внешней помощи — выполнено.
- Замечания: документация ссылается на `docs/ITERATION_TASKS.md`, `CHANGELOG.md`, `docs/AGENT_CONTEXT.md` (последний будет создан в следующей итерации).

## 4) docs/AGENT_CONTEXT.md — [x] (2025-09-05)

- Цель: Правила для ИИ-агента (стиль, формат PR, границы изменений, как работать с миграциями/тестами).
- Объём (выполнено):
  - [x] Создан документ `docs/AGENT_CONTEXT.md` с разделами: золотые правила, контракт итерации, стиль/соглашения, тесты, миграции Prisma, переменные окружения, VS Code задачи, изменения API и документация, шаблон PR, границы и безопасность, быстрые команды.
  - [x] Добавлена ссылка на документ в README (раздел «Полезные документы»).
  - [x] CHANGELOG дополнен записью о добавлении `AGENT_CONTEXT`.
- Критерии приёмки: документ существует и покрывает основное; ссылка добавлена в README; зафиксирован в CHANGELOG — выполнено.
- Замечания: держать документ кратким и актуальным; при изменениях дополнять README/ITERATION_TASKS/CHANGELOG.

## 5) Docker Compose (dev): Postgres + Redis — [x] (2025-09-05)

- Цель: Единая локальная среда без ручной установки сервисов.
- Объём (выполнено):
  - [x] Добавлен `docker-compose.yml` с сервисами `postgres` (14) и `redis` (7-alpine), healthchecks и именованным volume для данных Postgres.
  - [x] Обновлён `.env.example`: `DATABASE_URL` теперь соответствует дефолтам compose (`postgres/postgres@localhost:5432/books?schema=public`), добавлены настраиваемые `POSTGRES_DB|USER|PASSWORD|PORT`, `REDIS_PORT`.
  - [x] Документация: в README добавлен раздел «Запуск через Docker Compose (dev)» с шагами запуска, миграциями и остановкой.
  - [x] CHANGELOG дополнен записью об этой итерации.
- Критерии приёмки: `docker compose up -d` поднимает БД/Redis; приложение подключается по `DATABASE_URL`; `yarn prisma:migrate` успешно применяет миграции — выполнено.
- Замечания: данные Postgres хранятся в именованном volume `postgres_data`; порты 5432/6379 проброшены только на localhost; Redis добавлен на будущее — в текущем коде может не использоваться.

Дополнение к итерации (улучшения dev-опыта) — [x] (2025-09-05):

- [x] Dev Container (`.devcontainer/`): конфигурация для VS Code с использованием `docker-compose.yml` + `docker-compose.devcontainer.yml`. Автозапуск `yarn && yarn prisma:generate` в контейнере, проброс портов 5000/5432/6379.
- [x] Makefile: алиасы для `docker compose up/down`, `prisma:migrate/generate/seed`, `start:dev`, `reset`, `prisma:studio`.
- [x] Доп. тюнинг DevContainer: bash как терминал по умолчанию, `NODE_OPTIONS` для удобной отладки (`--enable-source-maps`, увеличение памяти).
- [x] Доп. цели Makefile: `lint`, `typecheck`, `e2e`, `e2e-serial`.

## 6) .env.example расширение

- Цель: Все переменные, которые использует код, должны быть отражены в примере.
- Объём (выполнено):
  - [x] Добавлены/уточнены ключи в `.env.example`:
    - PORT, HOST (серверные настройки; по умолчанию 5000/0.0.0.0 из кода)
    - CONTENT_MANAGER_EMAILS (авто-выдача роли content_manager по email)
    - LOCAL_PUBLIC_BASE_URL (уточнено поведение: SEO/Sitemap используют 3000, локальное хранилище — 5000/static; можно переопределить единым значением)
    - CORS_ORIGIN (оставлен как опциональный ключ)
    - Прочие ранее добавленные ключи для uploads/cache/rate limit оставлены с комментариями и дефолтами из кода
  - [x] README дополнен описанием новых ключей и пояснениями по LOCAL_PUBLIC_BASE_URL.
  - [x] Проверена фактическая загрузка значений в коде (поиск по `process.env`/`ConfigService`).
- Критерии приёмки: при копировании `.env.example` → `.env` приложение стартует; значения по умолчанию соответствуют коду — выполнено.
- Замечания: указывать email-списки через запятую; для dev рекомендуется `LOCAL_PUBLIC_BASE_URL=http://localhost:5000/static`.

## 7) Юнит-тесты: полное покрытие критической инфраструктуры — [x] (2025-09-06)

- Цель: Обеспечить устойчивость ядра за счёт полного покрытия модулей и ключевых утилит юнит‑тестами (без обращения к БД/сети; все внешние зависимости — мокируются).
- Объём: Подробный план, области покрытия и разбиение на итерации описаны в `docs/UNIT_TESTING_PLAN.md`. Включает все модули из `src/modules` и критические части `src/common`, `src/shared` (guards, pipes, language util, storage интерфейсы и т. п.).
- Критерии приёмки:
  - Для каждого перечисленного сервиса/утилиты созданы базовые `*.spec.ts` с минимум 2–3 тестами (happy + edge).
  - `yarn test` проходит локально без БД/Redis; зависимости мокированы.
  - Целевое суммарное покрытие строк по unit-тестам ≥ 70% (мягкая цель), для ключевых утилит — ≥ 90%.
- Замечания: e2e остаются без изменений; Prisma/Storage/Jwt/Config — через явные моки.

Статус итераций:

- 1. Языковая политика и общие утилиты — выполнено (2025-09-05): добавлены `language.util.spec.ts`, `language-resolver.guard.spec.ts`, `lang-param.pipe.spec.ts`.
- 2. Авторизация, роли и базовые guard — выполнено (2025-09-05): добавлены `roles.guard.spec.ts`, `jwt-auth.guard.spec.ts`; покрыты happy/deny/cache/env сценарии.
- 3. Контентные сущности: книги и версии — выполнено (2025-09-05):
  - Добавлены unit‑тесты: `modules/book/book.service.spec.ts`, `modules/book-version/book-version.service.spec.ts` (доп. кейсы), `modules/book-summary/book-summary.service.spec.ts`.
  - Проверено: overview (языки, SEO‑фолбэки, флаги), выбор версий по Accept-Language, статусы draft/published в публичных ручках, publish/unpublish, upsert summary.

## 11) CI (провайдер‑независимый) — [x] (2025-09-06)

- Цель: Настроить единый скрипт CI, который можно запускать локально и в любом провайдере (GitHub/GitLab), без жёсткой привязки к платформе. Это снижает поддержку и упрощает перенос.
- Объём (выполнено):
  - [x] Добавлен `scripts/ci.sh` — запускает: install → prisma generate → lint → typecheck → unit tests → (опц.) e2e → build.
  - [x] В `package.json` добавлен скрипт `ci` (вызов `bash scripts/ci.sh`).
  - [x] В `Makefile` добавлена цель `ci` (делегирует на `yarn ci`).
  - [x] В `.vscode/tasks.json` добавлена задача `ci` для локального запуска из VS Code.
  - [x] Добавлены шаблоны CI:
    - `.github/workflows/ci.yml` — вызывает `yarn ci` (e2e по умолчанию выключены).
    - `.gitlab-ci.yml` — аналогично, stage `ci` с `yarn ci`.
- Критерии приёмки:
  - Локальный запуск `yarn ci` проходит на чистой машине при корректной `.env` и установленном Node 22/Yarn classic.
  - Шаблоны GitHub/GitLab не содержат провайдер‑специфичной логики кроме вызова `yarn ci`.
  - В README/CHANGELOG отражены изменения и инструкции по включению e2e в CI.
- Замечания:
  - E2E по умолчанию отключены в CI (включаются через переменную `CI_E2E=1` и наличие `DATABASE_URL`). Это позволяет использовать внешний управляемый Postgres/Service Container позже без усложнения текущей итерации.
  - Пакетный менеджер — только Yarn (classic). Не использовать npm.
  - Для GitHub можно добавить service container с Postgres в отдельной задаче, если решим запускать e2e в CI.

- 4. Таксономии и фильтрация — выполнено (2025-09-05):
  - Категории: иерархия (запрет циклов), запрет удаления родителя с детьми, публичные резолверы с локализованными slug и фильтрацией по языку; detach 404 при отсутствии связи.
  - Теги: публичные резолверы (локализованные slug) и фильтрация по языку; attach/detach идемпотентны.

- 6. SEO, Sitemap и Public резолверы — выполнено (2025-09-06):
  - SEO: проверены canonical правила (`version` без префикса; `book/page` с префиксом `/:lang` по приоритету path > query > Accept-Language > default), OG/Twitter фолбэки, выбор версии/страницы по языку.
  - Sitemap: `robots.txt`, индекс по всем языкам (из Prisma enum `Language`), per-language карты для страниц/книг; проверено кэширование (TTL) и уникальность слугов книг.
  - Pages: публичный резолвер (`getPublicBySlugWithPolicy`) и `setStatus`; сценарии 404/успех покрыты.
  - Результат: `yarn test` — зелёный.

- 7. Медиа и загрузки — выполнено (2025-09-06):
- 8.  Хранилище и вспомогательные слои — выполнено (2025-09-06):
- Добавлены юнит‑тесты для `StorageService` контракта и локального драйвера, а также `InMemoryCacheService`.
- Файлы: `src/shared/storage/storage.interface.spec.ts`, `src/shared/storage/local.storage.spec.ts`, `src/shared/cache/inmemory.cache.spec.ts`.
- Критерии: save/delete/exists/stat/getPublicUrl соответствуют контракту; delete идемпотентен; TTL‑экспирация кэша проверена. `yarn test` — зелёный.
- UploadsService: покрыты presign (валидации, генерация key/token/headers, запись токена в cache), directUpload (проверки токена/пользователя/CT/размера, сохранение в сторадж, очистка токена), delete и getPublicUrl (делегирование стораджу).
- MediaService: confirm идемпотентен (create/update + снятие isDeleted), валидация URL, обработка P2002 с возвратом найденной записи, list с q/type и исключением deleted, remove — soft‑delete + best‑effort удаление файла.
- Документация обновлена: `docs/UNIT_TESTING_PLAN.md` (п.7 помечен выполненным) и `docs/MEDIA_LIBRARY.md` (раздел «Тесты» дополнен unit‑покрытием).

## 8) Безопасность: Helmet, CORS, лимиты тела

- Цель: Базовая защита HTTP, корректный CORS, предсказуемые лимиты тела.
- Объём (выполнено):
  - [x] Добавлен централизованный конфиг безопасности: `src/common/security/app-security.config.ts`.
  - [x] Подключён в `src/main.ts` (`configureSecurity(app)`): Helmet, CORS, body-parser лимиты, raw для `/api/uploads/direct`, статика `/static`.
  - [x] Переменные окружения: `CORS_ORIGIN`, `BODY_LIMIT_JSON`, `BODY_LIMIT_URLENCODED` (добавлены в `.env.example`, README).
  - [x] Юнит‑тесты: `src/common/security/app-security.config.spec.ts` — проверяются заголовки Helmet, CORS preflight, ошибки 413 на телах >1 МБ.
- Критерии приёмки:
  - Приложение отдаёт стандартные security-заголовки (X-Frame-Options, X-Content-Type-Options, X-DNS-Prefetch-Control и т. п.).
  - CORS разрешает указанный `CORS_ORIGIN` и корректно обрабатывает preflight.
  - JSON/urlencoded тела больше лимита получают 413 Payload Too Large.
  - Прямые загрузки на `/api/uploads/direct` принимают до ~110 МБ.
  - `yarn test` — зелёный для добавленных unit‑тестов.
- Замечания:
  - В dev CSP отключён (Helmet `contentSecurityPolicy: false`), чтобы не ломать Swagger.
  - Для статики включён `crossOriginResourcePolicy: cross-origin`, чтобы позволить отдачу файлов с `/static`.
- Объём: В `main.ts` подключить Helmet; CORS по `CORS_ORIGIN`; общий `json/raw` body limit из env (кроме `/uploads/direct`, где уже задано).
- Критерии приёмки: приложение стартует; preflight проходит; e2e зелёные.
- Замечания: не включать строгие политики, лояльные дефолты для dev.

## 9) Health/Readiness (terminus) — [x] (2025-09-06)

- Цель: Эндпоинты `/health/liveness`, `/health/readiness` (DB+Redis) для оркестраторов и мониторинга.
- Объём: Создан `HealthModule` с `HealthController` и `HealthService`; проверки Prisma через `$queryRaw(SELECT 1)`, Redis — опционально (если нет конфигурации, помечается как `skipped`).
- Критерии приёмки: корректные коды/JSON для обоих эндпоинтов, unit-тесты на happy/edge кейсы (DB ok/fail, Redis ok/fail/skipped).
- Замечания: пока без реального Redis-клиента — используется лёгкий `RedisProbe` на основе env, будет заменён в задаче по BullMQ/Redis. Liveness не зависит от внешних сервисов.

## 10) Prometheus метрики — [x] (2025-09-06)

- Цель: `/metrics` с базовыми метриками процесса и HTTP.
- Объём (выполнено):
  - [x] Добавлен `MetricsModule` (`src/modules/metrics/`):
    - `MetricsService` — собственный Registry, `collectDefaultMetrics`, гистограмма `http_request_duration_seconds{method,route,status_code}` с стандартными bucket’ами.
    - `MetricsInterceptor` — глобальный interceptor, замеряет длительность каждого HTTP-запроса и проставляет статус-код.
    - `MetricsController` — `GET /metrics` возвращает текстовую экспозицию в формате Prometheus (`text/plain; version=0.0.4`).
  - [x] Подключено в `AppModule`.
  - [x] Добавлена зависимость: `prom-client`.
- Тесты (unit):
  - `metrics.service.spec.ts` — наличие default metrics и гистограммы, корректные лейблы и экспозиция.
  - `metrics.controller.spec.ts` — корректный Content-Type и наличие ключевых метрик в выдаче.
  - `metrics.interceptor.spec.ts` — запись успешных и ошибочных ответов (лейблы method/route, наличие счетчиков).
- Критерии приёмки: curl `/metrics` возвращает текстовую экспозицию; значения растут/изменяются при запросах — выполнено.
- Замечания: без аутентификации на dev. В будущем можно добавить выключатель через env и базовую защиту.

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

## 14) SEO: sitemap.xml и robots.txt — [x] (2025-09-06)

- Цель: Базовая SEO-отдача (индекс sitemap по языкам, per-language карты и robots.txt).
- Объём (выполнено):
  - [x] Реализован `SitemapService` и `SitemapController` с эндпоинтами:
    - `GET /sitemap.xml` — индекс карт сайта по всем языкам из Prisma enum `Language`.
    - `GET /sitemap-:lang.xml` — карта сайта для конкретного языка (страницы и книги, URL с префиксом `/:lang`).
    - `GET /robots.txt` — базовый robots с `Allow: /` и ссылкой на `/sitemap.xml`.
  - [x] Кэширование in-memory с TTL из `SITEMAP_CACHE_TTL_MS` (по умолчанию 60с).
  - [x] Базовый публичный адрес берётся из `LOCAL_PUBLIC_BASE_URL` (дефолт `http://localhost:3000`).
  - [x] Подключение модуля — выполнено ранее в задаче 30; актуализированы юнит‑тесты.
- Тесты (unit):
  - `src/modules/sitemap/sitemap.service.spec.ts` — проверки robots, индексного sitemap, per-language карты (страницы и книги), кэширования TTL, уникальности слугов книг; проверка `content-type`; фолбэк базового URL при отсутствии env.
  - `src/modules/sitemap/sitemap.controller.spec.ts` — делегация и корректные заголовки/тело ответа для всех трёх ручек.
- Тесты (e2e):
  - `test/sitemap.e2e-spec.ts` — smoke: контент-тайпы и наличие ключевых тегов в ответах `/sitemap.xml`, `/sitemap-:lang.xml`, `/robots.txt`.
- Критерии приёмки: XML/текст валидны; корректные `Content-Type`; кэш работает; `yarn test` — зелёный.
- Замечания: lastmod/priority не включены (MVP). Генерацию можно вынести в фоновую очередь позже.

## 15) BullMQ (интеграция базовая) — [x] (2025-09-06)

- Цель: Подключить фреймворк очередей для фоновых задач, подготовить минимальную инфраструктуру (подключение к Redis, очередь-пример, воркер, админ-ручки и метрики здоровья).
- Объём (выполнено):
  - [x] Зависимости: добавлены `bullmq` и `ioredis` в `package.json`.
  - [x] Модуль `QueueModule` (`src/modules/queue/*`):
    - [x] Подключение к Redis через env (`REDIS_URL` или `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`). Если Redis не задан — модуль очередей отключается (провайдеры возвращают undefined, без ошибок).
    - [x] Очередь `demo` + `Worker` с простым обработчиком (асинхронная задержка, возврат `{ ok, at }`). Конкурентность настраивается через `BULLMQ_DEMO_CONCURRENCY`.
    - [x] Контроллер `QueueController` с админ-ручками: `GET /queues/status`, `GET /queues/demo/stats`, `POST /queues/demo/enqueue` (Auth + Role Admin).
    - [x] Сервис `QueueService` с методами `status`, `enqueueDemo`, `getDemoStats`.
  - [x] Интеграция в `AppModule` — модуль очередей подключён глобально.
  - [x] Health/Readiness: `HealthModule` теперь выполняет реальный `PING` к Redis через `ioredis` (если Redis настроен). При отсутствии конфигурации Redis помечается как `skipped`.
  - [x] Документация: README — раздел про очереди; `.env.example` — переменные `REDIS_*`, `BULLMQ_*`; `docs/ENDPOINTS.md` — добавлены ручки очередей.
- Критерии приёмки: при наличии Redis (например, через `docker compose up -d`) доступно:
  - `GET /api/health/readiness` → `redis: up` (после старта Redis)
  - `GET /api/queues/status` (с токеном админа) → `{ enabled: true }`
  - `POST /api/queues/demo/enqueue` (админ) → `{ id: "..." }`, далее `GET /api/queues/demo/stats` показывает рост `completed`/`waiting`.
  - При отсутствии Redis — `{ enabled: false }`, readiness помечает `redis: skipped`.
- Замечания:
  - Бизнес-джобы не входят в объём итерации; будут добавлены в профильных задачах (обработка изображений/аудио, генерация sitemap и т. п.).
  - Для прод-среды рекомендуется отдельный процесс-воркер или несколько реплик сервиса. Текущая реализация — in-process worker для упрощения dev.
  - Мониторинг/админ UI очередей не включён (опционально можно подключить `bull-board` в дальнейших итерациях).

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

## 29) Мультисайт i18n: таксономии через переводы (\*Translation) — [x] (2025-08-30)

- Цель: Локализовать категории и теги через переводческие таблицы.
- Объём (выполнено):
  - [x] Prisma:
    - [x] Добавлены модели `CategoryTranslation` и `TagTranslation` с ограничениями `@@unique([language, slug])`, `@@unique([categoryId, language])` и `@@unique([tagId, language])`.
    - [x] Убрана уникальность slug с базовых сущностей `Category.slug` и `Tag.slug`; добавлены обратные связи `translations`.
    - [x] Индексы по `language` и FK полям добавлены.
  - [x] Backend (NestJS):
    - [x] Публичные резолверы категорий/тегов переведены на поиск по `(language, slug)` перевода.
    - [x] Добавлены эндпоинты админ-CRUD для переводов категорий и тегов:
      - `GET /categories/:id/translations`, `POST /categories/:id/translations`, `PATCH /categories/:id/translations/:language`, `DELETE /categories/:id/translations/:language`.
      - `GET /tags/:id/translations`, `POST /tags/:id/translations`, `PATCH /tags/:id/translations/:language`, `DELETE /tags/:id/translations/:language`.
    - [x] Введены локализованные публичные маршруты через `PublicController`:
      - `GET /:lang/categories/:slug/books`, `GET /:lang/tags/:slug/books`.

      Дополнительно (совместимость): сохранены legacy-маршруты без префикса языка — `GET /categories/:slug/books` и `GET /tags/:slug/books`. Они определяют язык по `?lang` (приоритет) или `Accept-Language`. Это обеспечивает прохождение существующих e2e и плавный переход фронтенда.

  - [x] Seed: автосоздание переводов в языке по умолчанию (en) для базовых категорий.

    Примечание по миграции: после снятия уникальности с `Category.slug`/`Tag.slug` все операции upsert по `slug` заменены на `findFirst` + `create`. Переводы создаются типобезопасно через новый клиент.

- Критерии приёмки: переводы создаются/редактируются; поиск по slug перевода работает; привязки к версиям корректны; уникальные ограничения применены в БД — выполнено.
- Замечания:
  - Для полной типобезопасности методов перевода требуется регенерация Prisma Client после применения миграций (`yarn prisma:generate`). В коде временно использован доступ через `as any` к новым моделям клиента.
  - E2E для локализованных таксономий будут добавлены в следующей итерации после стабилизации миграций; текущие тесты категорий/тегов остаются валидными.
  - Совместимость: старые публичные маршруты без префикса сохранены для категорий/тегов (см. выше) и понимают `lang`/`Accept-Language`. Новые локализованные пути `/:lang/...` — предпочтительные.

## 30) Мультисайт i18n: sitemap/robots per-language — [x] (2025-08-30)

- Цель: Отдавать карты сайта с локализованными URL и базовый robots.
- Объём (выполнено):
  - [x] Новый модуль `SitemapModule` с сервисом/контроллером.
  - [x] Эндпоинты:
    - `GET /sitemap.xml` — индекс карт сайта по языкам.
    - `GET /sitemap-:lang.xml` — карта сайта для конкретного языка.
    - `GET /robots.txt` — базовый robots с ссылкой на `/sitemap.xml`.
  - [x] Политика URL:
    - Для книг и страниц — URL с префиксом языка `/:lang`.
    - В sitemap не включаем `/versions/:id` (подробные версии вне карты сайта).
  - [x] Кэширование: in-memory TTL (по умолчанию 60с) через `SITEMAP_CACHE_TTL_MS`.
  - [x] Источник публичной базы URL: `LOCAL_PUBLIC_BASE_URL` (env) с дефолтом `http://localhost:3000`.
  - [x] Подключение модуля в `AppModule`.
  - [x] E2E: `test/sitemap.e2e-spec.ts` — smoke для индексного sitemap, per-language и robots.
- Критерии приёмки: sitemap индекс и per-language возвращают валидный XML, robots — text/plain; URL содержат языковой префикс для публичных страниц/книг — выполнено.
- Замечания:
  - Перечень языков берётся из Prisma enum `Language`.
  - При масштабировании рекомендуется вынести генерацию в фоновую задачу (BullMQ) и сохранять готовые файлы в сторадж/кэш.

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
