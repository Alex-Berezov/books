# 📘 Инструкция для AI-агента: Интеграция с Books App API

> Документ для AI-ассистентов, разрабатывающих фронтенд для Books App

## 🌐 API Endpoints

### Production

- **Base URL**: `https://api.bibliaris.com`
- **Swagger UI**: `https://api.bibliaris.com/docs`
- **OpenAPI Spec**: `https://api.bibliaris.com/docs-json`

### Local Development

- **Base URL**: `http://localhost:5000`
- **Swagger UI**: `http://localhost:5000/docs`
- **OpenAPI Spec**: `http://localhost:5000/docs-json`

## 📋 Важная информация о структуре URL

### ⚠️ КРИТИЧЕСКИ ВАЖНО!

**Документация и API имеют РАЗНЫЕ префиксы:**

```bash
# ✅ ПРАВИЛЬНО - Документация БЕЗ /api
https://api.bibliaris.com/docs           # Swagger UI
https://api.bibliaris.com/docs-json      # OpenAPI схема

# ✅ ПРАВИЛЬНО - API endpoints С /api
https://api.bibliaris.com/api/books      # Books API
https://api.bibliaris.com/api/auth/login # Auth API

# ❌ НЕПРАВИЛЬНО - НЕ используй эти URL
https://api.bibliaris.com/api/docs       # 404 Not Found
https://api.bibliaris.com/api/docs-json  # 404 Not Found
https://api.bibliaris.com/books          # 404 Not Found
```

### Структура путей

```
/docs              → Swagger UI (документация для людей)
/docs-json         → OpenAPI JSON (для кодогенерации)
/api/*             → Все бизнес endpoints (books, auth, categories, etc.)
/api/health/*      → Health checks
/api/metrics       → Prometheus метрики
```

## 🔧 Генерация TypeScript типов

### Способ 1: Автоматическая генерация (Рекомендуется)

```bash
# В вашем фронтенд проекте
npm install -D openapi-typescript

# Для production
npx openapi-typescript https://api.bibliaris.com/docs-json -o src/types/api.ts

# Для локальной разработки (если backend запущен локально)
npx openapi-typescript http://localhost:5000/docs-json -o src/types/api.ts
```

### Способ 2: Использовать готовый клиент из backend

Backend предоставляет готовую библиотеку с типами в `libs/api-client/`:

```bash
# Скопировать из backend репозитория
cp ../books-app-back/libs/api-client/types.ts ./src/types/api.ts
cp ../books-app-back/libs/api-client/src/index.ts ./src/lib/api-client.ts
```

## 📦 Настройка HTTP клиента

### Next.js App Router (Рекомендуется)

```typescript
// lib/api.ts
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api.bibliaris.com';

export async function fetchAPI<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}/api${endpoint}`; // Обрати внимание: добавляем /api

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }

  return response.json();
}

// Использование
const books = await fetchAPI('/books'); // → https://api.bibliaris.com/api/books
```

### React с Axios

```typescript
// lib/api-client.ts
import axios from 'axios';

const apiClient = axios.create({
  baseURL: `${process.env.REACT_APP_API_URL || 'https://api.bibliaris.com'}/api`,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Использование
const { data } = await apiClient.get('/books'); // → https://api.bibliaris.com/api/books
```

## 🔐 Аутентификация

### Регистрация

```typescript
POST /api/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "displayName": "John Doe"
}

Response 201:
{
  "user": { "id": "...", "email": "...", "roles": ["user"] },
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc..."
}
```

### Логин

```typescript
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePass123!"
}

Response 200:
{
  "user": { "id": "...", "email": "...", "roles": ["user"] },
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc..."
}
```

### Использование токена

```typescript
// Добавь Bearer token в заголовки
const response = await fetch('https://api.bibliaris.com/api/profile', {
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
});
```

## � КРИТИЧЕСКИ ВАЖНО: Авторизация защищенных endpoints

### ⚠️ Типичная ошибка: 401 Unauthorized

**Проблема**: Многие protected endpoints (создание книг, админка) требуют JWT токен, но запрос идет БЕЗ `Authorization` заголовка.

```typescript
// ❌ НЕПРАВИЛЬНО - получишь 401 Unauthorized
const createBook = async (data) => {
  return fetch('https://api.bibliaris.com/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }); // ← НЕТ Authorization заголовка!
};

// ✅ ПРАВИЛЬНО - запрос с токеном
const createBook = async (data, accessToken) => {
  return fetch('https://api.bibliaris.com/api/books', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`, // ← Токен добавлен!
    },
    body: JSON.stringify(data),
  });
};
```

### 🛠️ Решения для разных архитектур

#### Вариант 1: HTTP клиент с автоматической авторизацией (Рекомендуется)

```typescript
// lib/api-client.ts
import axios from 'axios';

// Функция для получения токена (зависит от твоей auth системы)
const getAccessToken = () => {
  // NextAuth
  // return session?.accessToken;
  // localStorage
  // return localStorage.getItem('accessToken');
  // Zustand/Redux store
  // return useAuthStore.getState().accessToken;
};

// Создай клиент с interceptor
const apiClient = axios.create({
  baseURL: `${process.env.NEXT_PUBLIC_API_URL}/api`,
});

// Автоматически добавляй токен к каждому запросу
apiClient.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Использование - токен добавится автоматически
export const createBook = async (data: CreateBookRequest) => {
  const response = await apiClient.post('/books', data);
  return response.data;
};
```

#### Вариант 2: Wrapper функции с токеном

```typescript
// lib/http-client.ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL + '/api';

// Базовые функции БЕЗ авторизации
export async function httpGet<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`);
  return response.json();
}

export async function httpPost<T>(endpoint: string, data: any): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return response.json();
}

// Функции С авторизацией
export async function httpGetAuth<T>(endpoint: string, token: string): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.json();
}

export async function httpPostAuth<T>(endpoint: string, data: any, token: string): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });
  return response.json();
}

// В API функциях используй авторизованные версии
export const createBook = async (data: CreateBookRequest, token: string) => {
  return httpPostAuth<CreateBookResponse>('/books', data, token);
};
```

#### Вариант 3: NextAuth с Server Actions (Next.js 14+)

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

### 🎯 Какие endpoints требуют авторизацию?

#### Публичные (БЕЗ токена) ✅

```typescript
GET  /api/books                    // Список книг
GET  /api/:lang/books/:slug/overview // Обзор книги
GET  /api/:lang/pages/:slug        // Страницы
GET  /api/categories/tree          // Дерево категорий
GET  /api/:lang/categories/:slug/books // Книги категории
GET  /api/health/liveness          // Health check
```

#### Требуют авторизации (С токеном) 🔒

```typescript
// Auth
POST /api/auth/register            // Регистрация (получишь токен)
POST /api/auth/login               // Логин (получишь токен)
POST /api/auth/refresh             // Обновление токена
POST /api/auth/logout              // Выход

// Profile
GET  /api/auth/profile             // Текущий пользователь
PATCH /api/auth/profile            // Обновить профиль

// Books Management (admin/content_manager)
POST   /api/books                  // Создать книгу
PATCH  /api/books/:id              // Обновить книгу
DELETE /api/books/:id              // Удалить книгу

// Book Versions (admin/content_manager)
POST   /api/books/:bookId/versions // Создать версию
PATCH  /api/versions/:id           // Обновить версию
PATCH  /api/versions/:id/publish   // Опубликовать
PATCH  /api/versions/:id/unpublish // Снять с публикации
DELETE /api/versions/:id           // Удалить версию

// Admin Pages (admin/content_manager)
POST   /api/admin/:lang/pages      // Создать страницу
PATCH  /api/admin/:lang/pages/:id  // Обновить страницу
DELETE /api/admin/:lang/pages/:id  // Удалить страницу

// Media (admin/content_manager)
POST   /api/media/confirm          // Подтвердить загрузку
DELETE /api/media/:id              // Удалить медиа

// Categories (admin)
POST   /api/categories             // Создать категорию
PATCH  /api/categories/:id         // Обновить категорию
DELETE /api/categories/:id         // Удалить категорию

// И все остальные admin/management endpoints
```

### 🔍 Как определить требуется ли токен?

#### Способ 1: Swagger UI

1. Открой https://api.bibliaris.com/docs
2. Найди нужный endpoint
3. Если видишь иконку 🔒 или "Authorization: Bearer" - нужен токен

#### Способ 2: OpenAPI схема

```typescript
// Загрузи схему
const spec = await fetch('https://api.bibliaris.com/docs-json').then((r) => r.json());

// Проверь security requirements
const createBookEndpoint = spec.paths['/api/books'].post;
console.log(createBookEndpoint.security);
// [{ "bearer": [] }] ← Требуется авторизация
```

#### Способ 3: Попробуй запрос

```bash
# Без токена
curl https://api.bibliaris.com/api/books -X POST \
  -H "Content-Type: application/json" \
  -d '{"title":"Test"}'

# Если получишь 401 - нужен токен
```

### ⚡ Быстрое исправление для существующего кода

Если у тебя уже есть функции типа:

```typescript
// services/admin.ts
export const createBook = async (data: CreateBookRequest) => {
  return httpPost<CreateBookResponse>('/books', data); // ❌ 401
};
```

**Исправь так:**

```typescript
// services/admin.ts
export const createBook = async (data: CreateBookRequest, accessToken: string) => {
  return httpPostAuth<CreateBookResponse>('/books', data, accessToken); // ✅
};

// Или если используешь axios с interceptor
export const createBook = async (data: CreateBookRequest) => {
  return apiClient.post('/books', data); // ✅ Токен добавится автоматически
};
```

### 🚨 Checklist перед каждым запросом

- [ ] Endpoint публичный или требует авторизацию?
- [ ] Если требует - добавлен ли `Authorization: Bearer ${token}`?
- [ ] Токен актуален (не истек)?
- [ ] Если 401 - проверь наличие токена и его формат
- [ ] Если 403 - проверь права пользователя (roles)

## �📚 Основные endpoints

### Books (Книги)

```typescript
// Список книг
GET /api/books?page=1&limit=10

// Обзор книги (overview)
GET /api/:lang/books/:slug/overview
// Пример: GET /api/en/books/1984/overview

// Создать книгу (требуется auth + admin/content_manager)
POST /api/books
Authorization: Bearer {token}
{
  "title": "1984",
  "slug": "1984",
  "author": "George Orwell"
}
```

### Categories (Категории)

```typescript
// Дерево категорий
GET /api/categories/tree?lang=en

// Книги по категории
GET /api/:lang/categories/:slug/books
// Пример: GET /api/en/categories/fiction/books
```

### Pages (Страницы)

```typescript
// Получить страницу по slug
GET /api/:lang/pages/:slug
// Пример: GET /api/en/pages/about
```

## 🌍 Мультиязычность

API поддерживает 4 языка: `en`, `es`, `fr`, `pt`

### Приоритет определения языка:

1. **Префикс пути** `/:lang` (высший приоритет)
2. Query параметр `?lang=en`
3. Заголовок `Accept-Language`

```typescript
// Способ 1: Префикс пути (рекомендуется)
GET /api/en/books/1984/overview

// Способ 2: Query параметр
GET /api/books/1984/overview?lang=en

// Способ 3: Заголовок
GET /api/books/1984/overview
Accept-Language: en-US,en;q=0.9
```

## 🔍 Получение документации программно

### Способ 1: Swagger UI (для людей)

```typescript
// Просто открой в браузере
window.open('https://api.bibliaris.com/docs', '_blank');
```

### Способ 2: OpenAPI JSON (для обработки)

```typescript
// Загрузить схему программно
const response = await fetch('https://api.bibliaris.com/docs-json');
const openApiSpec = await response.json();

console.log(openApiSpec.info.title); // "Books App API"
console.log(openApiSpec.info.version); // "1.0"

// Получить список всех endpoints
const paths = Object.keys(openApiSpec.paths);
console.log(paths);
// ["/api/books", "/api/auth/login", "/api/categories/tree", ...]
```

### Способ 3: Curl для быстрой проверки

```bash
# Сохранить схему локально
curl https://api.bibliaris.com/docs-json > openapi.json

# Посмотреть доступные endpoints
curl -s https://api.bibliaris.com/docs-json | jq -r '.paths | keys[]'
```

## 🛠️ Инструменты для работы с API

### 1. Postman/Insomnia

```
Import → OpenAPI Spec → https://api.bibliaris.com/docs-json
```

### 2. Swagger UI (встроенный)

```
https://api.bibliaris.com/docs
```

### 3. VS Code REST Client

```http
### Get Books
GET https://api.bibliaris.com/api/books

### Login
POST https://api.bibliaris.com/api/auth/login
Content-Type: application/json

{
  "email": "test@example.com",
  "password": "password123"
}
```

## 🚀 Быстрый старт для AI-агента

### Шаг 1: Проверь доступность API

```bash
curl https://api.bibliaris.com/api/health/liveness
# Ожидаем: {"status":"up","uptime":...}
```

### Шаг 2: Загрузи OpenAPI схему

```bash
curl https://api.bibliaris.com/docs-json > openapi.json
```

### Шаг 3: Сгенерируй TypeScript типы

```bash
npx openapi-typescript https://api.bibliaris.com/docs-json -o src/types/api.ts
```

### Шаг 4: Настрой HTTP клиент

```typescript
// .env.local
NEXT_PUBLIC_API_URL=https://api.bibliaris.com

// lib/api.ts
const API_URL = process.env.NEXT_PUBLIC_API_URL + '/api';
```

### Шаг 5: Начни разработку

```typescript
import { fetchAPI } from '@/lib/api';

// Получить книги
const books = await fetchAPI('/books');

// Получить категории
const categories = await fetchAPI('/categories/tree?lang=en');
```

## ⚠️ Частые ошибки

### ❌ Ошибка 1: Неправильный URL для Swagger

```typescript
// НЕПРАВИЛЬНО
fetch('https://api.bibliaris.com/api/docs-json'); // 404

// ПРАВИЛЬНО
fetch('https://api.bibliaris.com/docs-json'); // 200
```

### ❌ Ошибка 2: Забыл префикс /api для endpoints

```typescript
// НЕПРАВИЛЬНО
fetch('https://api.bibliaris.com/books'); // 404

// ПРАВИЛЬНО
fetch('https://api.bibliaris.com/api/books'); // 200
```

### ❌ Ошибка 3: Неправильный формат языка в пути

```typescript
// НЕПРАВИЛЬНО
GET /api/books/1984/overview?lang=en              // Работает, но не оптимально

// ПРАВИЛЬНО (приоритетнее)
GET /api/en/books/1984/overview                   // Рекомендуется для мультисайта
```

## 📊 Мониторинг и отладка

### Health Checks

```bash
# Проверка живости приложения
curl https://api.bibliaris.com/api/health/liveness

# Проверка готовности (БД доступна)
curl https://api.bibliaris.com/api/health/readiness
```

### Метрики

```bash
# Prometheus метрики
curl https://api.bibliaris.com/api/metrics
```

## � Refresh Token и обработка истечения токенов

### Жизненный цикл токенов

**Access Token**:

- Срок жизни: 12 часов (по умолчанию)
- Используется для всех API запросов
- Когда истекает → получишь 401 Unauthorized

**Refresh Token**:

- Срок жизни: 7 дней (по умолчанию)
- Используется для получения нового Access Token
- Храни безопасно (httpOnly cookie или secure storage)

### Обновление токена

```typescript
// Когда Access Token истек
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "eyJhbGc..."
}

Response 200:
{
  "accessToken": "новый_токен...",
  "refreshToken": "новый_refresh_токен..."  // Опционально, если ротация включена
}
```

### Автоматическая обработка 401 (Axios interceptor)

```typescript
// lib/api-client.ts
import axios from 'axios';

const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL + '/api',
});

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: any) => void;
}> = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token!);
    }
  });
  failedQueue = [];
};

// Request interceptor - добавляем токен
apiClient.interceptors.request.use((config) => {
  const token = getAccessToken(); // Твоя функция получения токена
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor - обрабатываем 401
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Если 401 и это не повторный запрос
    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        // Если уже идет refresh - добавляем в очередь
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return apiClient(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = getRefreshToken(); // Твоя функция
        const response = await axios.post(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/refresh`, {
          refreshToken,
        });

        const { accessToken } = response.data;

        // Сохрани новый токен
        setAccessToken(accessToken); // Твоя функция

        // Обнови заголовки
        apiClient.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;

        processQueue(null, accessToken);
        return apiClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);

        // Если refresh не удался - logout
        logout(); // Твоя функция (очисти токены, редирект на /login)
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  },
);

export default apiClient;
```

### Упрощенная версия (без очереди)

```typescript
// lib/api-client-simple.ts
import axios from 'axios';

const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL + '/api',
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const refreshToken = getRefreshToken();
        const { data } = await axios.post('/api/auth/refresh', { refreshToken });

        setAccessToken(data.accessToken);
        originalRequest.headers.Authorization = `Bearer ${data.accessToken}`;

        return apiClient(originalRequest);
      } catch (refreshError) {
        logout();
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  },
);
```

### Next.js Server Actions (альтернатива)

```typescript
// app/actions/api.ts
'use server';

import { auth } from '@/lib/auth';

export async function apiCall(endpoint: string, options?: RequestInit) {
  const session = await auth();

  const response = await fetch(`${process.env.API_URL}/api${endpoint}`, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${session?.accessToken}`,
    },
  });

  if (response.status === 401) {
    // Попробуй refresh
    const refreshed = await refreshSession(session?.refreshToken);
    if (refreshed) {
      // Повтори запрос с новым токеном
      return fetch(`${process.env.API_URL}/api${endpoint}`, {
        ...options,
        headers: {
          ...options?.headers,
          Authorization: `Bearer ${refreshed.accessToken}`,
        },
      });
    }
  }

  return response;
}
```

## 🛡️ Безопасное хранение токенов

### ❌ НЕ храни токены в

```typescript
// ПЛОХО - уязвимо для XSS
localStorage.setItem('accessToken', token);
sessionStorage.setItem('accessToken', token);

// ПЛОХО - доступно через JavaScript
document.cookie = `accessToken=${token}`;
```

### ✅ Безопасные способы

#### Вариант 1: httpOnly cookies (Рекомендуется для production)

```typescript
// Backend устанавливает cookie при логине
POST /api/auth/login
// Backend response headers:
Set-Cookie: accessToken=...; HttpOnly; Secure; SameSite=Strict; Max-Age=43200

// Frontend - токен отправляется автоматически
fetch('https://api.bibliaris.com/api/books', {
  credentials: 'include', // Важно!
});
```

#### Вариант 2: Память + NextAuth (Next.js)

```typescript
// NextAuth автоматически управляет токенами
// Хранит в зашифрованной session cookie

import { useSession } from 'next-auth/react';

function MyComponent() {
  const { data: session } = useSession();
  const accessToken = session?.accessToken;

  // Используй токен
}
```

#### Вариант 3: Zustand/Redux с sessionStorage (для SPA)

```typescript
// store/auth.ts
import create from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  setTokens: (access: string, refresh: string) => void;
  clearTokens: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      setTokens: (access, refresh) => set({ accessToken: access, refreshToken: refresh }),
      clearTokens: () => set({ accessToken: null, refreshToken: null }),
    }),
    {
      name: 'auth-storage',
      getStorage: () => sessionStorage, // Или secure storage в мобильных app
    },
  ),
);
```

## �📞 Поддержка

- **Swagger UI**: https://api.bibliaris.com/docs - интерактивная документация
- **OpenAPI Spec**: https://api.bibliaris.com/docs-json - JSON схема для инструментов
- **Repository**: https://github.com/Alex-Berezov/books - исходный код backend

## ✅ Чеклист для AI-агента

### Перед началом разработки

- [ ] API доступен: `curl https://api.bibliaris.com/api/health/liveness`
- [ ] Swagger работает: открой `https://api.bibliaris.com/docs` в браузере
- [ ] OpenAPI схема загружается: `curl https://api.bibliaris.com/docs-json`
- [ ] TypeScript типы сгенерированы из `/docs-json` (не `/api/docs-json`!)
- [ ] Базовый URL настроен: `https://api.bibliaris.com/api` (с `/api` префиксом)
- [ ] Понимаешь разницу:
  - `/docs` и `/docs-json` - БЕЗ префикса `/api`
  - `/api/books`, `/api/auth/*` - С префиксом `/api`

### Авторизация (критично!)

- [ ] HTTP клиент настроен с поддержкой `Authorization` заголовка
- [ ] Есть механизм получения `accessToken` (из session/store/etc)
- [ ] Защищенные endpoints вызываются С токеном
- [ ] Публичные endpoints вызываются БЕЗ токена (не обязательно)
- [ ] Реализована обработка 401 ошибки (refresh token или logout)
- [ ] Токены хранятся безопасно (httpOnly cookie / secure storage)
- [ ] Проверена работа типичного flow: login → получить токен → создать книгу

### Частые проблемы

- [ ] ❌ **401 на создании книги** → Добавь `Authorization: Bearer ${token}`
- [ ] ❌ **404 на `/api/docs`** → Используй `/docs` без префикса
- [ ] ❌ **CORS ошибки** → Проверь `credentials: 'include'` если используешь cookies
- [ ] ❌ **Токен в localStorage** → Переведи на httpOnly cookies или secure storage

---

**Удачи в разработке!** 🚀

Если что-то непонятно - открой Swagger UI и изучи интерактивную документацию:
👉 https://api.bibliaris.com/docs
