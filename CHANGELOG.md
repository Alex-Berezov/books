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

- Добавлены модели `Tag` и `BookTag` в Prisma, связь `BookVersion.tags`. Эндпоинты CRUD тегов и привязка/отвязка к версиям, публичная выборка по слагу тега. Добавлен модуль `TagsModule` и e2e `test/tags.e2e-spec.ts`.
- Миграционные конфликты с дублирующимися индексами `Like_*` решены путём замены `CREATE UNIQUE INDEX` на `CREATE UNIQUE INDEX IF NOT EXISTS` в соответствующих миграциях, после чего выполнен dev reset и повторное применение миграций.
- Обновлены версии Prisma: `prisma` 6.14.0, `@prisma/client` 6.14.0. В `schema.prisma` установлен `generator client { output = "../node_modules/.prisma/client" }`.
- README дополнен разделом о версиях Prisma, output и троблшутинге миграций.
