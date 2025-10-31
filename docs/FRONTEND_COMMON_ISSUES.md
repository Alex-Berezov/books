# 🔧 Распространенные проблемы Frontend интеграции

> **Дата создания:** 31.10.2025  
> **Статус:** 📘 Справочник - Актуальные решения типичных проблем

Этот документ содержит решения наиболее частых проблем при интеграции frontend с API.

---

## 📑 Оглавление

1. [🚨 Проблема 401 Unauthorized](#проблема-401-unauthorized)
2. [🐛 Проблема 404 при загрузке черновиков версий книг](#проблема-404-при-загрузке-черновиков-версий-книг)

---

## 🚨 Проблема 401 Unauthorized

### Симптомы

При вызове admin endpoints (например, `createBook()`) получаете **401 Unauthorized**.

### Причина

Запрос идет **БЕЗ** заголовка `Authorization`.

```typescript
// ❌ НЕПРАВИЛЬНО
export const createBook = async (data: CreateBookRequest) => {
  return httpPost<CreateBookResponse>('/books', data); // НЕТ ТОКЕНА!
};
```

### Решение

#### Вариант 1: Axios с interceptor (Рекомендуется)

Автоматически добавляет токен ко всем запросам:

```typescript
// lib/api-client.ts
import axios from 'axios';

const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL + '/api',
});

// Автоматически добавляем токен
apiClient.interceptors.request.use((config) => {
  const token = getAccessToken(); // Ваша функция получения токена
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default apiClient;

// services/admin.ts
import apiClient from '@/lib/api-client';

export const createBook = async (data: CreateBookRequest) => {
  const response = await apiClient.post('/books', data);
  return response.data; // Токен добавится автоматически!
};
```

#### Вариант 2: Next.js Server Action

```typescript
// app/actions/books.ts
'use server';

import { auth } from '@/lib/auth';

export async function createBook(data: CreateBookRequest) {
  const session = await auth();

  if (!session?.accessToken) {
    throw new Error('Unauthorized');
  }

  const response = await fetch(`${process.env.API_URL}/api/books`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error('Failed to create book');
  }

  return response.json();
}
```

#### Вариант 3: Передача токена параметром

```typescript
// services/admin.ts
export const createBook = async (
  data: CreateBookRequest,
  accessToken: string,
): Promise<CreateBookResponse> => {
  return httpPostAuth<CreateBookResponse>('/books', data, accessToken);
};

// В компоненте
const handleCreate = async () => {
  const session = await getSession(); // NextAuth
  await createBook(bookData, session.accessToken);
};
```

### Какие endpoints требуют авторизацию?

#### Защищенные (нужен `Authorization: Bearer <token>`)

```typescript
// Auth
POST   /api/auth/refresh
POST   /api/auth/logout
GET    /api/auth/profile
PATCH  /api/auth/profile

// Books (admin/content_manager)
POST   /api/books
PATCH  /api/books/:id
DELETE /api/books/:id

// Versions (admin/content_manager)
POST   /api/books/:bookId/versions
PATCH  /api/versions/:id
PATCH  /api/versions/:id/publish
DELETE /api/versions/:id

// Admin Pages (admin/content_manager)
POST   /api/admin/:lang/pages
PATCH  /api/admin/:lang/pages/:id
DELETE /api/admin/:lang/pages/:id

// Media (admin/content_manager)
POST   /api/media/confirm
DELETE /api/media/:id

// Categories (admin)
POST   /api/categories
PATCH  /api/categories/:id
DELETE /api/categories/:id
```

#### Публичные (токен НЕ нужен)

```typescript
// Auth
POST /api/auth/register
POST /api/auth/login

// Books
GET /api/books
GET /api/:lang/books/:slug/overview

// Categories
GET /api/categories/tree
GET /api/:lang/categories/:slug/books

// Pages
GET /api/:lang/pages/:slug

// Health
GET /api/health/liveness
GET /api/health/readiness
```

### Проверка через curl

```bash
# 1. Получите токен через login
curl -X POST https://api.bibliaris.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"yourpassword"}'

# Response: { "accessToken": "eyJhbGc...", ... }

# 2. Используйте токен для создания книги
curl -X POST https://api.bibliaris.com/api/books \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGc..." \
  -d '{"title":"Test Book","slug":"test-book","author":"Test Author"}'

# ✅ Должно вернуть 201 Created
```

### TL;DR

- **Проблема**: `POST /api/books` без `Authorization` → 401
- **Решение**: Добавьте `Authorization: Bearer ${accessToken}` в заголовки
- **Лучший способ**: Axios interceptor - автоматически добавляет токен
- **Проверка**: Swagger → если endpoint имеет замок 🔒 = нужен токен

---

## 🐛 Проблема 404 при загрузке черновиков версий книг

### Симптомы

После создания новой версии книги через админ-панель происходит редирект на страницу редактирования, но API возвращает `404 Not Found` с сообщением "BookVersion not found".

### Причина

**НЕТ race condition на backend!** Проблема в неправильном использовании API endpoints.

Backend предоставляет **два разных endpoint** для получения версии книги:

#### 1. Public Endpoint (для публичного доступа)

```
GET /api/versions/{id}
```

- **Фильтр**: Возвращает ТОЛЬКО опубликованные версии (`status: 'published'`)
- **Цель**: Доступ к контенту для обычных пользователей
- **Авторизация**: Не требуется

#### 2. Admin Endpoint (для админ-панели)

```
GET /api/admin/versions/{id}
```

- **Фильтр**: Возвращает версии в ЛЮБОМ статусе (`draft`, `published`)
- **Цель**: Редактирование контента в админ-панели
- **Авторизация**: Требуется JWT + роль Admin или ContentManager

### Что происходило

1. **Frontend создает версию** (статус: `draft`):

   ```
   POST /api/admin/en/books/{bookId}/versions
   Response 201: { id: "330458cd-...", status: "draft", ... }
   ```

2. **Frontend делает редирект**:

   ```
   /admin/en/books/versions/330458cd-...
   ```

3. **Frontend пытается загрузить данные** (ОШИБКА):

   ```
   GET /api/versions/330458cd-...  ❌
   Response 404: "BookVersion not found"
   ```

4. **Почему 404?**
   - Public endpoint (`/api/versions/{id}`) фильтрует по `status: 'published'`
   - Новая версия имеет статус `'draft'`
   - Версия существует в БД, но не проходит фильтр → 404

### Решение

#### ✅ Используйте правильные endpoints

```typescript
// ❌ НЕПРАВИЛЬНО - public endpoint (только published)
const response = await fetch(`/api/versions/${versionId}`);

// ✅ ПРАВИЛЬНО - admin endpoint (любой статус)
const response = await fetch(`/api/admin/versions/${versionId}`, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
```

### API Endpoints Summary

#### Public API (без авторизации или с авторизацией пользователя)

| Method | Endpoint                       | Фильтр                | Описание                     |
| ------ | ------------------------------ | --------------------- | ---------------------------- |
| GET    | `/api/books/{bookId}/versions` | `status: 'published'` | Список опубликованных версий |
| GET    | `/api/versions/{id}`           | `status: 'published'` | Одна опубликованная версия   |

#### Admin API (требуется авторизация + роль Admin/ContentManager)

| Method | Endpoint                                    | Фильтр       | Описание                           |
| ------ | ------------------------------------------- | ------------ | ---------------------------------- |
| POST   | `/api/admin/{lang}/books/{bookId}/versions` | -            | Создать версию (draft)             |
| GET    | `/api/admin/{lang}/books/{bookId}/versions` | Любой статус | Список всех версий (включая draft) |
| GET    | `/api/admin/versions/{id}`                  | Любой статус | Одна версия (любой статус)         |
| PATCH  | `/api/versions/{id}`                        | -            | Обновить версию                    |
| DELETE | `/api/versions/{id}`                        | -            | Удалить версию                     |
| PATCH  | `/api/versions/{id}/publish`                | -            | Опубликовать версию                |
| PATCH  | `/api/versions/{id}/unpublish`              | -            | Снять с публикации                 |

### Примеры использования в React Query

#### Создание версии

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
    router.push(`/admin/${lang}/books/versions/${data.id}`);
  },
});
```

#### Загрузка версии в админ-панели

```typescript
const { data: version, isLoading } = useQuery({
  queryKey: ['admin', 'bookVersion', versionId],
  queryFn: async () => {
    const response = await fetch(`/api/admin/versions/${versionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error('Failed to load version');
    }

    return response.json();
  },
  enabled: !!versionId,
});
```

#### Загрузка версии для публичного просмотра

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

### Почему нет race condition?

Backend использует Prisma транзакции для атомарной записи:

```typescript
async create(bookId: string, dto: CreateBookVersionDto) {
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

### Checklist

- [ ] Используйте `/api/admin/versions/{id}` для загрузки черновиков
- [ ] Используйте `/api/versions/{id}` только для публичного отображения
- [ ] Добавьте авторизацию для всех admin endpoints
- [ ] Обрабатывайте 404 правильно (версия не существует vs не опубликована)
- [ ] Удалите setTimeout/задержки - они не нужны

### TL;DR

- **Проблема**: GET `/api/versions/{id}` для draft версии → 404
- **Решение**: Используйте GET `/api/admin/versions/{id}` в админ-панели
- **Почему**: Public endpoint фильтрует только `published` версии
- **Помните**: Admin endpoints требуют JWT авторизацию

---

## 📚 Дополнительные ресурсы

- **Полное руководство**: `docs/AI_AGENT_FRONTEND_GUIDE.md`
- **Структура API**: `docs/API_URL_STRUCTURE.md`
- **Список endpoints**: `docs/ENDPOINTS.md`
- **Swagger UI**: https://api.bibliaris.com/docs
- **Swagger безопасность**: `docs/SWAGGER_ON_PRODUCTION.md`

---

## 💡 Получить помощь

Если вы столкнулись с проблемой, которой нет в этом документе:

1. Проверьте [Swagger UI](https://api.bibliaris.com/docs) для актуальной документации API
2. Просмотрите `docs/ENDPOINTS.md` для полного списка endpoints
3. Проверьте лог ошибок в консоли браузера
4. Проверьте Network tab в DevTools для деталей запроса/ответа
