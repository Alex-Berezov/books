# Changelog

Все заметные изменения в проекте документируются в этом файле.

Формат: Дата — Краткое название — Детали.

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
