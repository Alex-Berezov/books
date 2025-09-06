Разное:

- Проект использует yarn (classic) — не используйте npm. Все команды запускайте через yarn скрипты.

## Требования (локально)

- Node.js 22+
- Yarn (classic) 1.x — проект использует только yarn, npm не поддерживается
- PostgreSQL 14+ (локально или в Docker)
- Git

Быстрый старт (с yarn):

Установка зависимостей: `yarn`
Генерация Prisma Client: `yarn prisma:generate`
Миграции dev: `yarn prisma:migrate`
Сиды: `yarn prisma:seed`
Запуск dev: `yarn start:dev`
E2E тесты: `yarn test:e2e`

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ yarn install
```

## Быстрый запуск с нуля

1. Установите зависимости: `yarn`
2. Создайте `.env` (см. раздел «Переменные окружения»): задайте `DATABASE_URL`
3. Примените миграции и сгенерируйте клиент Prisma:

```bash
yarn prisma:migrate
yarn prisma:generate
```

4. При необходимости — наполните dev-данными: `yarn prisma:seed`
5. Запустите приложение в dev-режиме: `yarn start:dev` (или VS Code задача «dev»)
6. Swagger будет доступен на: http://localhost:5000/api/docs
7. Метрики Prometheus: http://localhost:5000/metrics

### Запуск через Docker Compose (dev)

Если у вас не установлен PostgreSQL/Redis локально, используйте готовый compose:

1. Скопируйте `.env.example` → `.env` и при необходимости отредактируйте `DATABASE_URL` (по умолчанию указывает на `postgres://postgres:postgres@localhost:5432/books?schema=public`).

2. Поднимите сервисы БД и Redis:

```bash
docker compose up -d
```

3. Примените миграции и сгенерируйте Prisma Client:

```bash
yarn prisma:migrate
yarn prisma:generate
```

4. (Опционально) запустите сиды:

```bash
yarn prisma:seed
```

5. Запустите приложение:

````bash
yarn start:dev

6. Проверьте метрики Prometheus:

```bash
curl -s http://localhost:5000/metrics | head -n 20
````

````

Остановка сервисов:

```bash
docker compose down
````

Примечания:

- Данные Postgres сохраняются в именованном volume `postgres_data`.
- Порты: Postgres `5432`, Redis `6379` (можно переопределить через переменные в `.env`).
- Redis добавлен для будущих задач (кэш/очереди); текущий код может работать без него.

### Очереди (BullMQ) — базовая интеграция

- Поддерживается базовая интеграция BullMQ с Redis. При наличии `REDIS_URL` или `REDIS_HOST`/`REDIS_PORT` модуль очередей активируется и поднимает демонстрационную очередь `demo` с воркером.
- Админ-эндпоинты (Auth + Role Admin):
  - `GET /queues/status` — статус подсистемы очередей (enabled: true|false)
  - `GET /queues/demo/stats` — счётчики очереди demo
  - `POST /queues/demo/enqueue` — поставить тестовую задачу `{ delayMs?: number }`
- Переменные окружения:
  - `REDIS_URL` или `REDIS_HOST`/`REDIS_PORT` (+ `REDIS_PASSWORD`)
  - `BULLMQ_DEMO_QUEUE` (по умолчанию demo)
  - `BULLMQ_DEMO_CONCURRENCY` (по умолчанию 2)
  - `BULLMQ_IN_PROCESS_WORKER` (0/1) — запуск in-process воркера вместе с приложением (dev по умолчанию 1)
  - `BULLMQ_WORKER_LOG_LEVEL` — уровень логирования воркера: debug|info|warn|error (по умолчанию info)
  - `BULLMQ_WORKER_SHUTDOWN_TIMEOUT_MS` — таймаут graceful shutdown воркера (по умолчанию 5000)
- Если Redis не настроен — модуль очередей отключается автоматически; health/readiness продолжает работать, Redis помечается как `skipped`.

#### Отдельный процесс воркера

- Запуск демо‑воркера в отдельном процессе: `yarn worker:demo`.
- Воркерт читает те же переменные Redis (`REDIS_URL` или `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`), а также поддерживает конфиги выше (`BULLMQ_DEMO_QUEUE`, `BULLMQ_DEMO_CONCURRENCY`, `BULLMQ_WORKER_LOG_LEVEL`, `BULLMQ_WORKER_SHUTDOWN_TIMEOUT_MS`).

### Продакшн-сборка: Dockerfile + docker-compose.prod.yml

В репозитории добавлен продакшн Dockerfile (multi-stage) и compose для близкого к прод окружения:

- `Dockerfile` — multi-stage: builder (yarn build, prisma generate) → runner (NODE_ENV=production, только prod-зависимости). На старте запускает `scripts/docker-entrypoint.sh` (выполняет `prisma migrate deploy`, затем `node dist/main.js`).
- `docker-compose.prod.yml` — сервисы `app` и `postgres`. По умолчанию пробрасывает порт 5000 и использует переменные из `.env`.

Быстрый запуск (локально, production-режим):

```bash
# Собрать образ и запустить (profile prod)
docker compose --profile prod -f docker-compose.prod.yml up -d --build

# Логи приложения
docker compose --profile prod -f docker-compose.prod.yml logs -f app
```

Полезные примечания:

- Переменные окружения читаются из `.env` (DATABASE_URL и др.). Для prod рекомендуется задать `CORS_ORIGIN`, `LOCAL_PUBLIC_BASE_URL`.
- Migrate deploy запускается автоматически при старте контейнера, если доступен `prisma` в `node_modules/.bin`.
- Для lean-образа используется `.dockerignore` (исключены node_modules, dist, тесты, docs и пр.).
- Порт и параметры БД можно переопределять через переменные среды: `PORT`, `POSTGRES_*`.

VS Code задачи (Docker prod):

- `docker:build:prod` — сборка образа по `docker-compose.prod.yml` (с profile `prod`).
- `docker:up:prod` — запуск prod‑связки в фоне.
- `docker:down:prod` — остановка.
- `docker:logs:prod` — просмотр логов приложения.
- `docker:tag:prod` — тегирование образа: использует env `REGISTRY` и `IMAGE_TAG` (дефолт: `localhost` и `latest`).
- `docker:push:prod` — публикация образа в реестр.

В `docker-compose.prod.yml` добавлен healthcheck для сервиса `app` (проверяет `GET /metrics`). Compose использует profile `prod` (активируйте флагом `--profile prod`).

### VS Code Dev Container (опционально)

В репозитории есть конфигурация `.devcontainer/` для запуска в контейнере разработчика:

- Использует текущий `docker-compose.yml` для Postgres/Redis и дополнительный `docker-compose.devcontainer.yml` с `app` сервисом на Node 22.
- Откройте папку в VS Code → «Reopen in Container». После сборки контейнера автоматически выполнится `yarn && yarn prisma:generate`.
- Порты 5000/5432/6379 проброшены наружу; рабочая директория маунтится как volume.

### Makefile алиасы

Для ускорения типовых команд добавлен `Makefile`:

```bash
make up           # docker compose up -d
make down         # docker compose down
make logs         # логи compose
make ps           # статус сервисов
make migrate      # yarn prisma:migrate
make generate     # yarn prisma:generate
make seed         # yarn prisma:seed
make dev          # yarn start:dev
make reset        # npx prisma migrate reset --force (удалит данные!)
make prisma-studio# yarn prisma:studio
make lint         # yarn lint
make typecheck    # yarn typecheck
make e2e          # yarn test:e2e
make e2e-serial   # yarn test:e2e:serial
```

## Переменные окружения (.env)

Минимально требуется задать:

- DATABASE_URL — строка подключения к PostgreSQL (например, `postgresql://user:pass@localhost:5432/books?schema=public`)

Опциональные (имеют дефолты в коде):

- PORT — порт HTTP-сервера (по умолчанию 5000)
- HOST — адрес прослушивания (по умолчанию 0.0.0.0)
- DEFAULT_LANGUAGE — язык по умолчанию для i18n-политики (по умолчанию `en`)
- LOCAL_UPLOADS_DIR — каталог для локальных загрузок (по умолчанию `var/uploads`)
- LOCAL_PUBLIC_BASE_URL — базовый публичный адрес для генерации ссылок. Если не задан — по умолчанию `http://localhost:3000` в SEO/Sitemap, и `http://localhost:5000/static` для локального стораджа. Рекомендуется для dev ставить `http://localhost:5000/static`.
- CORS_ORIGIN — разрешённый Origin для CORS (по умолчанию `*`).
- BODY_LIMIT_JSON — лимит для JSON-тел (по умолчанию `1mb`).
- BODY_LIMIT_URLENCODED — лимит для urlencoded-тел (по умолчанию `1mb`).
- UPLOADS_MAX_IMAGE_MB — лимит изображений в МБ (по умолчанию 5)
- UPLOADS_MAX_AUDIO_MB — лимит аудио в МБ (по умолчанию 100)
- UPLOADS_PRESIGN_TTL_SEC — TTL для presign (по умолчанию 600)
- UPLOADS_ALLOWED_IMAGE_CT — список разрешённых content-type изображений через запятую (по умолчанию `image/jpeg,image/png,image/webp`)
- UPLOADS_ALLOWED_AUDIO_CT — список разрешённых content-type аудио (по умолчанию `audio/mpeg,audio/mp4,audio/aac,audio/ogg`)
- SITEMAP_CACHE_TTL_MS — кэширование sitemap/robots (по умолчанию 60000)
- SEO_CACHE_TTL_MS — кэш SEO-бандла (опц., по умолчанию выключено)
- VIEWS_CACHE_TTL_MS — кэш агрегатов просмотров (по умолчанию 30000)
- RATE_LIMIT_ENABLED — включение лимитов (0/1)
- RATE_LIMIT_COMMENTS_PER_MINUTE — лимит операций для комментариев за окно (дефолт 10)
- RATE_LIMIT_COMMENTS_WINDOW_MS — размер окна для лимита (дефолт 60000)
- ADMIN_EMAILS — список email через запятую для авто-выдачи роли admin (например, `admin@example.com`)
- CONTENT_MANAGER_EMAILS — список email через запятую для авто-выдачи роли content_manager

### Безопасность: Helmet, CORS и лимиты тела

В приложении включены базовые защиты и предсказуемые лимиты:

- Helmet с безопасными заголовками (в dev отключён CSP, чтобы не мешать Swagger).
- CORS: `CORS_ORIGIN` (строка, по умолчанию `*`), методы/заголовки разрешены по списку; поддержаны заголовки `X-Admin-Language` и `Accept-Language`.
- Лимиты тела: JSON и URL-encoded по 1 МБ по умолчанию. Настраиваются переменными `BODY_LIMIT_JSON` и `BODY_LIMIT_URLENCODED`.
- Отдельный маршрут для прямых загрузок принимает «сырое» тело до ~110 МБ: `POST /api/uploads/direct`.

## Shared modules: Prisma/Security

В приложении есть два глобальных «shared» модуля, упрощающих DI и переиспользование безопасности и БД:

- `PrismaModule` (`src/shared/prisma/prisma.module.ts`) — помечен `@Global()`, предоставляет и экспортирует `PrismaService`. Доступен во всех модулях без явного импорта сервиса.
- `SecurityModule` (`src/shared/security/security.module.ts`) — помечен `@Global()`, импортирует `PrismaModule`, предоставляет и экспортирует `RolesGuard` и `JwtAuthGuard` для единообразия.

Как использовать в контроллерах:

```ts
import { UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin') // или Role.Admin из enum
```

Примечания:

- Гварды НЕ зарегистрированы глобально через `APP_GUARD`, чтобы публичные ручки оставались открытыми по умолчанию. Подключайте `@UseGuards` на нужных контроллерах/методах.
- Ранее локальные провайдеры `RolesGuard`/`PrismaService` из модулей удалены — используйте shared‑модули. Это устраняет циклы зависимостей и упрощает e2e.

### Мониторинг: Prometheus метрики

- Эндпоинт: `GET /metrics` — текстовая экспозиция в формате Prometheus (content-type `text/plain; version=0.0.4`).
- Содержимое:
  - Стандартные метрики процесса (`collectDefaultMetrics` из `prom-client`).
  - Гистограмма `http_request_duration_seconds{method,route,status_code}` для всех HTTP‑запросов (глобальный interceptor).
- На dev не защищено аутентификацией. Для prod можно добавить защиту/ограничение CIDR в будущих итерациях.

См. `src/common/security/app-security.config.ts` и `src/main.ts` для включения.

## Языки: политика выбора и расширяемость

- Поддерживаемые языки задаются Prisma enum `Language` (en, es, fr, pt). Добавление нового языка выполняется миграцией Prisma (см. ADR ниже).
- Режим мультисайта: публичные URL имеют префикс языка `/:lang` (например, `/en/book/...`). Язык берётся из префикса пути и имеет приоритет над `?lang` и `Accept-Language`.
- Совместимость: `?lang` и заголовок `Accept-Language` могут использоваться как fallback.
- Реализация:
  - Резолвер языка из префикса пути (request-scoped контекст) + утилита `src/shared/language/language.util.ts` для fallback.
  - Применяется в публичных ручках: `GET /:lang/books/:slug/overview`, `GET /:lang/categories/:slug/books`, `GET /:lang/tags/:slug/books`, `GET /:lang/books/:bookId/versions`.
  - Совместимость категорий/тегов: дополнительно доступны legacy-маршруты без префикса языка — `GET /categories/:slug/books` и `GET /tags/:slug/books`. Они выбирают язык по `?lang` (приоритетнее) или `Accept-Language` и возвращают `availableLanguages`.
- E2E: добавлены сценарии с префиксом языка; тесты приоритезации префикса над заголовками.

  ### SEO resolve и i18n
  - Публичные резолверы SEO учитывают язык:
    - `GET /seo/resolve?type=book|version|page&id=...&lang=xx` + заголовок `Accept-Language`.
    - `GET /:lang/seo/resolve?type=...&id=...` — язык пути имеет приоритет над query/header.
  - Канонический URL:
    - Для `version` фиксируется без префикса: `/versions/:id`.
    - Для `book`/`page` включает префикс языка: `/:lang/books/:slug`, `/:lang/pages/:slug`.

ADR: см. `docs/adr/2025-08-26-language-policy-and-extensibility.md` — зафиксировано решение оставаться на Prisma enum, пока не потребуется динамическое управление списком языков через отдельную таблицу.
Дополнительно: `docs/adr/2025-08-29-multisite-i18n.md` и `docs/MULTISITE_I18N.md` — решение о мультисайте и план внедрения.

Быстрые ссылки по документации:

- Политика URL для i18n и «нейтральных» API: см. раздел «Политика URL для i18n и «нейтральных» API (зафиксировано)» в `docs/MULTISITE_I18N.md`.

### Админ-контекст языка

- Админка работает в выбранном языке. На бэке поддерживается префикс `/admin/:lang` и заголовок `X-Admin-Language` (имеет приоритет над языком пути).
- Листинги и создание контента используют эффективный язык: Pages (`GET/POST /admin/:lang/pages`), BookVersions (`GET/POST /admin/:lang/books/:bookId/versions`).
- В DTO создание Page/BookVersion поле `language` игнорируется (берётся из админ-контекста) — оставлено опциональным для совместимости.

## Compile and run the project

```bash
# development
$ yarn run start

# watch mode
$ yarn run start:dev

# production mode
$ yarn run start:prod
```

## Run tests

```bash
# unit tests
$ yarn run test

# e2e tests
$ yarn run test:e2e

# test coverage
$ yarn run test:cov
```

Примечания по юнит‑тестам:

- Юнит‑сьюты запускаются без БД/Redis; зависимости (Prisma/Storage/Jwt/Config) мокируются.
- Подробный план покрытия и статус итераций — в `docs/UNIT_TESTING_PLAN.md`.

Дополнение (2025-09-06): расширены кейсы юнит‑тестов

- AuthService: refresh — невалидный/протухший токен → Unauthorized; logout → success=true.
- UsersService: assignRole/revokeRole — NotFound для отсутствующих пользователя/роли; list — пагинация и staff=exclude.
- ViewStatsService: aggregate/top — фильтрация по source; валидация from>to; подтверждено кеширование.

Примечания по тестам:

- Юнит‑тесты: `yarn test`.
- E2E‑тесты: `yarn test:e2e` (в dev настроен последовательный режим для стабильности).
- Запуск одного e2e-файла:

```bash
yarn test:e2e -- tags.e2e-spec.ts
```

### Тестовое окружение (.env.test)

- Для e2e используется временная БД, создаваемая на основе `DATABASE_URL` из `.env`.
- В репозитории добавлен пример `.env.test.example` — можно скопировать в `.env.test` при необходимости.
- Скрипты e2e (test/setup-e2e.ts, test/teardown-e2e.ts) автоматически выставляют служебные переменные `PRISMA_TEST_DB_NAME` и `PRISMA_TEST_ADMIN_URL` и не требуют их ручной установки.

## VS Code задачи

В репозитории настроены задачи VS Code для быстрого запуска типовых сценариев разработки. Файл конфигурации: `.vscode/tasks.json`.

Доступные задачи:

- dev — `yarn start:dev` (фон)
- lint — `yarn lint` (с подсветкой ошибок через `$eslint-stylish`)
- typecheck — `yarn typecheck` (с `$tsc` problem matcher)
- test:e2e — `yarn test:e2e`
- test:e2e:serial — `yarn test:e2e:serial`
- prisma:generate — `yarn prisma:generate`
- prisma:migrate — `yarn prisma:migrate`
- prisma:seed — `yarn prisma:seed`
- prisma:studio — `yarn prisma:studio` (фон)

- ci — `yarn ci` (portable CI: install → prisma generate → lint → typecheck → unit → (опц.) e2e → build)

Как запускать:

1. Откройте VS Code → Command Palette → "Tasks: Run Task" → выберите задачу.
2. Фоновые задачи (`dev`, `prisma:studio`) останавливаются через Terminal → Kill Task.

## CI (portable)

- В репозитории есть провайдер‑независимый скрипт CI: `scripts/ci.sh`. Он выполняется локально командой `yarn ci` или через Makefile `make ci`.
- Скрипт включает: установку зависимостей, `prisma:generate`, `lint`, `typecheck`, юнит‑тесты и сборку. E2E выключены по умолчанию.
- Чтобы включить E2E в CI (или локально под управлением CI), задайте переменные окружения: `CI_E2E=1` и `DATABASE_URL` (валидное подключение к Postgres). Тогда будет выполнен `yarn test:e2e:serial`.
- Шаблоны конфигов поставляются для обоих провайдеров:
  - GitHub: `.github/workflows/ci.yml` — вызывает `yarn ci`.
  - GitLab: `.gitlab-ci.yml` — stage `ci`, также вызывает `yarn ci`.

## Статические файлы (/static) и локальные загрузки

- Локальные загрузки сохраняются в каталог `LOCAL_UPLOADS_DIR` (по умолчанию `var/uploads`).
- Файлы автоматически отдаются по пути `/static`, пример: `http://localhost:5000/static/<relative-path>`.
- Прямые загрузки (локальный драйвер): POST `/api/uploads/direct` (лимит ~110 МБ, см. `main.ts`).
- Переиспользование файлов через Media Library:
  - POST `/media/confirm` — создать/обновить `MediaAsset` по `key` (идемпотентно);
  - GET `/media` — поиск/листинг по `q` и `type`;
  - DELETE `/media/:id` — мягкое удаление.

## Dev-воркфлоу: pre-commit (Husky + lint-staged)

- В репозитории настроен pre-commit хук Husky, который выполняет:
  - `lint-staged` для изменённых файлов (`eslint --fix` и `prettier --write` для `*.{ts,tsx,js}`; `prettier --write` для `*.{md,yml,yaml,json}`).
  - Быстрый типовой контроль: `yarn typecheck` (`tsc --noEmit`).
- Установка и активация:
  - Husky инициализируется автоматически через `"prepare": "husky && chmod +x .husky/pre-commit || true"` при `yarn`.
  - Используется только Yarn (classic). npm не поддерживается.
- Обход/починка:
  - В экстренных случаях можно пропустить хук: `git commit -m "msg" --no-verify` (не рекомендуется).
  - Если хук не исполняется из-за прав, выполните: `chmod +x .husky/pre-commit`.

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ yarn install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).

# Books App Back

## Slug валидация

Используем единый паттерн для slug'ов книг/категорий:

Паттерн (RegExp): `^[a-z0-9]+(?:-[a-z0-9]+)*$`

Требования:

- Только латинские буквы в нижнем регистре и цифры
- Разделитель — дефис `-`
- Без пробелов, без двойных/крайних дефисов

Примеры:

- Допустимо: `harry-potter`, `book-123`, `a1-b2-c3`
- Недопустимо: `Harry-Potter` (прописные), `book__123` (подчёркивания), `book--123` (двойной дефис), `-abc` или `abc-` (крайние дефисы)

Подсказка: в DTO используется `SLUG_PATTERN` и `SLUG_REGEX` из `src/shared/validators/slug.ts`; сообщения валидации берутся из `SLUG_REGEX_README`.

## Категории

- Sitemap/Robots per-language

Добавлены SEO-эндпоинты для карт сайта и robots.txt с учётом языковых префиксов:

- GET /api/sitemap.xml — индекс, содержит ссылки на per-language карты (`/sitemap-en.xml`, `/sitemap-es.xml`, ...)
- GET /api/sitemap-:lang.xml — карта для конкретного языка; URL включают `/:lang` префикс (книги и страницы)
- GET /api/robots.txt — базовый robots с ссылкой на `/sitemap.xml`

Настройки:

- LOCAL_PUBLIC_BASE_URL — базовый публичный адрес (по умолчанию http://localhost:3000)
- SITEMAP_CACHE_TTL_MS — TTL кэша генерации sitemap/robots (по умолчанию 60000 мс)

Примечание: версии книг `/versions/:id` намеренно не включаются в sitemap; канонические публичные URL формируются для книг/страниц с языковым префиксом.

Базовые операции: CRUD и привязка категорий к версиям книг. Также поддерживается иерархия категорий (родитель/дети). Локализация реализована через переводы CategoryTranslation.

- POST /categories — создать (admin|content_manager)
- PATCH /categories/:id — обновить (admin|content_manager)
- DELETE /categories/:id — удалить (admin|content_manager)
- GET /categories — список
- GET /:lang/categories/:slug/books — версии по слагу перевода категории (язык из префикса); также возвращает availableLanguages
- GET /categories/:id/children — прямые дочерние категории
- GET /categories/tree — полное дерево категорий
- GET /categories/:id/translations — список переводов (admin|content_manager)
- POST /categories/:id/translations — создать перевод (admin|content_manager)
- PATCH /categories/:id/translations/:language — обновить перевод (admin|content_manager)
- DELETE /categories/:id/translations/:language — удалить перевод (admin|content_manager)

Привязка к версиям:

- POST /versions/:id/categories — привязать категорию к версии
- DELETE /versions/:id/categories/:categoryId — отвязать

Правила и валидация:

- Поле parentId опционально; чтобы снять родителя, передайте `parentId: null` в PATCH.
- Запрещены циклы и самопривязка (`parentId != id`).
- Нельзя удалить категорию, если у неё есть дочерние категории.

Swagger схемы:

- Дерево и список детей описаны через общий DTO `CategoryTreeNodeDto` (см. `src/modules/category/dto/category-tree-node.dto.ts`).
- Эндпоинты:
  - `GET /categories/tree` → `[CategoryTreeNodeDto]`
  - `GET /categories/:id/children` → `[CategoryTreeNodeDto]`

  ## Теги

  Базовые операции: CRUD и привязка тегов к версиям книг. Локализация реализована через переводы TagTranslation.
  - GET /tags — список (поддерживает page, limit)
  - POST /tags — создать (admin|content_manager)
  - PATCH /tags/:id — обновить (admin|content_manager)
  - DELETE /tags/:id — удалить (admin|content_manager)
  - GET /:lang/tags/:slug/books — версии по слагу перевода тега (язык из префикса); возвращает также availableLanguages
  - GET /tags/:id/translations — список переводов (admin|content_manager)
  - POST /tags/:id/translations — создать перевод (admin|content_manager)
  - PATCH /tags/:id/translations/:language — обновить перевод (admin|content_manager)
  - DELETE /tags/:id/translations/:language — удалить перевод (admin|content_manager)

  Привязка к версиям:
  - POST /versions/:id/tags — привязать тег к версии (идемпотентно)
  - DELETE /versions/:id/tags/:tagId — отвязать тег от версии (идемпотентно)

  Правила и валидация:
  - Slug валидируется паттерном `^[a-z0-9]+(?:-[a-z0-9]+)*$` (см. `src/shared/validators/slug.ts`).

## Swagger

- Доступно по `/api/docs`.
- Схемы и примеры подключены для ключевых DTO модулей (Books, Versions, Categories в т.ч. `CategoryTreeNodeDto`).
- JSON документ для интеграций: `/api/docs-json`.

## Медиа-библиотека

- Загрузки выполняются через модуль Uploads: пресайн → прямой upload → получение `key` и `publicUrl`.
- Для повторного использования файлов добавлен модуль Media:
  - POST `/media/confirm` — создать/обновить запись `MediaAsset` по `key` (идемпотентно).
  - GET `/media` — листинг с фильтрами `q` (подстрока по key/url) и `type` (префикс contentType), пагинация.
  - DELETE `/media/:id` — мягкое удаление записи и попытка удаления файла.
- Доступ только для ролей admin|content_manager.
- Модель `MediaAsset` описана в `prisma/schema.prisma` (создать миграцию локально перед запуском e2e для медиа).

## Prisma

- Генерация клиента: `yarn prisma:generate`
- Миграции (dev): `yarn prisma:migrate`
- Сиды: `yarn prisma:seed`
- Studio: `yarn prisma:studio`

Требуется переменная окружения `DATABASE_URL` в `.env`.

### Версии и output Prisma Client

- Prisma CLI: 6.14.0
- @prisma/client: 6.14.0
- Конфигурация генератора: в `prisma/schema.prisma` задано `output = "../node_modules/.prisma/client"` (путь указан относительно файла схемы). В итоге клиент попадает в корневой `./node_modules/.prisma/client`. Импорт в приложении остаётся через `@prisma/client`.

Зачем это нужно:

- Устойчивая генерация клиента и совместимость с будущими версиями Prisma.
- Исключает перезапись сторонних артефактов, а также упрощает кэширование в CI.

### Траблшутинг миграций (PostgreSQL)

Если при `prisma migrate dev` / `prisma migrate status` видите ошибки вида дублирующихся индексов (например, `Like_userId_commentId_key`), это часто связано с повторным созданием одного и того же уникального индекса в ранних миграциях. Подход к исправлению на dev:

1. Сделать создание индексов идемпотентным: заменить `CREATE UNIQUE INDEX ...` на `CREATE UNIQUE INDEX IF NOT EXISTS ...` в конфликтующих миграциях.
2. Сбросить dev-базу и повторно применить миграции.
3. Перегенерировать Prisma Client.

Пример команд:

```bash
# ВНИМАНИЕ: удалит данные в dev-базе
npx prisma migrate reset --force

# Применить миграции и сгенерировать клиент заново
yarn prisma:migrate
yarn prisma:generate
```

Полезные документы:

- Итерационный план и статус: `docs/ITERATION_TASKS.md`
- Контекст и правила для ИИ-агента: `docs/AGENT_CONTEXT.md`
- Обзор проекта: `docs/PROJECT_OVERVIEW.md`
- История изменений: `CHANGELOG.md`

## Публикация версий (draft/published)

- Новые версии книг создаются в статусе `draft`.
- Публичные ручки возвращают только `published` версии.
- Эндпоинты управления статусом (требуют роли admin или content_manager):
- `PATCH /versions/:id/publish` — публикует версию, выставляет `publishedAt`.
- `PATCH /versions/:id/unpublish` — снимает с публикации, `status=draft`, `publishedAt=null`.
- Листинги:
- Публично: `GET /books/:bookId/versions` — только опубликованные.
- Админ: `GET /admin/books/:bookId/versions` — включает черновики (требует авторизации и ролей).
- Также публичный листинг поддерживает параметр `includeDrafts=true`, но результат корректен только для авторизованных админов/контент-менеджеров.

Локализация листинга версий (`GET /books/:bookId/versions`):

- Если параметр `language` не указан, сервер применяет политику `Accept-Language` → `DEFAULT_LANGUAGE` → первый доступный.
- Если `?language=` задан явно, он имеет приоритет над заголовком `Accept-Language`.
- Значение `DEFAULT_LANGUAGE` задаётся переменной окружения (см. `.env.example`, по умолчанию `en`).

Примеры (curl):

```bash
# Создать версию (draft)
curl -X POST \
 -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
 -H "Content-Type: application/json" \
 -d '{
   "language":"en","title":"Title","author":"Author","description":"Desc",
   "coverImageUrl":"https://example.com/c.jpg","type":"text","isFree":true
 }' \
 http://localhost:3000/books/<BOOK_ID>/versions

# Опубликовать
curl -X PATCH -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
 http://localhost:3000/versions/<VERSION_ID>/publish

# Снять с публикации
curl -X PATCH -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
 http://localhost:3000/versions/<VERSION_ID>/unpublish

# Публичный список (только published)
curl http://localhost:3000/books/<BOOK_ID>/versions

# Публичный список с выбором языка через Accept-Language (если ?language не передан)
curl -H "Accept-Language: es-ES,fr;q=0.9,en;q=0.5" \
  http://localhost:3000/books/<BOOK_ID>/versions

# Явный выбор языка параметром (приоритетнее Accept-Language)
curl "http://localhost:3000/books/<BOOK_ID>/versions?language=fr"

# Админский список (включая draft)
curl -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
 http://localhost:3000/admin/books/<BOOK_ID>/versions
```

## Rate limiting

- Включение: `RATE_LIMIT_ENABLED=1` (по умолчанию выключено)
- Настройки (опционально):
  - `RATE_LIMIT_COMMENTS_PER_MINUTE` — число действий в окно (дефолт 10)
  - `RATE_LIMIT_COMMENTS_WINDOW_MS` — размер окна в миллисекундах (дефолт 60000)
    Примечание: несмотря на название "PER_MINUTE", лимит работает с любым окном, задаваемым `RATE_LIMIT_COMMENTS_WINDOW_MS`.
