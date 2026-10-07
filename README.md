# Bibliaris: бэкенд

API сайта [bibliaris.com](https://bibliaris.com): книги и их версии на нескольких языках,
категории, теги, страницы, медиа, пользователи и роли, права на книги и публикация.
Стек: NestJS 11, Prisma 7 (PostgreSQL 14), Redis 7 (BullMQ), Node.js 22, Yarn classic.

- Продовое API: `https://api.bibliaris.com/api`, проверка живости — `/api/health/liveness`,
  готовности (с базой) — `/api/health/readiness`.
- Swagger UI — `/docs`, схема OpenAPI — `/docs-json`. Оба **без** префикса `/api`: Swagger
  подключается в `src/main.ts` до `setGlobalPrefix('api')`.

Соседние репозитории: фронт `books-front` (Next.js) и документация
[books-app-docs](https://github.com/Alex-Berezov/books-app-docs). Правила работы в этом
репозитории — `CLAUDE.md`, `AGENTS.md`, стиль кода — `STYLE_GUIDE.md`.

## Требования

- Node.js 22 (на ней собирается образ `Dockerfile` и идут оба конвейера).
- Yarn 1.x (`packageManager: yarn@1.22.22`). npm не используется: команды — только через
  `yarn` и скрипты из `package.json`.
- Docker с `docker compose` — для локальных PostgreSQL и Redis, а ещё для `yarn ci`
  (шаг проверки конфигов мониторинга запускает `promtool`/`amtool` в контейнерах).

## Локальный запуск

1. Зависимости:

   ```bash
   yarn
   ```

   На `yarn` ставятся git-хуки Husky (скрипт `prepare`).

2. Окружение: скопируйте `.env.example` в `.env` и заполните. Что за файлы `.env*`, какие
   из них коммитятся и откуда берутся продовые значения —
   [backend/guides/env-files.md](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/guides/env-files.md).
   Без этих значений локально не поднимется:
   - `REDIS_PASSWORD` — без него `docker compose` откажется запускать Redis (`:?` в
     `docker-compose.yml`, `LEGACY-071`);
   - `JWT_ACCESS_SECRET` и `JWT_REFRESH_SECRET` — приложение падает на старте, если секрет
     пуст или равен известной заглушке (`src/common/config/jwt-secrets.ts`);
   - `DATABASE_URL` — строка подключения к локальной базе (её же читает `prisma.config.ts`).

3. PostgreSQL 14 и Redis 7 из `docker-compose.yml`:

   ```bash
   docker compose up -d
   ```

   Порты публикуются только на `127.0.0.1` (по умолчанию `5432` и `6379`, переопределяются
   `POSTGRES_PORT` и `REDIS_PORT`). Данные Postgres живут в volume `postgres_data`.
   Остановка — `docker compose down`.

4. Миграции, клиент Prisma и тестовые данные:

   ```bash
   yarn prisma:migrate     # prisma migrate dev
   yarn prisma:generate    # prisma generate
   yarn prisma:seed        # prisma db seed -> prisma/seed.ts
   ```

   Сид заводит роли, демонстрационные книги, категории и теги и выдаёт роль `admin` почтам
   из `ADMIN_EMAILS`. Он же собирает базу-шаблон для e2e и используется конвейером
   `books-front`, поэтому сокращать его без проверки этих потребителей нельзя.

5. Приложение в режиме наблюдения:

   ```bash
   yarn start:dev
   ```

   По умолчанию слушает `0.0.0.0:5000` (`PORT`, `HOST`): API — `http://localhost:5000/api`,
   Swagger — `http://localhost:5000/docs`.

Прочее: `yarn prisma:studio` — Prisma Studio; `Makefile` даёт короткие алиасы тех же команд
(`make up`, `make migrate`, `make dev` и т.д.); в `.devcontainer/` лежит конфигурация
VS Code Dev Container, в `.vscode/tasks.json` — задачи VS Code.

## Проверки перед коммитом

| Команда                       | Что делает                                                            |
| ----------------------------- | --------------------------------------------------------------------- |
| `yarn typecheck`              | `tsc --noEmit` по `src` и по `test`                                   |
| `yarn lint`                   | ESLint с `--fix` и `--max-warnings=0`: любое предупреждение — красное |
| `yarn test`                   | юнит-тесты Jest (спеки лежат рядом с кодом в `src/`)                  |
| `yarn test:cov`               | юнит-тесты с порогами покрытия — так их гоняет CI                     |
| `yarn test:e2e`               | e2e из `test/` против локального Postgres                             |
| `yarn drift-check`            | сумма миграций против `prisma/schema.prisma` и имена в сыром SQL      |
| `yarn delegate-check`         | обращения к моделям Prisma против схемы                               |
| `yarn check-migration-compat` | миграция не ломает предыдущий образ приложения (ADR-018)              |
| `yarn check:response-schema`  | схема ответа в OpenAPI не беднее того, что отдаёт контроллер          |
| `yarn check:env`              | ключи окружения, которые читает код, есть в `.env.example`            |
| `yarn build`                  | сборка `nest build`                                                   |
| `yarn ci`                     | всё сразу: то же, что выполняет конвейер (`scripts/ci.sh`)            |

Что запускается само:

- `pre-commit` (`.husky/pre-commit`): `lint-staged` по изменённым файлам, `yarn drift-check`,
  `yarn typecheck`.
- `pre-push` (`.husky/pre-push`): `yarn drift-check`, `yarn test`.

Пороги покрытия проверяются только в `yarn test:cov`, обычный `yarn test` их не смотрит.

E2E: `test/setup-e2e.ts` читает `DATABASE_URL` из `.env.test` (образец — `.env.test.example`)
и создаёт рядом временные базы `e2e_<метка>`. Адрес обязан указывать на локальный Postgres —
прогон на чужой базе идёт по её данным. Один файл: `yarn test:e2e -- tags.e2e-spec.ts`.

## Конвейер и выкат

- **Push в `main` и pull request** запускают только проверки — `.github/workflows/ci.yml`:
  `yarn ci` (`scripts/ci.sh`), отдельный job e2e с postgres и redis и сборку Docker-образа
  без публикации. На прод push в `main` ничего не выкатывает.
- **Выкат на прод — тегом `vX.Y.Z`** через `.github/workflows/deploy.yml`
  («📦 Production Deployment»): проверки, e2e, сборка и публикация образа, затем выкат на
  сервер. Job `ci_gate` не пустит тег, у коммита которого нет зелёного прогона `ci.yml`.
  Ручной запуск того же workflow из вкладки Actions тоже есть.
- Миграции на проде применяет сам выкат: `prisma migrate deploy` перед пересозданием
  контейнера (`scripts/deploy_production.sh`, его зовёт `deploy.yml`); руками их не запускают. Каждая миграция обязана оставлять работоспособным предыдущий образ:
  удаление, переименование и сужение — в два релиза. Если выкат с миграциями не доехал —
  [migration-failure-runbook.md](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/guides/migration-failure-runbook.md).

Порядок, в котором правка доходит до тега, и ограничения на прод-доступ — в `CLAUDE.md`.

## Документация

Вся документация — в репозитории
[books-app-docs](https://github.com/Alex-Berezov/books-app-docs):

- [ai-context/README.md](https://github.com/Alex-Berezov/books-app-docs/blob/main/ai-context/README.md) — вход в документацию, с чего начинать.
- [backend/api/endpoints.md](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/api/endpoints.md) — все ручки, их права и поведение.
- [ai-context/api-contracts.md](https://github.com/Alex-Berezov/books-app-docs/blob/main/ai-context/api-contracts.md) — контракты между фронтом и бэкендом.
- [ai-context/database-schema.md](https://github.com/Alex-Berezov/books-app-docs/blob/main/ai-context/database-schema.md) — модели и поля базы (точные типы — `prisma/schema.prisma`).
- [backend/deployment/production.md](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/deployment/production.md) — устройство продового окружения и выката.
- [backend/deployment/quick-commands.md](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/deployment/quick-commands.md) — частые команды по проду.
- Руководства `backend/guides/`:
  [env-files](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/guides/env-files.md),
  [github-secrets](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/guides/github-secrets.md),
  [security](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/guides/security.md),
  [monitoring](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/guides/monitoring.md),
  [backup](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/guides/backup.md),
  [media-library](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/guides/media-library.md),
  [book-ratings](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/guides/book-ratings.md),
  [migration-failure-runbook](https://github.com/Alex-Berezov/books-app-docs/blob/main/backend/guides/migration-failure-runbook.md).

Предметные темы — слаги, категории и теги, языки и языковые префиксы маршрутов, публикация
версий, rate limiting, Swagger, медиа-библиотека, очереди — описаны там же, в README
не дублируются: ищите ручку в `endpoints.md`, а поведение — в коде модуля `src/modules/<имя>/`.

## Контракт OpenAPI

`libs/api-client/api-schema.json` — закоммиченный снимок схемы OpenAPI. После осознанной
смены контракта: `yarn openapi:snapshot`, затем `yarn openapi:types:from-schema`. Подробнее —
`libs/api-client/README.md`.
