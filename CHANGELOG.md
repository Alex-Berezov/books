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
