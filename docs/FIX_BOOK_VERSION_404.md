# 🐛 Исправление: 404 при загрузке черновиков версий книг

## Проблема

После создания новой версии книги через админ-панель происходит редирект на страницу редактирования, но API возвращает `404 Not Found` с сообщением "BookVersion not found".

## Причина

**НЕТ race condition на backend!** Проблема в неправильном использовании API endpoints.

Backend предоставляет два разных endpoint для получения версии книги:

### 1. Public Endpoint (для публичного доступа)

```
GET /api/versions/{id}
```

- **Метод сервиса**: `getPublic(id)`
- **Фильтр**: Возвращает ТОЛЬКО опубликованные версии (`status: 'published'`)
- **Цель**: Доступ к контенту для обычных пользователей
- **Авторизация**: Не требуется

```typescript
async getPublic(id: string) {
  const version = await this.prisma.bookVersion.findFirst({
    where: { id, status: 'published' },  // ← Только published!
    include: { seo: { select: { metaTitle: true, metaDescription: true } } },
  });
  if (!version) throw new NotFoundException('BookVersion not found');
  return version;
}
```

### 2. Admin Endpoint (для админ-панели)

```
GET /api/admin/versions/{id}
```

- **Метод сервиса**: `getAdmin(id)`
- **Фильтр**: Возвращает версии в ЛЮБОМ статусе (`draft`, `published`)
- **Цель**: Редактирование контента в админ-панели
- **Авторизация**: Требуется JWT + роль Admin или ContentManager

```typescript
async getAdmin(id: string) {
  const version = await this.prisma.bookVersion.findUnique({
    where: { id },  // ← Любой статус!
    include: { seo: { select: { metaTitle: true, metaDescription: true } } },
  });
  if (!version) throw new NotFoundException('BookVersion not found');
  return version;
}
```

## Что происходило

1. **Frontend создает версию** (статус: `draft`):

   ```
   POST /api/admin/en/books/{bookId}/versions
   Response 201: { id: "330458cd-eba2-44fe-a650-9cf3e9fee37e", status: "draft", ... }
   ```

2. **Frontend делает редирект** на страницу редактирования:

   ```
   /admin/en/books/versions/330458cd-eba2-44fe-a650-9cf3e9fee37e
   ```

3. **Frontend пытается загрузить данные** (ОШИБКА):

   ```
   GET /api/versions/330458cd-eba2-44fe-a650-9cf3e9fee37e  ❌
   Response 404: "BookVersion not found"
   ```

4. **Почему 404?**
   - Public endpoint (`/api/versions/{id}`) фильтрует по `status: 'published'`
   - Новая версия имеет статус `'draft'`
   - Версия существует в БД, но не проходит фильтр → 404

## Решение

### ✅ Правильное использование endpoints

В админ-панели используйте **admin endpoints**:

```typescript
// ❌ НЕПРАВИЛЬНО - public endpoint
const response = await fetch(`/api/versions/${versionId}`);

// ✅ ПРАВИЛЬНО - admin endpoint
const response = await fetch(`/api/admin/versions/${versionId}`, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
```

### 🔄 Полная схема работы с версиями

#### Создание версии (Admin)

```typescript
// POST /api/admin/{lang}/books/{bookId}/versions
const newVersion = await createBookVersion({
  bookId: 'a1111111-b222-4c33-d444-555555555555',
  language: 'en',
  title: 'Harry Potter',
  author: 'J.K. Rowling',
  description: 'First book',
  type: 'text',
  isFree: true,
});

// Response:
// {
//   id: "330458cd-eba2-44fe-a650-9cf3e9fee37e",
//   status: "draft",  ← Важно!
//   ...
// }
```

#### Получение версии

**Для админ-панели (редактирование):**

```typescript
// GET /api/admin/versions/{id}
const version = await fetch(`/api/admin/versions/${versionId}`, {
  headers: { Authorization: `Bearer ${token}` },
});
// Возвращает версию в любом статусе (draft, published)
```

**Для публичного отображения:**

```typescript
// GET /api/versions/{id}
const version = await fetch(`/api/versions/${versionId}`);
// Возвращает ТОЛЬКО published версии
```

#### Публикация версии

```typescript
// PATCH /api/versions/{id}/publish
await fetch(`/api/versions/${versionId}/publish`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}` },
});

// После публикации версия доступна через public endpoint
```

## API Endpoints Summary

### Public API (без авторизации или с авторизацией пользователя)

| Method | Endpoint                       | Фильтр                | Описание                     |
| ------ | ------------------------------ | --------------------- | ---------------------------- |
| GET    | `/api/books/{bookId}/versions` | `status: 'published'` | Список опубликованных версий |
| GET    | `/api/versions/{id}`           | `status: 'published'` | Одна опубликованная версия   |

### Admin API (требуется авторизация + роль Admin/ContentManager)

| Method | Endpoint                                    | Фильтр       | Описание                           |
| ------ | ------------------------------------------- | ------------ | ---------------------------------- |
| POST   | `/api/admin/{lang}/books/{bookId}/versions` | -            | Создать версию (draft)             |
| GET    | `/api/admin/{lang}/books/{bookId}/versions` | Любой статус | Список всех версий (включая draft) |
| GET    | `/api/admin/versions/{id}`                  | Любой статус | Одна версия (любой статус)         |
| PATCH  | `/api/versions/{id}`                        | -            | Обновить версию                    |
| DELETE | `/api/versions/{id}`                        | -            | Удалить версию                     |
| PATCH  | `/api/versions/{id}/publish`                | -            | Опубликовать версию                |
| PATCH  | `/api/versions/{id}/unpublish`              | -            | Снять с публикации                 |

## Примеры использования в React Query

### Создание версии

```typescript
const createVersionMutation = useMutation({
  mutationFn: async (data: CreateBookVersionDto) => {
    const response = await fetch(`/api/admin/${lang}/books/${bookId}/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    });
    return response.json();
  },
  onSuccess: (data) => {
    // Редирект на страницу редактирования
    router.push(`/admin/${lang}/books/versions/${data.id}`);
  },
});
```

### Загрузка версии в админ-панели

```typescript
const { data: version, isLoading } = useQuery({
  queryKey: ['admin', 'bookVersion', versionId],
  queryFn: async () => {
    const response = await fetch(`/api/admin/versions/${versionId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to load version');
    }

    return response.json();
  },
  enabled: !!versionId,
});
```

### Загрузка версии для публичного просмотра

```typescript
const { data: version, isLoading } = useQuery({
  queryKey: ['public', 'bookVersion', versionId],
  queryFn: async () => {
    const response = await fetch(`/api/versions/${versionId}`);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Version not found or not published');
      }
      throw new Error('Failed to load version');
    }

    return response.json();
  },
  enabled: !!versionId,
});
```

## Почему нет race condition?

Backend использует Prisma транзакции для атомарной записи:

```typescript
async create(bookId: string, dto: CreateBookVersionDto, overrideLanguage?: Language) {
  // ...
  return await this.prisma.$transaction(async (tx) => {
    // Создание SEO
    let seoId: number | undefined;
    if (dto.seoMetaTitle || dto.seoMetaDescription) {
      const seo = await tx.seo.create({ /* ... */ });
      seoId = seo.id;
    }

    // Создание версии
    return tx.bookVersion.create({
      data: {
        bookId,
        language: effectiveLanguage,
        status: 'draft',
        seoId,
        // ...
      },
      include: { seo: true },
    });
  });
  // ← Версия полностью записана в БД до возврата ответа
}
```

- Транзакция гарантирует атомарность операции ✅
- Версия полностью записывается в БД до возврата ответа ✅
- Нет асинхронных операций после возврата ✅
- Нет необходимости в задержках на frontend ✅

## Checklist для frontend разработчика

- [ ] Используйте `/api/admin/versions/{id}` для загрузки черновиков
- [ ] Используйте `/api/versions/{id}` только для публичного отображения
- [ ] Добавьте авторизацию для всех admin endpoints
- [ ] Обрабатывайте 404 правильно (версия не существует vs не опубликована)
- [ ] Удалите setTimeout/задержки - они не нужны

## Связанные файлы

- `src/modules/book-version/book-version.controller.ts` - определение endpoints
- `src/modules/book-version/book-version.service.ts` - бизнес-логика
- `docs/ENDPOINTS.md` - полная документация API
- `CHANGELOG.md` - история изменений
