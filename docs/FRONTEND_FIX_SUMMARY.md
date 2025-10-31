# 🎯 Quick Fix для Frontend: 404 при создании версий книг

## Проблема

После создания версии книги получаешь `404 Not Found` при попытке загрузить её данные.

## Решение (одна строка)

Замени `/api/versions/{id}` на `/api/admin/versions/{id}` в админ-панели.

## Почему?

```typescript
// ❌ Public endpoint - возвращает ТОЛЬКО published версии
GET / api / versions / { id };
// При создании версия = draft → 404

// ✅ Admin endpoint - возвращает ЛЮБОЙ статус (draft/published)
GET / api / admin / versions / { id };
// Работает с черновиками ✅
```

## Код для копирования

### React Query

```typescript
import { useQuery } from '@tanstack/react-query';

// В админ-панели
const { data: version } = useQuery({
  queryKey: ['admin', 'bookVersion', versionId],
  queryFn: () =>
    fetch(`/api/admin/versions/${versionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json()),
});

// Для публичного отображения
const { data: version } = useQuery({
  queryKey: ['public', 'bookVersion', versionId],
  queryFn: () => fetch(`/api/versions/${versionId}`).then((r) => r.json()),
});
```

### Fetch API

```typescript
// Админ-панель
const version = await fetch(`/api/admin/versions/${versionId}`, {
  headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.json());

// Публичное отображение
const version = await fetch(`/api/versions/${versionId}`).then((r) => r.json());
```

## Важно

1. **Удали setTimeout** — они не нужны, нет race condition
2. **Используй admin endpoint** для всех операций в админ-панели
3. **Добавь авторизацию** (Bearer token) для admin endpoints

## Полная документация

См. [`docs/FIX_BOOK_VERSION_404.md`](FIX_BOOK_VERSION_404.md) для деталей.

## API Endpoints (шпаргалка)

| Операция      | Public                                        | Admin                                         |
| ------------- | --------------------------------------------- | --------------------------------------------- |
| Список версий | `/api/books/{id}/versions` (только published) | `/api/admin/{lang}/books/{id}/versions` (все) |
| Одна версия   | `/api/versions/{id}` (только published)       | `/api/admin/versions/{id}` (любая)            |
| Создать       | -                                             | `/api/admin/{lang}/books/{id}/versions`       |
| Обновить      | -                                             | `/api/versions/{id}` (PATCH)                  |
| Удалить       | -                                             | `/api/versions/{id}` (DELETE)                 |
| Опубликовать  | -                                             | `/api/versions/{id}/publish` (PATCH)          |
