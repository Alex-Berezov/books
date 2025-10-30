# 🚨 Решение проблемы 401 Unauthorized

## Проблема

При вызове `createBook()` получаете **401 Unauthorized** потому что запрос идет БЕЗ `Authorization` заголовка.

```typescript
// ❌ Текущий код в admin.ts
export const createBook = async (data: CreateBookRequest) => {
  return httpPost<CreateBookResponse>('/books', data); // НЕТ ТОКЕНА!
};
```

## ✅ Быстрое решение

### Вариант 1: Добавь параметр токена

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
  // или const token = useAuthStore.getState().accessToken; // Zustand

  await createBook(bookData, session.accessToken);
};
```

### Вариант 2: Используй axios с interceptor (Рекомендуется)

```typescript
// lib/api-client.ts
import axios from 'axios';

const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL + '/api',
});

// Автоматически добавляем токен
apiClient.interceptors.request.use((config) => {
  const token = getAccessToken(); // Твоя функция
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

### Вариант 3: Next.js Server Action

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

## 📋 Какие endpoints требуют токен?

### Защищенные (нужен Authorization: Bearer)

```typescript
// Auth
POST   /api/auth/refresh
POST   /api/auth/logout
GET    /api/auth/profile
PATCH  /api/auth/profile

// Books (admin/content_manager)
POST   /api/books                  // ← Твоя проблема здесь
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

### Публичные (токен НЕ нужен)

```typescript
// Auth
POST /api/auth/register  // Регистрация
POST /api/auth/login     // Логин

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

## 🔍 Как проверить что токен работает?

```bash
# 1. Получи токен через login
curl -X POST https://api.bibliaris.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"yourpassword"}'

# Response: { "accessToken": "eyJhbGc...", ... }

# 2. Используй токен для создания книги
curl -X POST https://api.bibliaris.com/api/books \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGc..." \
  -d '{"title":"Test Book","slug":"test-book","author":"Test Author"}'

# ✅ Должно вернуть 201 Created
```

## 🎯 Пошаговый план исправления

### Шаг 1: Выбери архитектуру

- **Есть NextAuth?** → Используй Server Actions (Вариант 3)
- **Есть Zustand/Redux?** → Axios с interceptor (Вариант 2)
- **Простое SPA?** → Передавай токен параметром (Вариант 1)

### Шаг 2: Реализуй выбранный вариант

Смотри примеры кода выше ☝️

### Шаг 3: Обнови все admin функции

```typescript
// services/admin.ts

// Если выбрал Вариант 1 (параметр токена)
export const createBook = async (data: CreateBookRequest, token: string) => {
  return httpPostAuth('/books', data, token);
};

export const updateBook = async (id: string, data: UpdateBookRequest, token: string) => {
  return httpPatchAuth(`/books/${id}`, data, token);
};

export const deleteBook = async (id: string, token: string) => {
  return httpDeleteAuth(`/books/${id}`, token);
};

// Если выбрал Вариант 2 (axios interceptor)
export const createBook = async (data: CreateBookRequest) => {
  return apiClient.post('/books', data).then((r) => r.data);
};

export const updateBook = async (id: string, data: UpdateBookRequest) => {
  return apiClient.patch(`/books/${id}`, data).then((r) => r.data);
};

export const deleteBook = async (id: string) => {
  return apiClient.delete(`/books/${id}`);
};
```

### Шаг 4: Обнови компоненты

```typescript
// components/CreateBookForm.tsx

const handleSubmit = async (data: CreateBookRequest) => {
  try {
    // Вариант 1: С токеном
    const token = getAccessToken();
    await createBook(data, token);

    // Вариант 2: Автоматически
    await createBook(data); // Токен добавится в interceptor

    // Вариант 3: Server Action
    await createBook(data); // Токен из session

    toast.success('Book created!');
  } catch (error) {
    if (error.response?.status === 401) {
      toast.error('Unauthorized - please login again');
      router.push('/login');
    } else {
      toast.error('Failed to create book');
    }
  }
};
```

### Шаг 5: Тестируй

```typescript
// Test 1: Login
const { accessToken } = await login(email, password);
console.log('✅ Got token:', accessToken.substring(0, 20) + '...');

// Test 2: Create Book
try {
  const book = await createBook(testData, accessToken);
  console.log('✅ Book created:', book.id);
} catch (error) {
  console.error('❌ Error:', error.response?.status, error.message);
}
```

## 📚 Дополнительная документация

- **Полное руководство**: `docs/AI_AGENT_FRONTEND_GUIDE.md`
- **Структура API**: `docs/API_URL_STRUCTURE.md`
- **Список endpoints**: `docs/ENDPOINTS.md`
- **Swagger UI**: https://api.bibliaris.com/docs

## ⚡ TL;DR

**Проблема**: `POST /api/books` без `Authorization` → 401

**Решение**: Добавь `Authorization: Bearer ${accessToken}` в заголовки

**Лучший способ**: Axios interceptor - автоматически добавляет токен ко всем запросам

**Проверка**: Открой Swagger → попробуй endpoint → если замок 🔒 = нужен токен

Готово! 🎉
