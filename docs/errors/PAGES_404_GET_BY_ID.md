# 🐛 404 при загрузке страницы по ID

## Проблема

После создания страницы через `POST /admin/:lang/pages` попытка загрузить её по ID возвращала 404:

```
GET /api/admin/pages/8ee2d5cf-0dc9-48f1-b7a4-419230ea3d1e
Response: 404 Not Found
```

## Причина

Endpoint для получения одной страницы по ID не был реализован.

## Решение

✅ **Добавлен новый endpoint:**

```
GET /api/admin/pages/:id
```

### Характеристики

- **Auth**: JWT + Role (admin|content_manager)
- **Возвращает**: Страницу в ЛЮБОМ статусе (draft/published)
- **URL формат**: Без префикса `:lang` (как у versions)
- **Response type**: `PageResponse`

### Пример использования

```typescript
// Загрузить страницу для редактирования
const response = await fetch('https://api.bibliaris.com/api/admin/pages/{pageId}', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

const page = await response.json();
console.log(page);
// {
//   "id": "uuid",
//   "slug": "test-page",
//   "title": "Test Page",
//   "type": "generic",
//   "content": "...",
//   "language": "en",
//   "status": "draft",
//   "seoId": null,
//   "createdAt": "2025-11-02T...",
//   "updatedAt": "2025-11-02T..."
// }
```

## Workflow

1. **Создать страницу**: `POST /api/admin/:lang/pages`
2. **Загрузить по ID**: `GET /api/admin/pages/:id` ← новый endpoint
3. **Обновить**: `PATCH /api/admin/:lang/pages/:id`
4. **Опубликовать**: `PATCH /api/admin/:lang/pages/:id/publish`

## Сравнение с Book Versions

Endpoint следует той же логике:

| Тип      | Admin endpoint (любой статус)  | Public endpoint (только published) |
| -------- | ------------------------------ | ---------------------------------- |
| Versions | `GET /admin/versions/:id` ✅   | `GET /versions/:id` ✅             |
| Pages    | `GET /admin/pages/:id` ✅ NEW! | `GET /pages/:slug` ✅              |

## Файлы

- `src/modules/pages/pages.service.ts` - метод `findById()`
- `src/modules/pages/pages.controller.ts` - endpoint `@Get('admin/pages/:id')`
- `docs/ENDPOINTS.md` - обновлена документация
- `docs/PAGES_API_GUIDE.md` - примеры использования

## См. также

- [PAGES_API_GUIDE.md](../PAGES_API_GUIDE.md) - Полное руководство по Pages API
- [FIX_BOOK_VERSION_404.md](../FIX_BOOK_VERSION_404.md) - Похожая проблема с versions
- [ENDPOINTS.md](../ENDPOINTS.md) - Все доступные endpoints
