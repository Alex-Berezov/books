# Changelog

Все заметные изменения в проекте документируются в этом файле.

Формат: Дата — Краткое название — Детали.

---

## 2026-04-21 — ✨ НОВОЕ: AudioChapter API — admin endpoints, reorder, новые поля, upload limits

**СТАТУС**: ✅ Реализовано (Iteration 1 per BACKEND_TZ.md)

### Изменения в модели `AudioChapter`

**Prisma schema** (`prisma/schema.prisma`):

- Добавлено поле `description String?` (до 5000 символов) — краткое описание главы.
- Добавлено поле `transcript String?` — полный транскрипт (markdown).
- Добавлено поле `mediaId String?` + FK на `MediaAsset(id)` с `ON DELETE SET NULL` — связь с Media Library.
- Добавлено поле `updatedAt DateTime @updatedAt`.
- Индекс `AudioChapter_mediaId_idx`.

**Миграция:** `prisma/migrations/20260421100000_add_audio_chapter_fields/migration.sql`

### Новые эндпоинты

| Method | Path                                              | Доступ                   | Назначение                                             |
| ------ | ------------------------------------------------- | ------------------------ | ------------------------------------------------------ |
| GET    | `/admin/versions/:bookVersionId/audio-chapters`   | admin \| content_manager | Список глав для любого статуса версии (включая draft). |
| GET    | `/admin/audio-chapters/:id`                       | admin \| content_manager | Получить главу вне зависимости от статуса версии.      |
| POST   | `/versions/:bookVersionId/audio-chapters/reorder` | admin \| content_manager | Атомарное переупорядочивание по массиву id.            |
| GET    | `/uploads/limits`                                 | public                   | Публичные лимиты аплоадов (maxSize, MIME).             |

### Breaking changes

1. **Формат ответа `GET /versions/:bookVersionId/audio-chapters`** — теперь пагинированный объект:

   ```json
   {
     "items": [...],
     "total": 17,
     "page": 1,
     "limit": 50,
     "totalPages": 1
   }
   ```

   Ранее возвращался голый массив.

2. **Default `limit`** поднят с `10` до `50` (максимум `100`).

3. **Публичные `GET` эндпоинты** (`/versions/:id/audio-chapters` и `/audio-chapters/:id`) теперь возвращают `404`, если родительская `BookVersion.status !== 'published'`. Для работы с draft-версиями используйте admin-эндпоинты выше.

4. **Конфликт `number`** теперь возвращает **`409 Conflict`** (ранее `400 Bad Request`):

   ```json
   {
     "statusCode": 409,
     "error": "Conflict",
     "message": "Audio chapter with number 1 already exists in this version",
     "field": "number"
   }
   ```

5. **Uploads** — неподдерживаемый MIME теперь возвращает `415 Unsupported Media Type` (ранее `400`), превышение лимита — `413 Payload Too Large`.

### Новые поля в Create/Update DTO

```ts
{
  description?: string;  // ≤ 5000
  transcript?: string;   // markdown
  mediaId?: string;      // UUID, FK на MediaAsset
}
```

### Валидация

- `number`: integer ≥ 1, unique per `bookVersionId` → `409 Conflict`.
- `title`: 1..255 символов.
- `audioUrl`: http/https URL, required.
- `duration`: integer 0..86400 (до 24 часов).
- `description`: ≤ 5000 символов.
- `mediaId`: UUID, существующий непомеченный-удалённым `MediaAsset`.

### Upload limits (env-driven)

| Env переменная             | Default                                                                     | Описание                         |
| -------------------------- | --------------------------------------------------------------------------- | -------------------------------- |
| `UPLOADS_MAX_IMAGE_MB`     | `5`                                                                         | Максимальный размер изображений. |
| `UPLOADS_MAX_AUDIO_MB`     | **`200`** (было 100)                                                        | Максимальный размер аудио.       |
| `UPLOADS_ALLOWED_IMAGE_CT` | `image/jpeg,image/png,image/webp`                                           | Whitelist.                       |
| `UPLOADS_ALLOWED_AUDIO_CT` | `audio/mpeg,audio/mp4,audio/aac,audio/x-m4a,audio/ogg,audio/wav,audio/webm` | Whitelist (расширен).            |

### Файлы

- `prisma/schema.prisma` — модель `AudioChapter` + relation на `MediaAsset`.
- `prisma/migrations/20260421100000_add_audio_chapter_fields/migration.sql` — миграция.
- `src/modules/audio-chapter/audio-chapter.controller.ts` — admin endpoints, reorder.
- `src/modules/audio-chapter/audio-chapter.service.ts` — published-фильтр, 409, пагинация, reorder, media FK.
- `src/modules/audio-chapter/dto/create-audio-chapter.dto.ts` — новые поля, валидация.
- `src/modules/audio-chapter/dto/update-audio-chapter.dto.ts` — новые поля, валидация.
- `src/modules/audio-chapter/dto/reorder-audio-chapters.dto.ts` — NEW.
- `src/modules/uploads/uploads.service.ts` — 413/415, расширенный audio MIME whitelist, `getLimits()`.
- `src/modules/uploads/uploads.controller.ts` — `GET /uploads/limits`.
- `src/modules/media/media.controller.ts` — multer limit = `UPLOADS_MAX_AUDIO_MB`.
- `test/audio-chapter.e2e-spec.ts` — обновлено + новые тесты (409, description/transcript, reorder, admin-endpoints, draft 404).
- `src/modules/uploads/uploads.service.spec.ts` — обновлено под 415/413.

### Что осталось на Iteration 2

- `ffprobe` → `duration` в `MediaAsset` при загрузке аудио.
- Orphan media cleanup при `DELETE /audio-chapters/:id`.
- Preview audio для платных книг.

---

## 2025-11-18 — 🔧 ИСПРАВЛЕНИЕ: Все SEO поля теперь возвращаются API

**СТАТУС**: ✅ Реализовано и протестировано

### Проблема:

При запросе версии книги через `GET /admin/versions/:id` возвращалось только 2 из 8 SEO полей:

**Возвращалось (❌):**

- `metaTitle`
- `metaDescription`

**Отсутствовало (❌):**

- `canonicalUrl`
- `robots`
- `ogTitle`
- `ogDescription`
- `ogImageUrl`
- `twitterCard`

**Root cause:** Методы `BookVersionService` использовали явное ограничение полей:

```typescript
include: { seo: { select: { metaTitle: true, metaDescription: true } } }
```

### Решение:

Удалено явное ограничение полей SEO во всех методах `BookVersionService`:

**До (❌):**

```typescript
include: { seo: { select: { metaTitle: true, metaDescription: true } } }
```

**После (✅):**

```typescript
include: {
  seo: true;
} // Возвращает ВСЕ поля SEO entity
```

### Исправленные методы:

1. ✅ `list()` - публичный листинг версий
2. ✅ `create()` - создание версии
3. ✅ `getPublic()` - получение опубликованной версии
4. ✅ `getAdmin()` - **[КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ]** админское получение версии по ID
5. ✅ `update()` - обновление версии
6. ✅ `remove()` - удаление версии
7. ✅ `publish()` - публикация версии
8. ✅ `unpublish()` - снятие с публикации
9. ✅ `listAdmin()` - админский листинг версий

### Тестирование:

Создан новый E2E тест `test/seo-all-fields.e2e-spec.ts`:

```typescript
✓ should save and return ALL 8 SEO fields from BACKEND_SEO_FIELDS_NOT_SAVED.md
✓ should include all SEO fields in GET /admin/versions/:id response
```

**Результаты:** ✅ Все тесты проходят (2/2 passed)

### Файлы:

- `src/modules/book-version/book-version.service.ts` - исправлены все 10 методов
- `test/seo-all-fields.e2e-spec.ts` - новый комплексный тест (NEW)
- `docs/BACKEND_SEO_FIELDS_NOT_SAVED.md` - обновлён статус на "RESOLVED"
- `CHANGELOG.md` - обновлён

### API Response теперь включает ВСЕ поля:

```json
GET /api/admin/versions/{id}

{
  "id": "...",
  "title": "Harry Potter",
  "seo": {
    "id": 20,
    "metaTitle": "harry-potter",
    "metaDescription": "harry-potter",
    "canonicalUrl": "https://bibliaris.com/en/harry-potter",
    "robots": "index, follow",
    "ogTitle": "Harry Potter",
    "ogDescription": "Harry Potter",
    "ogImageUrl": "https://example.com/image.jpg",
    "twitterCard": "summary"
  }
}
```

### Влияние:

- ✅ Frontend теперь получает полные SEO данные
- ✅ Open Graph теги корректно отображаются
- ✅ Twitter Cards настраиваются правильно
- ✅ Технические SEO поля (`canonical_url`, `robots`) сохраняются

---

## 2025-11-15 — 🔧 ИСПРАВЛЕНИЕ: Каскадное удаление книг и связанных сущностей

**СТАТУС**: ✅ Реализовано (миграция готова к применению на production)

### Проблема:

При попытке удалить книгу через `DELETE /api/books/:id` возникала ошибка:

```
Foreign key constraint violated on the constraint: `BookVersion_bookId_fkey`
```

**Причина:** У книги есть связанные версии (BookVersion) и другие зависимые данные, и внешние ключи блокировали удаление.

### Решение:

Добавлено каскадное удаление (`onDelete: Cascade`) в Prisma schema для всех зависимых сущностей.

#### 1. Обновлена Prisma schema

Добавлен `onDelete: Cascade` для следующих связей:

**Основная цепочка:**

- ✅ `BookVersion` → `Book` (при удалении книги удаляются все её версии)

**Связанные с BookVersion:**

- ✅ `BookSummary` → `BookVersion` (краткие описания)
- ✅ `Chapter` → `BookVersion` (главы)
- ✅ `AudioChapter` → `BookVersion` (аудио главы)
- ✅ `Bookshelf` → `BookVersion` (записи в полках пользователей)
- ✅ `Comment` → `BookVersion` (комментарии к книге)
- ✅ `Comment` → `Chapter` (комментарии к главе)
- ✅ `Comment` → `AudioChapter` (комментарии к аудио главе)
- ✅ `Like` → `BookVersion` (лайки книги)
- ✅ `Like` → `Comment` (лайки комментариев)
- ✅ `BookCategory` → `BookVersion` (связи с категориями)
- ✅ `BookTag` → `BookVersion` (связи с тегами)
- ✅ `ViewStat` → `BookVersion` (статистика просмотров)
- ✅ `ReadingProgress` → `BookVersion` (прогресс чтения)

#### 2. Создана SQL миграция

**Файл:** `prisma/migrations/20251115153102_add_cascade_delete_for_books/migration.sql`

Миграция обновляет все foreign key constraints с добавлением `ON DELETE CASCADE`.

### Как это работает:

**До изменений:**

```sql
DELETE FROM Book WHERE id = 'book-uuid';
-- ❌ Error: Foreign key constraint violated
```

**После изменений:**

```sql
DELETE FROM Book WHERE id = 'book-uuid';
-- ✅ Success: Книга и ВСЕ связанные данные удалены автоматически:
--   - BookVersion(s)
--   - Chapter(s)
--   - AudioChapter(s)
--   - Comment(s)
--   - Like(s)
--   - BookCategory(s)
--   - BookTag(s)
--   - ViewStat(s)
--   - Bookshelf entries
--   - ReadingProgress entries
--   - BookSummary(s)
```

### Применение миграции на Production:

**⚠️ ВАЖНО:** Backend работает на Production VPS (https://api.bibliaris.com)

Для применения миграции используйте SSH:

```bash
# 1. SSH на production сервер
ssh deploy@bibliaris.com

# 2. Перейти в директорию приложения
cd /opt/books-app

# 3. Применить миграцию
docker compose --profile prod -f docker-compose.prod.yml exec app yarn prisma migrate deploy
```

**См. также:** `docs/PRISMA_MIGRATION_PRODUCTION.md` - полное руководство по применению миграций

### Файлы:

- `prisma/schema.prisma` - обновлены все relations с добавлением `onDelete: Cascade`
- `prisma/migrations/20251115153102_add_cascade_delete_for_books/migration.sql` - SQL миграция (NEW)
- `docs/PRISMA_MIGRATION_PRODUCTION.md` - руководство по применению миграций на production (NEW)
- `docs/BACKEND_MIGRATION_QUICKSTART.md` - добавлено предупреждение о production VPS
- `docs/BACKEND_AGENT_MIGRATION_INSTRUCTIONS.md` - добавлено предупреждение о production VPS
- `CHANGELOG.md` - обновлён

### Преимущества:

✅ **Одна операция** - DELETE book удаляет все зависимые данные автоматически  
✅ **Безопасность** - PostgreSQL гарантирует атомарность операции  
✅ **Производительность** - БД обрабатывает каскад эффективнее чем N+1 запросов  
✅ **Консистентность** - нет риска оставить "осиротевшие" записи в БД  
✅ **Простота** - контроллеру не нужна сложная логика удаления

### Тестирование (после применения миграции):

```bash
# 1. Создать тестовую книгу
POST https://api.bibliaris.com/api/books
{ "slug": "test-cascade-delete" }

# 2. Создать версию
POST https://api.bibliaris.com/api/books/{bookId}/versions
{ "title": "Test Book", "language": "en", ... }

# 3. Добавить главы, комментарии, лайки и т.д.

# 4. Удалить книгу
DELETE https://api.bibliaris.com/api/books/{bookId}

# Ожидаемый результат:
# ✅ Status 200/204
# ✅ Книга удалена
# ✅ Все связанные данные удалены автоматически
# ✅ Нет Foreign key constraint errors
```

---

## 2025-11-09 — 📖 Документация: Диагностика DELETE /admin/:lang/pages/:id (404)

**СТАТУС**: ✅ Документировано

### Проблема:

Фронтенд сообщил о 404 при удалении страницы на production:

```
DELETE /api/admin/en/pages/871c9894-51ee-44ce-b647-855fe557ecf7
Response: 404 Not Found
```

### Диагностика:

1. ✅ **Endpoint работает** — проверено через E2E тесты и Swagger на production
2. ✅ **Production сервер актуален** — последняя версия кода задеплоена
3. ❌ **Страница не существует в базе** — это самая частая причина 404

### Решение:

**Endpoint работает корректно!** 404 возникает потому что:

- Страница с таким ID не существует в production базе данных
- Страница уже была удалена ранее
- ID был скопирован неверно

**Рекомендация для фронтенда:**
DELETE должен быть идемпотентным:

```typescript
// Обрабатывать 404 как успех
if (response.status === 204 || response.status === 404) {
  return { success: true };
}
```

### Документация:

Созданы руководства по диагностике:

1. **Quick Fix** для фронтенда:
   - `docs/troubleshooting/errors/PAGES_DELETE_404_QUICKFIX.md`
2. **Production диагностика** для бэкенда:
   - `docs/troubleshooting/errors/PAGES_DELETE_404_PRODUCTION.md`
3. **Полное руководство** с примерами:
   - `docs/troubleshooting/errors/PAGES_DELETE_404.md`
4. Обновлён главный troubleshooting:
   - `docs/troubleshooting/troubleshooting.md`

### Ключевые моменты:

- ✅ Endpoint `DELETE /admin/:lang/pages/:id` работает и покрыт тестами
- ✅ Production сервер (`https://api.bibliaris.com`) работает и актуален
- 💡 **Главное:** Если `GET /admin/pages/:id` возвращает 404, то и DELETE вернёт 404 — это ожидаемое поведение
- 💡 Всегда проверяйте существование ресурса перед попыткой удаления

### Файлы:

- `docs/troubleshooting/errors/PAGES_DELETE_404_QUICKFIX.md` — новый
- `docs/troubleshooting/errors/PAGES_DELETE_404.md` — новый
- `docs/troubleshooting/errors/PAGES_DELETE_404_PRODUCTION.md` — новый
- `docs/troubleshooting/troubleshooting.md` — обновлён

---

## 2025-11-08 — ✨ НОВОЕ: Pages API теперь поддерживает вложенный объект SEO при создании страницы (POST)

**СТАТУС**: ✅ Реализовано

### Проблема:

Frontend не мог отправить SEO данные при создании страницы (POST), потому что `CreatePageDto` не поддерживал вложенный объект `seo`. Приходилось создавать страницу без SEO, а потом обновлять её через PATCH.

### Решение:

Добавлена поддержка вложенного объекта `seo` в `CreatePageDto` (по аналогии с `UpdatePageDto`).

### Изменения:

#### 1. Обновлён CreatePageDto

```typescript
// src/modules/pages/dto/create-page.dto.ts
export class CreatePageDto {
  @ApiProperty({ description: 'Slug страницы' })
  slug!: string;

  @ApiProperty({ description: 'Заголовок страницы' })
  title!: string;

  @ApiProperty({ enum: ['generic', 'category_index', 'author_index'] })
  type!: 'generic' | 'category_index' | 'author_index';

  @ApiProperty({ description: 'Контент страницы' })
  content!: string;

  @ApiPropertyOptional({ description: 'ID SEO сущности (legacy)', nullable: true })
  @IsOptional()
  seoId?: number | null;

  @ApiPropertyOptional({
    description: 'SEO данные (автоматически создаёт SEO entity)',
    type: SeoInputDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeoInputDto)
  seo?: SeoInputDto; // ✅ НОВОЕ ПОЛЕ
}
```

#### 2. Обновлён метод create() в PagesService

```typescript
// src/modules/pages/pages.service.ts
async create(dto: CreatePageDto, language: Language) {
  // Handle SEO: if dto.seo is provided, create SEO entity first
  let finalSeoId = dto.seoId;

  if (dto.seo) {
    // Check if SEO fields are not all null/undefined
    const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
    if (hasSeoData) {
      // Create new SEO entity
      const newSeo = await this.prisma.seo.create({
        data: dto.seo,
      });
      finalSeoId = newSeo.id;
    }
  } else if (dto.seoId !== undefined && dto.seoId !== null) {
    // Legacy: seoId provided directly - validate it exists
    const seo = await this.prisma.seo.findUnique({ where: { id: dto.seoId } });
    if (!seo) {
      throw new BadRequestException('SEO entity not found for provided seoId');
    }
    finalSeoId = dto.seoId;
  }

  return await this.prisma.page.create({
    data: {
      slug: dto.slug,
      title: dto.title,
      type: dto.type,
      content: dto.content,
      language,
      seoId: finalSeoId ?? null,
    },
    include: { seo: true },
  });
}
```

### Использование:

#### Вариант 1: Создать страницу С SEO (атомарно)

```typescript
POST /api/admin/en/pages
{
  "slug": "about",
  "title": "About Us",
  "type": "generic",
  "content": "Page content...",
  "seo": {  // ✅ Вложенный объект SEO
    "metaTitle": "About Us - Company Name",
    "metaDescription": "Learn more about our company",
    "canonicalUrl": "https://bibliaris.com/en/about",
    "robots": "index, follow",
    "ogTitle": "About Us",
    "ogDescription": "Learn more about our company",
    "ogImageUrl": "https://example.com/og-image.jpg",
    "twitterCard": "summary_large_image"
  }
}

// Response:
{
  "id": "uuid",
  "slug": "about",
  "seoId": 42,  // ✅ Создан автоматически
  "seo": {
    "id": 42,
    "metaTitle": "About Us - Company Name",
    "metaDescription": "Learn more about our company",
    ...
  }
}
```

#### Вариант 2: Создать страницу БЕЗ SEO

```typescript
POST /api/admin/en/pages
{
  "slug": "contact",
  "title": "Contact Us",
  "type": "generic",
  "content": "Contact page..."
  // seo не указан - страница создастся без SEO
}

// Response:
{
  "id": "uuid",
  "slug": "contact",
  "seoId": null,
  "seo": null
}
```

### Обратная совместимость:

✅ Legacy способ с `seoId` всё ещё работает:

```typescript
POST /api/admin/en/pages
{
  "slug": "about",
  "title": "About Us",
  "type": "generic",
  "content": "...",
  "seoId": 42  // ⚠️ Legacy, но работает
}
```

### Файлы:

- `src/modules/pages/dto/create-page.dto.ts` - добавлено поле `seo`
- `src/modules/pages/pages.service.ts` - обновлён метод `create()`
- `docs/frontend-related/PAGES_API_GUIDE.md` - обновлена документация
- `docs/frontend-related/PAGES_SEO_UPDATE_GUIDE.md` - новое руководство для фронтенда
- `CHANGELOG.md` - обновлён

### Преимущества:

✅ Атомарная операция (создание страницы + SEO в одном запросе)
✅ Упрощает работу фронтенда
✅ Единообразие с `UpdatePageDto` (который уже поддерживал `seo`)
✅ Обратная совместимость с legacy способом (`seoId`)

---

## 2025-11-03 — 📋 ДОКУМЕНТАЦИЯ: Диагностика проблемы "SEO Settings не сохраняются"

**СТАТУС**: ✅ Документировано

### Проблема на стороне Frontend:

После реализации автоматического создания SEO (commit 869a248), выяснилось что **frontend не отправляет поле `seo` в PATCH запросе**.

**Симптомы:**

- Пользователь заполняет Meta Title и Meta Description в форме SEO Settings
- Нажимает "Update Page"
- В ответе приходит `seo: null` и `seoId: null`
- SEO данные не сохраняются

**Диагностика (Chrome DevTools → Network):**

Request Payload показал:

```json
{
  "title": "New page 123",
  "slug": "new-page-123",
  "type": "generic"
  // ❌ Отсутствует поле "seo"!
}
```

**Ожидалось:**

```json
{
  "title": "New page 123",
  "slug": "new-page-123",
  "type": "generic",
  "seo": {
    // ✅ Это поле должно быть!
    "metaTitle": "About Us - Company Name",
    "metaDescription": "Learn more..."
  }
}
```

### Решение:

**Backend готов и работает корректно** (commit 869a248). Проблема на стороне frontend - форма не включает SEO данные в request body.

**Для frontend разработчика:**

- Проверьте, что form submission включает поле `seo` с данными из SEO Settings
- Поле `seo` должно быть объектом с полями `metaTitle`, `metaDescription` и т.д.
- Backend автоматически создаст/обновит SEO entity

### Создана документация:

- `docs/errors/PAGES_SEO_NOT_SAVING.md` - Подробная диагностика и решение
- `docs/errors/PAGES_SEO_TEST_EXAMPLE.md` - Примеры тестовых запросов с curl и JavaScript
- Обновлён `docs/README.md` с ссылкой на новые гайды

**Коммит**: `TBD` (документация готова к коммиту)

---

## 2025-11-03 — �🔧 ИСПРАВЛЕНИЕ: Автоматическое создание/обновление SEO entity при PATCH /admin/pages/:id

**СТАТУС**: ✅ Реализовано

### Проблема:

При обновлении страницы через `PATCH /admin/:lang/pages/:id` с SEO полями в форме:

```json
{
  "title": "New page 123",
  "content": "...",
  "seo": {
    "metaTitle": "SEO Title",
    "metaDescription": "SEO Description"
  }
}
```

Backend **игнорировал** вложенный объект `seo` и возвращал:

```json
{
  "seoId": null,
  "seo": null // ❌ SEO данные не сохранились
}
```

### Причина:

`UpdatePageDto` не имел поля `seo`, и backend ожидал что:

1. Frontend сначала создаст SEO entity через отдельный endpoint
2. Получит `seoId`
3. Отправит `seoId` при обновлении страницы

Это неудобно для UX - приходится делать 2 запроса вместо одного.

### Решение:

Добавлена поддержка **автоматического создания/обновления SEO entity** прямо при обновлении страницы:

#### 1. Создан `SeoInputDto`

```typescript
export class SeoInputDto {
  metaTitle?: string | null;
  metaDescription?: string | null;
  canonicalUrl?: string | null;
  robots?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  // ... остальные Open Graph и Twitter Card поля
}
```

#### 2. Обновлён `UpdatePageDto`

```typescript
export class UpdatePageDto {
  // ... существующие поля

  @ApiPropertyOptional({
    description: 'SEO данные (автоматически создаёт/обновляет SEO entity)',
    type: SeoInputDto,
  })
  seo?: SeoInputDto; // ✅ Новое поле
}
```

#### 3. Улучшен метод `PagesService.update()`

Теперь поддерживает 3 варианта работы с SEO:

**Вариант 1: Автоматическое создание SEO** (NEW!)

```json
PATCH /api/admin/en/pages/{id}
{
  "title": "About Us",
  "seo": {
    "metaTitle": "About Us - Company",
    "metaDescription": "Learn more about our company"
  }
}

Response:
{
  "seoId": 42,  // ✅ Создан автоматически
  "seo": {
    "id": 42,
    "metaTitle": "About Us - Company",
    "metaDescription": "Learn more about our company",
    ...
  }
}
```

**Вариант 2: Автоматическое обновление SEO** (NEW!)

```json
PATCH /api/admin/en/pages/{id}
{
  "seo": {
    "metaTitle": "Updated SEO Title"
  }
}

// Если у страницы уже есть seoId - обновит существующую SEO entity
```

**Вариант 3: Удаление SEO**

```json
PATCH /api/admin/en/pages/{id}
{
  "seo": {
    "metaTitle": null,
    "metaDescription": null
    // Все поля null
  }
}

// Отвяжет SEO entity от страницы (seoId станет null)
```

**Вариант 4: Legacy - прямой seoId** (сохранён для обратной совместимости)

```json
PATCH /api/admin/en/pages/{id}
{
  "seoId": 42  // По-прежнему работает
}
```

### Логика работы:

1. Если `dto.seo` предоставлен и содержит данные:
   - Если у страницы **уже есть** `seoId` → **обновляет** существующую SEO entity
   - Если у страницы **нет** `seoId` → **создаёт** новую SEO entity и привязывает

2. Если `dto.seo` предоставлен и **все поля null**:
   - Отвязывает SEO entity (`seoId` = `null`)

3. Если `dto.seoId` предоставлен напрямую:
   - Работает как раньше (legacy поддержка)

### Frontend теперь может:

```typescript
// Одним запросом создать/обновить страницу с SEO
await fetch('/api/admin/en/pages/{id}', {
  method: 'PATCH',
  body: JSON.stringify({
    title: 'Updated Title',
    content: 'Updated content',
    seo: {
      metaTitle: formData.seoTitle,
      metaDescription: formData.seoDescription,
      ogTitle: formData.ogTitle,
      ogImageUrl: formData.ogImage,
      // ... остальные SEO поля
    },
  }),
});

// Ответ сразу содержит привязанную SEO entity
```

### Файлы:

- `src/modules/pages/dto/seo-input.dto.ts` - новый DTO (NEW)
- `src/modules/pages/dto/update-page.dto.ts` - добавлено поле `seo`
- `src/modules/pages/pages.service.ts` - улучшена логика `update()`
- `CHANGELOG.md` - обновлён

### Преимущества:

✅ **Один запрос вместо двух** - UX улучшен  
✅ **Автоматическое создание** SEO entity  
✅ **Автоматическое обновление** существующей SEO entity  
✅ **Обратная совместимость** - старый способ через `seoId` работает  
✅ **Валидация** - все SEO поля опциональны и валидируются

---

## 2025-12-25 — ✨ УЛУЧШЕНИЕ: Categories & Tags API возвращают переводы

**СТАТУС**: ✅ Реализовано

### Проблема:

В админ-панели в списках Категорий и Тегов необходимо отображать индикаторы (флаги) языков, для которых уже созданы переводы. Ранее эндпоинты списков возвращали только базовую информацию, что требовало N+1 запросов для получения переводов.

### Решение:

Расширены ответы `GET /categories` и `GET /tags`. Теперь они возвращают пагинированный ответ с полем `translations`.

#### 1. Categories API (`GET /categories`)

**Было:**

```json
[{ "id": "...", "name": "Fiction", "slug": "fiction", "type": "genre" }]
```

**Стало:**

```json
{
  "data": [
    {
      "id": "...",
      "name": "Fiction",
      "slug": "fiction",
      "type": "genre",
      "booksCount": 5,
      "translations": [{ "language": "ru", "name": "Фантастика", "slug": "fantastika" }]
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

#### 2. Tags API (`GET /tags`)

**Было:**

```json
[{ "id": "...", "name": "Best Seller", "slug": "best-seller" }]
```

**Стало:**

```json
{
  "data": [
    {
      "id": "...",
      "name": "Best Seller",
      "slug": "best-seller",
      "translations": [{ "language": "fr", "name": "Meilleure vente", "slug": "meilleure-vente" }]
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

### Файлы:

- `src/modules/category/category.service.ts` — обновлен метод `list`
- `src/modules/tags/tags.service.ts` — обновлен метод `list`
- `src/modules/category/dto/category-response.dto.ts` — новые DTO
- `src/modules/tags/dto/tag-response.dto.ts` — новые DTO
- `frontend/ENDPOINTS.md` — обновлена документация

---

## 2025-12-28 — 🔧 ИСПРАВЛЕНИЕ: Раздача статических файлов (картинок) от корня

**СТАТУС**: ✅ Реализовано и протестировано

### Проблема:

Frontend (Next.js) получал ссылки на картинки вида `https://api.bibliaris.com/covers/...`, но сервер отдавал их по пути `/static/covers/...`. Это приводило к 404 ошибке при попытке отображения картинок в Media Library.

**Симптомы:**

- Ошибки 404 при запросе картинок через `next/image` или напрямую.
- API возвращал корректные метаданные, но сами файлы были недоступны по указанным URL.

### Решение:

Изменена конфигурация раздачи статических файлов, чтобы они были доступны от корня домена, что соответствует генерируемым ссылкам.

#### 1. Обновлён AppModule

`ServeStaticModule` теперь настроен на раздачу файлов от корня (`/`), а не от `/static`.

```typescript
ServeStaticModule.forRoot({
  rootPath: staticRoot,
  serveRoot: '/', // Было '/static'
}),
```

#### 2. Обновлён LocalStorageService

Генерация публичных ссылок теперь не добавляет префикс `/static` по умолчанию.

```typescript
this.publicBaseUrl = process.env.LOCAL_PUBLIC_BASE_URL || 'http://localhost:5000';
```

#### 3. Очистка конфигурации безопасности

Удалена избыточная и конфликтующая настройка `express.static` из `src/common/security/app-security.config.ts`.

### Файлы:

- `src/app.module.ts` — изменена конфигурация `ServeStaticModule`.
- `src/shared/storage/local.storage.ts` — обновлён дефолтный URL.
- `src/common/security/app-security.config.ts` — удалён дублирующий `express.static`.
- `test/uploads.e2e-spec.ts`, `test/media.e2e-spec.ts` — обновлены тесты.
- `README.md`, `.env.example` — обновлена документация.

### Влияние:

- ✅ Картинки теперь доступны по прямым ссылкам (например, `/covers/...`).
- ✅ Исправлено отображение в Media Library на фронтенде.
- ✅ Упрощена конфигурация (единая точка входа через `ServeStaticModule`).

---

## 2025-12-28 — 🔧 ИСПРАВЛЕНИЕ: Персистентность загрузок и Docker Volume

**СТАТУС**: ✅ Реализовано

### Проблема:

Пользователи сообщали о пропаже картинок или ошибках 404 даже после успешной загрузки.
Причина: В `docker-compose.prod.yml` отсутствовал volume для папки `uploads`. При каждом пересоздании контейнера (деплое) все загруженные файлы уничтожались. Кроме того, отсутствие папки при старте могло мешать инициализации `ServeStaticModule`.

### Решение:

1.  **Добавлен Docker Volume**:
    В `docker-compose.prod.yml` добавлен именованный том `uploads_data_prod`, который монтируется в `/app/var/uploads`. Это гарантирует сохранность файлов между деплоями.

2.  **Создание директории**:
    В `Dockerfile` добавлена команда `RUN mkdir -p var/uploads`, чтобы папка гарантированно существовала при старте приложения.

3.  **Логирование**:
    Добавлен лог в `AppModule` для отладки пути к статическим файлам (`[AppModule] Serving static files from: ...`).

### Файлы:

- `docker-compose.prod.yml` — добавлен volume.
- `Dockerfile` — добавлено создание папки.
- `src/app.module.ts` — добавлен лог.

---
