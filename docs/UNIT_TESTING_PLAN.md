# План юнит‑тестирования: критическая инфраструктура

Цель: обеспечить устойчивость ядра приложения за счёт целенаправленного покрытия модулей и вспомогательных слоёв юнит‑тестами. В фокусе — чистая логика без БД и сети; любые внешние зависимости мокируются.

Источник запуска: `yarn test` (Jest, unit), e2e остаются без изменений (`yarn test:e2e`).

---

## Область покрытия

Покрываем все модули из `src/modules` и критические помощники из `src/common`, `src/shared`. Везде, где используется Prisma/файловое хранилище/кэш/внешние клиенты — внедряем мок‑слои.

- Модули:
  - audio-chapter — AudioChapterService
  - auth — AuthService (хеширование/валидация логики, без JWT подписей — мок `JwtService`)
  - book — BookService (языковая политика, выбор overview‑версий)
  - book-summary — BookSummaryService
  - book-version — BookVersionService (логика фильтров, статусы draft/published, выборка по языку)
  - bookshelf — BookshelfService (уникальность/идемпотентность)
  - category — CategoryService (иерархия: валидация parentId, запрет циклов/удаления родителя)
  - chapter — ChapterService (уникальность в пределах версии; связи)
  - comments — CommentsService (модерация/лимиты — без хранилища; мок RateLimit)
  - likes — LikesService (идемпотентность лайков; уникальные ограничения — на уровне сервиса)
  - media — MediaService (confirm идемпотентен; soft delete)
  - pages — PagesService (public resolver + политика языка; publish/unpublish)
  - public — PublicController вспомогательная логика (через тест сервиса/утилиты, контроллеры — опционально через unit с моками)
  - reading-progress — ReadingProgressService (уникальность на пользователя/версию; идемпотентность)
  - seo — SeoService (resolve bundles, фолбэки title/desc/canonical/OG/Twitter)
  - sitemap — SitemapService (формирование XML, конфигурация base URL, кеширование в памяти)
  - status — (если есть логика, иначе пропускаем)
  - tags — TagsService (attach/detach идемпотентны; фильтрация по языку)
  - uploads — UploadsService (драйвер стораджа мокируется; лимиты тела не проверяем в unit)
  - users — UsersService (хеширование паролей, уникальность email — только логика уровня сервиса)
  - view-stats — ViewStatsService (инкременты/агрегация — без БД; проверяем контракты вызовов)

- Общие слои:
  - common/guards: RolesGuard, JwtAuthGuard (минимальные unit на ветки allow/deny при мокнутом контексте); LanguageResolverGuard (приоритет пути/квери/Accept-Language/дефолт)
  - common/pipes: LangParamPipe (валидные/невалидные значения)
  - shared/language/language.util: parseAcceptLanguage, resolveRequestedLanguage, getDefaultLanguage
  - shared/storage: StorageModule/LocalStorage — тесты на контракт интерфейса через мок драйвера
  - config: при необходимости — утилиты чтения конфигов (если присутствуют)

---

## Принципы и договорённости

- Тесты уровня unit не трогают Prisma напрямую. Всё взаимодействие с БД — через мок `PrismaService` (фабрика `createMockPrisma()` внутри тестов).
- Для стораджа/кэша/внешних сервисов — явные интерфейсы и мок‑реализации; побочные эффекты не допускаются.
- На сервис — минимум 2–3 теста: happy path + 1–2 edge‑кейса (например, отсутствие сущности, конфликт уникальности, неверный язык).
- Проверяем только логику ветвлений/трансформаций/контрактов, а не детали имплементации (Given/When/Then).
- Файлы тестов размещаем рядом с кодом: `*.spec.ts` в соответствующих папках модулей.

---

## Разбиение на итерации

Итерации независимы и могут выполняться параллельно малыми порциями, но каждая завершает цельный слой.

1. Языковая политика и общие утилиты — [x] (2025-09-05)

- Цель: стабилизировать базовую политику языка и вспомогательные слои, на которые опираются модули.
- Объём:
  - shared/language/language.util.spec.ts — parseAcceptLanguage/resolveRequestedLanguage/getDefaultLanguage
  - common/pipes/lang-param.pipe.spec.ts
  - common/guards/language-resolver.guard.spec.ts
- Критерии: >90% покрытие для файла language.util, ветки приоритета языка подтверждены.

2. Авторизация, роли и базовые guard

- Цель: предсказуемые ветки allow/deny без внешних вызовов.
- Объём:
  - common/guards/jwt-auth.guard.spec.ts — допускает при корректном payload; отклоняет при отсутствии/недостаточных правах (JwtService мок)
  - common/guards/roles.guard.spec.ts — допускает роль admin/content_manager; отклоняет остальных
- Критерии: happy+deny сценарии покрыты; контракты ExecutionContext корректны.

3. Контентные сущности: книги и версии

- Цель: бизнес‑логика выбора версий и статусов без БД.
- Объём:
  - modules/book/book.service.spec.ts — overview/доступные языки
  - modules/book-version/book-version.service.spec.ts — фильтры по языку/статусу, выбор без прямой language
  - modules/book-summary/book-summary.service.spec.ts — фолбэки/валидации
- Критерии: сценарии публикации/черновиков/языков подтверждены.

4. Таксономии и фильтрация

- Цель: устойчивость привязок и поиска по (language, slug).
- Объём:
  - modules/category/category.service.spec.ts — иерархия, запреты удаления/циклов
  - modules/tags/tags.service.spec.ts — attach/detach идемпотентны; фильтрация по языку
- Критерии: все запретные ветки дают ожидаемые ошибки.

5. Социальные фичи: комментарии, лайки, прогресс

- Цель: избежать регрессий в идемпотентности и ограничениях.
- Объём:
  - modules/comments/comments.service.spec.ts — модерация/лимиты (RateLimit мок)
  - modules/likes/likes.service.spec.ts — двойной лайк не увеличивает счётчик; снятие лайка идемпотентно
  - modules/reading-progress/reading-progress.service.spec.ts — upsert‑семантика
- Критерии: happy/edge сценарии подтверждены.

6. SEO, Sitemap и Public резолверы

- Цель: корректность выдачи мета/канонических URL и XML.
- Объём:
  - modules/seo/seo.service.spec.ts — фолбэки и canonical с префиксом языка
  - modules/sitemap/sitemap.service.spec.ts — генерация индексного и per-language sitemap, TTL кеша (через подмену таймера)
  - modules/pages/pages.service.spec.ts — public resolver с политикой языка, publish/unpublish
- Критерии: текст/каноникал соответствуют правилам; кеш не застревает.

7. Медиа и загрузки

- Цель: безопасная идемпотентность и soft‑delete.
- Объём:
  - modules/media/media.service.spec.ts — confirm существующей записи обновляет метаданные и снимает isDeleted
  - modules/uploads/uploads.service.spec.ts — валидации, имя файла, size/type; сторадж мок
- Критерии: повторный confirm не создаёт дубликаты; удаления помечают isDeleted.

8. Хранилище и вспомогательные слои

- Цель: единый контракт стораджа и кэша.
- Объём:
  - shared/storage/storage.interface.spec.ts — тестируем через фиктивную реализацию (in‑memory) контракт методов getPublicUrl/put/remove
  - common/cache (если есть) — базовые сценарии
- Критерии: интерфейсы устойчивы к расширениям; ошибки мапятся корректно.

9. Прочее

- UsersService/AuthService — хеширование/валидация, JwtService мок
- ViewStatsService — счётчики/агрегации на уровне сервиса
- PublicController — точечные unit на ветки выбора языка (опционально; основная логика покрыта утилитами/сервисами)

---

## Технические детали

- Фреймворк: Jest (уже настроен в `package.json` для unit). Папка `src` — `rootDir`; файлы `*.spec.ts` автоматически подхватываются.
- Моки:
  - PrismaService: `const prisma = { book: { findMany: jest.fn() }, ... } as unknown as PrismaService;`
  - JwtService/ConfigService/StorageService — через `useValue` и jest.fn().
- Паттерн тестов: AAA (Arrange‑Act‑Assert), без snapshot‑тестов, читаемые описания кейсов.
- Покрытие: целевое покрытие по строкам 70% суммарно для юнитов (не жёсткий блокер), приоритет — критические файлы выше.

---

## Критерии приёмки всей задачи

- `yarn test` проходит локально без БД/Redis.
- Для каждого перечисленного сервиса/утилиты созданы базовые `*.spec.ts` с минимум 2–3 тестами.
- В README раздел "Run tests" дополнен короткой заметкой про запуск unit и структуру моков (будет сделано в ходе реализации).

Примечание по выполнению итерации 1:

- Добавлены unit‑тесты:
  - `src/shared/language/language.util.spec.ts`
  - `src/common/guards/language-resolver.guard.spec.ts`
  - `src/common/pipes/lang-param.pipe.spec.ts`
- Проверены кейсы приоритета языка: путь > query > Accept-Language > DEFAULT_LANGUAGE.
- Тесты запускаются и проходят: `yarn test`.

---

## Следующие шаги

- Согласовать приоритет итераций 1→9 и приступить к реализации.
- В ходе работ — при необходимости выделить недостающие интерфейсы для зависимостей (storage/cache/ratelimit) и замокать их в тестах.
