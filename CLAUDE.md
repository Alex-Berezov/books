# Bibliaris — Backend (`books`)

Точка входа для Claude Code. Обязательные правила разработки лежат в `AGENTS.md` и подключены ниже — они являются частью этого файла.

@AGENTS.md

---

## Карта проекта: три репозитория

Bibliaris состоит из трёх независимых git-репозиториев. Все три доступны в этой сессии на чтение и запись (см. `.claude/settings.json` → `additionalDirectories`).

| Репозиторий      | Путь                       | Роль                                                          |
| ---------------- | -------------------------- | ------------------------------------------------------------- |
| `books`          | `D:\newDev\books`          | NestJS + Prisma + PostgreSQL, REST API                        |
| `books-front`    | `D:\newDev\books-front`    | Next.js 14 (App Router), TS, AntD 5, React Query, NextAuth v5 |
| `books-app-docs` | `D:\newDev\books-app-docs` | Документация — единый источник правды                         |

**Кросс-репозиторные правила:**

- Каждый репозиторий — отдельный git. Для git-операций в другом репо используй `git -C D:\newDev\books-front ...`, не `cd`.
- Меняешь контракт API (роут, DTO, формат ответа) → проверь потребителей во фронте (`books-front/api/endpoints/`, `types/`) и обнови документацию.
- Меняешь Prisma-enum `Language` → синхронизируй `books-front/lib/i18n/lang.ts` и `books-app-docs/ai-context/translation-rules.md`.

---

## Документация: читать вместо анализа кодовой базы

**Перед задачей читай документацию, а не сканируй проект целиком.** Порядок:

1. `D:\newDev\books-app-docs\ai-context\agent-rules.md` — правила для агента, читать первым.
2. Полная таблица «какой документ под какую задачу» — `D:\newDev\books-app-docs\ai-context\README.md`.
3. Из неё выбрать **только релевантные** документы. Не читать `ai-context/` целиком — это перерасход контекста.

Быстрая навигация (полная таблица — в `ai-context/README.md`):

| Задача                             | Документы в `books-app-docs`                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Любая backend-задача               | `ai-context/backend.md`, `backend/architecture/overview.md`                                  |
| Эндпоинты, контракты               | `ai-context/api-contracts.md`, `backend/api/endpoints.md`, `backend/api/url-structure.md`    |
| Данные, миграции, DTO              | `ai-context/database-schema.md`, `backend/PRISMA_MIGRATION_PRODUCTION.md`                    |
| Контент: книги, авторы, таксономии | `ai-context/content-model.md`, `ai-context/taxonomy-rules.md`, `ai-context/product-rules.md` |
| Auth / роли / RBAC                 | `ai-context/auth-and-permissions.md`, `backend/guides/security.md`                           |
| i18n, мультисайтность              | `ai-context/translation-rules.md`, `backend/guides/multisite-i18n.md`                        |
| SEO                                | `ai-context/seo-rules.md`                                                                    |
| Деплой, окружения                  | `backend/deployment/`, `backend/guides/env-files.md`                                         |
| Что нужно фронту                   | `backend/frontend-related/`                                                                  |
| Перед рефакторингом                | `ai-context/legacy-warnings.md`                                                              |
| Проблемы и известные баги          | `backend/troubleshooting/troubleshooting.md`                                                 |
| Что делается сейчас                | `ai-context/current-sprint.md`                                                               |

**Важно:** документация читается напрямую из `D:\newDev\books-app-docs\` обычными Read/Grep/Glob — MCP-сервер `books-docs` для этого не нужен.

---

## Обновление документации — обязательная часть задачи

Документация — не побочный артефакт. После каждой нетривиальной задачи выполняй Docs Update Check из `AGENTS.md` и `ai-context/agent-rules.md`:

- меняли API/DTO → `ai-context/api-contracts.md`, `backend/api/endpoints.md`;
- меняли схему БД → `ai-context/database-schema.md`, `ai-context/content-model.md`;
- меняли SEO / таксономии / i18n / auth / зависимости → соответствующий документ в `ai-context/`;
- архитектурное решение → `ai-context/architecture.md` + ADR в `ai-context/adr/` или `backend/architecture/adr/`;
- всегда → запись в `ai-context/changelog.md`;
- найден техдолг вне scope → записать в `ai-context/legacy-warnings.md`, **не чинить**.

Если правки не нужны — явно сказать: «документация не требует обновления».

---

## Quality gates (этот репозиторий)

```bash
yarn lint         # eslint --fix
yarn typecheck    # tsc --noEmit
yarn test         # jest
```

Если в той же задаче менялся фронтенд — прогнать и его проверки:

```bash
cd D:\newDev\books-front && yarn validate && yarn test
```

Код-стиль: `D:\newDev\books\STYLE_GUIDE.md`. Перед сдачей задачи сверить изменения с ним и явно указать результат проверки.

---

## Жёсткие ограничения

- **БД недоступна локально.** Бэкенд запускается только в Docker на VPS. Никаких `yarn prisma:migrate` / `yarn prisma:seed` / `prisma generate` / `prisma studio` / `psql` локально — эти команды заблокированы в `.claude/settings.json`.
- Файлы миграций в `prisma/migrations/` создавать можно — применяет их пользователь на VPS.
- **Никогда не коммитить и не пушить без явного разрешения** — ни в одном из трёх репозиториев.
- Без `any` и `@ts-ignore`. DTO — class-validator + `@ApiProperty`. Бизнес-логика в сервисах, не в контроллерах.
