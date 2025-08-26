Разное:

- Проект использует yarn (classic) — не используйте npm. Все команды запускайте через yarn скрипты.

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

## Языки: политика выбора и расширяемость

- Поддерживаемые языки задаются Prisma enum `Language` (en, es, fr, pt). Добавление нового языка выполняется миграцией Prisma (см. ADR ниже).
- Политика выбора языка в публичных ручках:
  - Принимаем `?lang=` (приоритетнее всего) и/или заголовок `Accept-Language` (RFC 7231), затем фолбэк на `DEFAULT_LANGUAGE` (env, по умолчанию en).
  - Если указанный язык отсутствует среди доступных у сущности — используем следующий источник (Accept-Language → DEFAULT_LANGUAGE). Если и он отсутствует — выбирается первый доступный.
- Реализация:
  - Утилита `src/shared/language/language.util.ts` — парсинг Accept-Language и резолвинг языка.
  - Применено в публичных ручках: `GET /books/:slug/overview`, `GET /categories/:slug/books`, `GET /tags/:slug/books`, а также `GET /books/:bookId/versions` (см. ниже заметки и примеры).
- E2E: `test/language-policy.e2e-spec.ts` и `test/language-policy-categories-tags.e2e-spec.ts` покрывают приоритет `?lang` над Accept-Language и фолбэк на дефолтный язык.
  - Конфиг e2e переведён на последовательный запуск (`maxWorkers: 1`) для стабильности (ограничение соединений БД в dev-среде).

ADR: см. `docs/adr/2025-08-26-language-policy-and-extensibility.md` — зафиксировано решение оставаться на Prisma enum, пока не потребуется динамическое управление списком языков через отдельную таблицу.

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

Базовые операции: CRUD и привязка категорий к версиям книг. Также поддерживается иерархия категорий (родитель/дети).

- POST /categories — создать (admin|content_manager)
- PATCH /categories/:id — обновить (admin|content_manager)
- DELETE /categories/:id — удалить (admin|content_manager)
- GET /categories — список
- GET /categories/:slug/books — версии по слагу категории
  - Параметры локализации: `?lang`, заголовок `Accept-Language`; возвращает также `availableLanguages`.
- GET /categories/:id/children — прямые дочерние категории
- GET /categories/tree — полное дерево категорий

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

  Базовые операции: CRUD и привязка тегов к версиям книг.
  - GET /tags — список (поддерживает page, limit)
  - POST /tags — создать (admin|content_manager)
  - PATCH /tags/:id — обновить (admin|content_manager)
  - DELETE /tags/:id — удалить (admin|content_manager)
  - GET /tags/:slug/books — версии по тегу
  - Параметры локализации: `?lang`, заголовок `Accept-Language`; возвращает также `availableLanguages`.

  Привязка к версиям:
  - POST /versions/:id/tags — привязать тег к версии (идемпотентно)
  - DELETE /versions/:id/tags/:tagId — отвязать тег от версии (идемпотентно)

  Правила и валидация:
  - Slug тега валидируется тем же паттерном, что и категории/книги: `^[a-z0-9]+(?:-[a-z0-9]+)*$` (см. `src/shared/validators/slug.ts`).

  Примечания:
  - Публичная выборка `GET /tags/:slug/books` сейчас не фильтрует версии по статусу публикации. При необходимости можно ограничить до только `published` в последующей итерации.
  - Операции привязки/отвязки реализованы идемпотентно (повторные вызовы безопасны).

## Swagger

- Доступно по `/api/docs`.
- Схемы и примеры подключены для ключевых DTO модулей (Books, Versions, Categories в т.ч. `CategoryTreeNodeDto`).

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
