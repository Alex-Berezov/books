# Итерация 8: Полная подготовка Backend для Frontend

> **Дата создания:** 12.10.2025  
> **Дата обновления:** 18.10.2025  
> **Статус:** ⏸️ ЧАСТИЧНО ЗАВЕРШЕНА - Требуется настройка api.bibliaris.com  
> **Предыдущая итерация:** Итерация 7 - Применение настроек домена и очистка документации ✅

---

## ⚠️ ВАЖНОЕ ОБНОВЛЕНИЕ (18.10.2025)

### ✅ Что уже работает:

**Production Deployment полностью функционален:**

- ✅ **Домен**: https://bibliaris.com
- ✅ **API**: https://bibliaris.com/api/health/liveness
- ✅ **Database**: https://bibliaris.com/api/health/readiness
- ✅ **Metrics**: https://bibliaris.com/api/metrics
- ✅ **Swagger**: https://bibliaris.com/docs
- ✅ **CORS**: Настроен для `https://bibliaris.com` и localhost
- ✅ **GitHub Actions**: CI/CD pipeline работает с `.env.prod` из GitHub Secrets
- ✅ **Security**: JWT auth, rate limiting, SSL certificates

**Успешно решены проблемы деплоя:**

1. Создание `.env.prod` из GitHub Secrets (commit 568b1d3)
2. Таймаут healthcheck (15s delay + 60 attempts, commit eaee6a4)
3. Проверки через Node.js вместо wget (commit a77181b)

### 🔧 Что требуется для завершения Iteration 8:

**Основная задача: Настроить api.bibliaris.com**

- Текущий домен `bibliaris.com` используется для API
- Нужно разделить: `api.bibliaris.com` → API, `bibliaris.com` → Frontend
- См. **Этап 1** ниже для деталей настройки DNS и Caddy

---

## 🎯 ЦЕЛЬ ИТЕРАЦИИ

**Подготовить backend к полноценной работе с фронтенд-приложением:**

- Настроить правильную архитектуру доменов (api.bibliaris.com + bibliaris.com)
- Настроить CORS для development и production окружений
- Проверить и документировать все endpoints для фронтенда
- Создать систему автогенерации TypeScript типов
- Настроить rate limiting для критичных endpoints
- Подготовить документацию для фронтенд-разработчиков

## 📋 ПЛАН РАБОТ

---

### Этап 1: Архитектура доменов (60 мин)

**Цель:** Разделить API и фронтенд на разные домены

#### Текущее состояние:

- ⚠️ `bibliaris.com` → API backend (порт 5000) - **РАБОТАЕТ, НО требует переноса на api.bibliaris.com**
- ❌ Нет отдельного поддомена для API
- ❌ Фронтенд некуда деплоить
- ✅ CORS уже настроен: `CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001`
- ✅ SSL сертификат работает для bibliaris.com
- ✅ Caddy reverse proxy настроен и работает

#### Целевое состояние:

- ✅ `api.bibliaris.com` → API backend
- ✅ `bibliaris.com` → Frontend приложение
- ✅ Правильная изоляция и безопасность

#### Задачи:

**1.1. Настройка DNS в Namecheap** (10 мин)

```bash
# Добавить A-запись для api.bibliaris.com
Type: A Record
Host: api
Value: 209.74.88.183
TTL: Automatic
```

**1.2. Обновление Caddy конфигурации** (20 мин)

Файл: `/etc/caddy/Caddyfile`

```caddyfile
# API Backend
api.bibliaris.com {
    reverse_proxy localhost:5000

    # CORS headers для фронтенда
    @cors {
        header Origin https://bibliaris.com
    }
    header @cors {
        Access-Control-Allow-Origin "https://bibliaris.com"
        Access-Control-Allow-Credentials "true"
        Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization, X-Admin-Language, Accept-Language"
    }

    # Заголовки безопасности
    header {
        -Server
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # Логирование
    log {
        output file /var/log/caddy/api.bibliaris.com.log {
            roll_size 100mb
            roll_keep 5
        }
        format json
    }
}

# Frontend (будущее)
bibliaris.com {
    # Пока редирект на api, потом будет фронтенд
    redir https://api.bibliaris.com{uri} temporary

    header {
        -Server
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }
}

# Редирект с www
www.bibliaris.com {
    redir https://bibliaris.com{uri} permanent
}

www.api.bibliaris.com {
    redir https://api.bibliaris.com{uri} permanent
}
```

**1.3. Обновление .env.prod на сервере** (10 мин)

Файл: `/opt/books/app/src/.env.prod`

```bash
# API Base URL
LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com

# CORS Settings для production
CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001
CORS_CREDENTIALS=1

# Trust proxy (за Caddy)
TRUST_PROXY=1
```

**1.4. Тестирование и применение** (20 мин)

```bash
# На сервере
ssh deploy@209.74.88.183

# 1. Проверить синтаксис Caddy
sudo caddy validate --config /etc/caddy/Caddyfile

# 2. Перезапустить Caddy
sudo systemctl reload caddy

# 3. Проверить логи
sudo journalctl -u caddy -f

# 4. Перезапустить приложение с новым .env.prod
cd /opt/books/app/src
docker compose -f docker-compose.prod.yml restart app

# 5. Проверить здоровье
curl -I https://api.bibliaris.com/api/health/liveness
curl -I https://api.bibliaris.com/docs
```

**Критерии готовности:**

- ✅ DNS api.bibliaris.com резолвится
- ✅ https://api.bibliaris.com/api/health/liveness возвращает 200
- ✅ https://api.bibliaris.com/docs доступен Swagger
- ✅ SSL сертификат автоматически выпущен для api.bibliaris.com
- ✅ CORS headers присутствуют в ответах

---

### Этап 2: CORS и безопасность для фронтенда (15 мин)

**Цель:** Проверить и дополнить существующую конфигурацию CORS

**✅ Уже реализовано в `.env.prod`:**

- CORS_ORIGIN настроен для production и development
- CORS_CREDENTIALS включены (cookies работают)
- Rate limiting уже работает глобально через throttler

#### Задачи:

**2.1. Проверить текущую конфигурацию CORS** (5 мин)

Создать: `src/config/cors.config.ts`

```typescript
import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export function getCorsConfig(): CorsOptions {
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
    : ['*'];

  const isDevelopment = process.env.NODE_ENV !== 'production';

  return {
    origin: (origin, callback) => {
      // Разрешаем запросы без origin (например, Postman, curl)
      if (!origin) {
        return callback(null, true);
      }

      // В development разрешаем все localhost порты
      if (isDevelopment && origin.includes('localhost')) {
        return callback(null, true);
      }

      // Проверяем whitelist
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Отклоняем неизвестные origins
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: process.env.CORS_CREDENTIALS === '1',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Admin-Language',
      'Accept-Language',
      'Accept',
      'Origin',
      'X-Requested-With',
    ],
    exposedHeaders: ['Content-Length', 'X-Total-Count'],
    maxAge: 86400, // 24 hours
  };
}
```

**2.2. Обновление main.ts** (10 мин)

```typescript
import { getCorsConfig } from './config/cors.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS
  app.enableCors(getCorsConfig());

  // ... остальной код
}
```

**2.3. Rate Limiting для критичных endpoints** (10 мин)

Обновить: `src/modules/auth/auth.controller.ts`

```typescript
import { Throttle } from '@nestjs/throttler';

@Controller('auth')
export class AuthController {
  // Более строгий лимит для логина (защита от брутфорса)
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 попыток в минуту
  @Post('login')
  async login(@Body() dto: LoginDto) {
    // ...
  }

  // Лимит для регистрации (защита от спама)
  @Throttle({ default: { limit: 3, ttl: 300000 } }) // 3 попытки в 5 минут
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    // ...
  }

  // Refresh токена
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 попыток в минуту
  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto) {
    // ...
  }
}
```

**Критерии готовности:**

- ✅ CORS работает для всех разрешенных origins
- ✅ Credentials (cookies) передаются корректно
- ✅ Rate limiting защищает от брутфорса
- ✅ Тесты проходят с новой конфигурацией

---

### Этап 3: Автогенерация TypeScript типов для фронтенда (45 мин)

**Цель:** Создать систему автоматической генерации типов из OpenAPI спецификации

#### Задачи:

**3.1. Настройка генерации типов** (15 мин)

Обновить: `package.json`

```json
{
  "scripts": {
    "openapi:generate": "yarn openapi:generate:local && yarn openapi:generate:prod",
    "openapi:generate:local": "node scripts/generate-openapi-types.js http://localhost:5000/api/docs-json",
    "openapi:generate:prod": "node scripts/generate-openapi-types.js https://api.bibliaris.com/api/docs-json"
  }
}
```

**3.2. Создание скрипта генерации** (20 мин)

Создать: `scripts/generate-openapi-types.js`

```javascript
#!/usr/bin/env node

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const url = process.argv[2] || 'http://localhost:5000/api/docs-json';
const outputDir = path.join(__dirname, '../libs/api-client');
const outputFile = path.join(outputDir, 'api-schema.json');

console.log(`📥 Fetching OpenAPI schema from ${url}...`);

const client = url.startsWith('https') ? https : http;

client
  .get(url, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.error(`❌ Failed to fetch schema: ${res.statusCode}`);
        process.exit(1);
      }

      try {
        const schema = JSON.parse(data);

        // Создаем директорию если не существует
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        // Сохраняем schema
        fs.writeFileSync(outputFile, JSON.stringify(schema, null, 2));
        console.log(`✅ OpenAPI schema saved to ${outputFile}`);

        // Опционально: генерируем TypeScript типы с помощью openapi-typescript
        console.log('💡 To generate TypeScript types, run:');
        console.log(`   npx openapi-typescript ${outputFile} -o libs/api-client/types.ts`);
      } catch (error) {
        console.error('❌ Error parsing JSON:', error.message);
        process.exit(1);
      }
    });
  })
  .on('error', (error) => {
    console.error('❌ Error fetching schema:', error.message);
    process.exit(1);
  });
```

**3.3. Установка openapi-typescript** (5 мин)

```bash
yarn add -D openapi-typescript
```

Обновить `package.json`:

```json
{
  "scripts": {
    "openapi:types": "yarn openapi:generate:local && npx openapi-typescript libs/api-client/api-schema.json -o libs/api-client/types.ts",
    "openapi:types:prod": "yarn openapi:generate:prod && npx openapi-typescript libs/api-client/api-schema.json -o libs/api-client/types.ts"
  }
}
```

**3.4. Создание README для фронтенд-разработчиков** (5 мин)

Создать: `libs/api-client/README.md`

````markdown
# API Client Types для Frontend

Автогенерированные TypeScript типы из OpenAPI спецификации backend.

## Использование во фронтенде

### 1. Скопировать типы

```bash
# Из корня backend проекта
yarn openapi:types:prod

# Скопировать в фронтенд проект
cp libs/api-client/types.ts ../frontend/src/types/api.ts
```
````

### 2. Использовать в коде

```typescript
import { paths, components } from '@/types/api';

// Типы для endpoints
type LoginResponse =
  paths['/api/auth/login']['post']['responses']['200']['content']['application/json'];
type BookDTO = components['schemas']['BookDto'];

// Пример с fetch
const response = await fetch('https://api.bibliaris.com/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

const data: LoginResponse = await response.json();
```

### 3. Автоматическое обновление

Добавьте в CI/CD фронтенда шаг обновления типов:

```yaml
- name: Update API types
  run: |
    curl https://api.bibliaris.com/api/docs-json -o api-schema.json
    npx openapi-typescript api-schema.json -o src/types/api.ts
```

## Доступные endpoints

Полная документация: https://api.bibliaris.com/docs

````

**Критерии готовности:**
- ✅ Скрипт генерации работает для local и prod
- ✅ TypeScript типы генерируются корректно
- ✅ Документация для фронтенда создана
- ✅ Все DTO покрыты Swagger декораторами

---

### Этап 4: Документация для фронтенд-разработчиков (45 мин)

**Цель:** Создать исчерпывающую документацию для интеграции с фронтендом

#### Задачи:

**4.1. Создание основной документации** (30 мин)

Создать: `docs/FRONTEND_INTEGRATION.md`

```markdown
# Интеграция Frontend с Backend API

> Полное руководство по интеграции фронтенд-приложения с API

## 🌐 Endpoints

### Production
- **API Base URL**: `https://api.bibliaris.com`
- **Swagger Docs**: `https://api.bibliaris.com/docs`
- **Health Check**: `https://api.bibliaris.com/api/health/liveness`

### Development (локальный backend)
- **API Base URL**: `http://localhost:5000`
- **Swagger Docs**: `http://localhost:5000/docs`

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
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "displayName": "John Doe",
    "role": "user"
  },
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc..."
}
````

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
  "user": { ... },
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc..."
}
```

### Refresh Token

```typescript
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "eyJhbGc..."
}

Response 200:
{
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc..."
}
```

### Использование токена

```typescript
// Все защищенные endpoints требуют Bearer token
Authorization: Bearer<accessToken>;
```

## 📚 Основные публичные endpoints

### Книги

```typescript
// Получить обзор книги
GET /api/:lang/books/:slug/overview
Accept-Language: en

Response 200:
{
  "book": { ... },
  "versions": [ ... ],
  "availableLanguages": ["en", "es", "fr"]
}

// Получить главу книги
GET /api/books/:bookId/versions/:versionId/chapters/:chapterId
Response 200: { ... }
```

### Категории

```typescript
// Книги по категории
GET /api/:lang/categories/:slug/books
Response 200: {
  "items": [ ... ],
  "total": 42,
  "availableLanguages": ["en", "es"]
}
```

### Теги

```typescript
// Книги по тегу
GET /api/:lang/tags/:slug/books
Response 200: { ... }
```

### Страницы (CMS)

```typescript
// Получить страницу
GET /api/:lang/pages/:slug
Response 200: {
  "id": "uuid",
  "slug": "about",
  "title": "About Us",
  "content": "...",
  "language": "en"
}
```

## 🔒 Защищенные endpoints (требуют аутентификации)

### Bookshelf (полка пользователя)

```typescript
// Получить книги на полке
GET /api/bookshelf
Authorization: Bearer <token>

Response 200: {
  "items": [ ... ],
  "total": 5
}

// Добавить книгу на полку
POST /api/bookshelf
Authorization: Bearer <token>
Content-Type: application/json

{
  "bookId": "uuid",
  "versionId": "uuid"
}
```

### Прогресс чтения

```typescript
// Обновить прогресс
POST /api/books/:bookId/versions/:versionId/progress
Authorization: Bearer <token>

{
  "chapterId": "uuid",
  "progress": 45.5
}
```

### Комментарии

```typescript
// Добавить комментарий
POST /api/books/:bookId/versions/:versionId/chapters/:chapterId/comments
Authorization: Bearer <token>

{
  "text": "Great chapter!",
  "paragraphIndex": 5
}
```

### Лайки

```typescript
// Лайкнуть версию
POST /api/books/:bookId/versions/:versionId/like
Authorization: Bearer <token>

// Удалить лайк
DELETE /api/books/:bookId/versions/:versionId/like
Authorization: Bearer <token>
```

## 🌍 Мультиязычность (i18n)

### Поддерживаемые языки

- `en` - English
- `es` - Español
- `fr` - Français
- `pt` - Português

### Приоритет определения языка

1. **Префикс в URL**: `/:lang/...` (наивысший приоритет)
2. **Query параметр**: `?lang=en`
3. **Заголовок**: `Accept-Language: en`
4. **По умолчанию**: `en`

### Примеры

```typescript
// Использование префикса (рекомендуется)
GET /api/en/books/harry-potter/overview

// Использование заголовка
GET /api/books/harry-potter/overview
Accept-Language: es

// Использование query
GET /api/books/harry-potter/overview?lang=fr
```

## ❌ Обработка ошибок

### Формат ошибок

```typescript
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request",
  "details": [
    {
      "field": "email",
      "message": "email must be a valid email"
    }
  ]
}
```

### HTTP статусы

- `200` - Success
- `201` - Created
- `204` - No Content
- `400` - Bad Request (валидация)
- `401` - Unauthorized (нет токена или истек)
- `403` - Forbidden (недостаточно прав)
- `404` - Not Found
- `429` - Too Many Requests (rate limit)
- `500` - Internal Server Error

## 🚦 Rate Limiting

### Лимиты

- **Глобальный**: 100 запросов в минуту
- **Login**: 5 попыток в минуту
- **Register**: 3 попытки в 5 минут
- **Комментарии**: 10 операций в минуту

### Заголовки ответа

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1634567890
```

## 🍪 Cookies и CORS

### Credentials

Если нужны cookies (для refresh token), включите credentials:

```typescript
fetch('https://api.bibliaris.com/api/auth/login', {
  credentials: 'include', // Важно!
  // ...
});
```

### CORS

API настроен на следующие origins:

- `https://bibliaris.com` (production)
- `http://localhost:3000` (development)
- `http://localhost:3001` (development альтернативный)

## 📊 Мониторинг и метрики

### Health Checks

```typescript
// Проверка жизнеспособности
GET /api/health/liveness
Response 200: { "status": "up" }

// Проверка готовности (включает БД)
GET /api/health/readiness
Response 200: {
  "status": "up",
  "details": {
    "prisma": "up",
    "redis": "skipped"
  }
}
```

## 🔧 TypeScript типы

### Установка

```bash
# В backend проекте
yarn openapi:types:prod

# Копирование в frontend
cp libs/api-client/types.ts ../frontend/src/types/api.ts
```

### Использование

```typescript
import { paths, components } from '@/types/api';

type LoginRequest = components['schemas']['LoginDto'];
type LoginResponse =
  paths['/api/auth/login']['post']['responses']['200']['content']['application/json'];

const login = async (data: LoginRequest): Promise<LoginResponse> => {
  const response = await fetch('https://api.bibliaris.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error('Login failed');
  }

  return response.json();
};
```

## 📱 Best Practices

### 1. Хранение токенов

```typescript
// ✅ Рекомендуется: HttpOnly cookies для refresh token
// ✅ Рекомендуется: Memory для access token
// ❌ Не рекомендуется: localStorage для refresh token

// Пример с memory store
let accessToken: string | null = null;

async function getAccessToken(): Promise<string> {
  if (accessToken && !isTokenExpired(accessToken)) {
    return accessToken;
  }

  // Refresh через cookie
  const response = await fetch('/api/auth/refresh', {
    credentials: 'include',
  });

  const data = await response.json();
  accessToken = data.accessToken;
  return accessToken;
}
```

### 2. Retry механизм для 401

```typescript
async function fetchWithAuth(url: string, options: RequestInit = {}) {
  let token = await getAccessToken();

  let response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  // Если 401, пробуем обновить токен и повторить
  if (response.status === 401) {
    token = await refreshAccessToken();
    response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  }

  return response;
}
```

### 3. Обработка Rate Limiting

```typescript
async function fetchWithRetry(url: string, options: RequestInit = {}, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, i) * 1000;

      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    return response;
  }

  throw new Error('Max retries exceeded');
}
```

## 🔗 Полезные ссылки

- **Swagger UI**: https://api.bibliaris.com/docs
- **OpenAPI JSON**: https://api.bibliaris.com/api/docs-json
- **Health Check**: https://api.bibliaris.com/api/health/liveness
- **GitHub**: [backend repository]

````

**4.2. Создание примеров использования** (10 мин)

Создать: `docs/examples/frontend-examples.ts`

```typescript
/**
 * Примеры использования API для фронтенд-разработчиков
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api.bibliaris.com';

// ============================================
// Аутентификация
// ============================================

export async function register(email: string, password: string, displayName: string) {
  const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }

  return response.json();
}

export async function login(email: string, password: string) {
  const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // Для cookies
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }

  return response.json();
}

// ============================================
// Публичные endpoints
// ============================================

export async function getBookOverview(slug: string, lang: string = 'en') {
  const response = await fetch(`${API_BASE_URL}/api/${lang}/books/${slug}/overview`, {
    headers: {
      'Accept-Language': lang,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch book overview');
  }

  return response.json();
}

export async function getCategoryBooks(slug: string, lang: string = 'en', page: number = 1) {
  const response = await fetch(
    `${API_BASE_URL}/api/${lang}/categories/${slug}/books?page=${page}&limit=20`,
    {
      headers: {
        'Accept-Language': lang,
      },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to fetch category books');
  }

  return response.json();
}

// ============================================
// Защищенные endpoints
// ============================================

export async function getBookshelf(accessToken: string) {
  const response = await fetch(`${API_BASE_URL}/api/bookshelf`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch bookshelf');
  }

  return response.json();
}

export async function addToBookshelf(accessToken: string, bookId: string, versionId: string) {
  const response = await fetch(`${API_BASE_URL}/api/bookshelf`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ bookId, versionId }),
  });

  if (!response.ok) {
    throw new Error('Failed to add to bookshelf');
  }

  return response.json();
}

export async function likeBookVersion(accessToken: string, bookId: string, versionId: string) {
  const response = await fetch(
    `${API_BASE_URL}/api/books/${bookId}/versions/${versionId}/like`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to like book version');
  }

  return response.json();
}

// ============================================
// React Hook пример
// ============================================

export function useBookOverview(slug: string, lang: string = 'en') {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    getBookOverview(slug, lang)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [slug, lang]);

  return { data, loading, error };
}

// ============================================
// Axios пример (если используете axios)
// ============================================

import axios from 'axios';

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true, // Для cookies
});

// Interceptor для автоматического добавления токена
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Interceptor для обработки 401 и refresh token
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const { data } = await axios.post(`${API_BASE_URL}/api/auth/refresh`, {
          refreshToken: localStorage.getItem('refreshToken'),
        });

        localStorage.setItem('accessToken', data.accessToken);
        localStorage.setItem('refreshToken', data.refreshToken);

        originalRequest.headers.Authorization = `Bearer ${data.accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Redirect to login
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export { api };
````

**4.3. Quick Start Guide** (5 мин)

Создать: `docs/FRONTEND_QUICK_START.md`

````markdown
# Frontend Quick Start

Быстрый старт интеграции с backend API.

## 🚀 За 5 минут

### 1. Environment Variables

Создайте `.env.local` в фронтенд проекте:

```bash
NEXT_PUBLIC_API_URL=http://localhost:5000  # для dev
# NEXT_PUBLIC_API_URL=https://api.bibliaris.com  # для prod
```
````

### 2. Fetch книги

```typescript
const response = await fetch(
  `${process.env.NEXT_PUBLIC_API_URL}/api/en/books/harry-potter/overview`,
);
const data = await response.json();
```

### 3. Аутентификация

```typescript
// Login
const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com', password: 'password' }),
});

const { accessToken, user } = await response.json();

// Использование токена
const protectedResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/bookshelf`, {
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
});
```

### 4. Готово! 🎉

Полная документация: [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md)

## 📚 Полезные ссылки

- **Swagger**: https://api.bibliaris.com/docs
- **Health Check**: https://api.bibliaris.com/api/health/liveness
- **Примеры кода**: [examples/frontend-examples.ts](examples/frontend-examples.ts)

````

**Критерии готовности:**
- ✅ Документация покрывает все основные сценарии
- ✅ Примеры кода работают и протестированы
- ✅ Quick Start Guide позволяет начать работу за 5 минут
- ✅ Описаны best practices и типичные ошибки

---

### Этап 5: Финальное тестирование и проверка (30 мин)

**Цель:** Убедиться что все работает для фронтенда

#### Задачи:

**5.1. Тестирование с curl** (10 мин)

```bash
# 1. Health check
curl -I https://api.bibliaris.com/api/health/liveness

# 2. Проверка CORS (OPTIONS preflight)
curl -X OPTIONS https://api.bibliaris.com/api/books \
  -H "Origin: https://bibliaris.com" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -v

# 3. Тест публичного endpoint с CORS
curl https://api.bibliaris.com/api/en/books/test-book/overview \
  -H "Origin: https://bibliaris.com" \
  -v

# 4. Тест аутентификации
curl -X POST https://api.bibliaris.com/api/auth/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://bibliaris.com" \
  -d '{"email":"test@example.com","password":"password"}' \
  -v

# 5. Проверка Swagger
curl -I https://api.bibliaris.com/docs

# 6. Проверка OpenAPI JSON
curl https://api.bibliaris.com/api/docs-json | jq '.info'
````

**5.2. Тестирование с Postman/Insomnia** (10 мин)

Создать коллекцию запросов:

- Аутентификация (register, login, refresh)
- Публичные endpoints (books, categories, tags)
- Защищенные endpoints (bookshelf, likes, comments)

**5.3. Генерация типов и проверка** (10 мин)

```bash
# Генерация типов
yarn openapi:types:prod

# Проверка что файл создан
cat libs/api-client/types.ts | head -20

# Проверка что все DTO имеют Swagger декораторы
yarn test:e2e -- --grep "Swagger"
```

**Критерии готовности:**

- ✅ Все curl команды возвращают ожидаемые результаты
- ✅ CORS headers присутствуют в ответах
- ✅ TypeScript типы генерируются без ошибок
- ✅ Swagger UI доступен и отображает все endpoints
- ✅ Rate limiting работает корректно

---

## 📊 ЧЕКЛИСТ ГОТОВНОСТИ

### Инфраструктура:

- [ ] DNS: api.bibliaris.com настроен и резолвится
- [ ] SSL: Сертификат для api.bibliaris.com выпущен
- [ ] Caddy: Конфигурация обновлена для двух доменов
- [ ] .env.prod: Обновлены CORS_ORIGIN и LOCAL_PUBLIC_BASE_URL
- [ ] Docker: Приложение перезапущено с новыми настройками
- [x] **Production Deployment**: ✅ Работает на bibliaris.com (18.10.2025)
- [x] **GitHub Actions CI/CD**: ✅ Pipeline с .env.prod из secrets
- [x] **Health Checks**: ✅ Liveness, readiness, metrics работают
- [x] **SSL Certificates**: ✅ Caddy автоматически управляет для bibliaris.com

### Безопасность:

- [x] **CORS**: ✅ Настроен для production и development origins в .env.prod
- [x] **CORS**: ✅ Credentials включены для cookies
- [x] **Rate Limiting**: ✅ Глобальный лимит работает
- [ ] Rate Limiting: Auth endpoints требуют специфичных лимитов (см. Этап 2)

### Документация:

- [ ] FRONTEND_INTEGRATION.md: Создан и заполнен
- [ ] FRONTEND_QUICK_START.md: Создан для быстрого старта
- [ ] examples/frontend-examples.ts: Примеры кода работают
- [ ] libs/api-client/README.md: Инструкции по типам

### Типизация:

- [ ] openapi-typescript: Установлен
- [ ] Scripts: Команды генерации типов работают
- [ ] Types: TypeScript типы генерируются корректно
- [ ] Swagger: Все DTO имеют декораторы

### Тестирование:

- [ ] curl: Все тестовые команды работают
- [ ] CORS: Preflight requests обрабатываются
- [ ] Auth: Регистрация и логин работают
- [ ] Endpoints: Публичные и защищенные endpoints доступны
- [ ] Types: Генерация типов из production API работает

### Финал:

- [ ] README: Обновлен с информацией о api.bibliaris.com
- [ ] CHANGELOG: Добавлена запись об Iteration 8
- [ ] Git: Все изменения закоммичены и запушены
- [ ] Production: Все проверки пройдены успешно

---

## 🎯 ОЖИДАЕМЫЙ РЕЗУЛЬТАТ

После выполнения всех задач:

### Для фронтенд-разработчика:

✅ **API доступен**: https://api.bibliaris.com  
✅ **Документация**: https://api.bibliaris.com/docs  
✅ **TypeScript типы**: Автогенерация работает  
✅ **CORS**: Настроен для dev и prod  
✅ **Примеры кода**: Готовы к использованию  
✅ **Quick Start**: Работа за 5 минут

### Для системы:

✅ **Домены**: api.bibliaris.com (API) + bibliaris.com (будущий фронт)  
✅ **Безопасность**: CORS, Rate Limiting, SSL  
✅ **Мониторинг**: Health checks работают  
✅ **Масштабирование**: Готовность к высоким нагрузкам

---

## 📝 СЛЕДУЮЩИЕ ШАГИ (после Iteration 8)

1. **Развертывание фронтенда** на bibliaris.com
2. **Настройка CI/CD** для автоматического обновления типов
3. **Мониторинг интеграции** (логи CORS ошибок, rate limiting)
4. **Оптимизация** (кэширование, CDN для статики)

---

**Estimated Time**: ~3-4 часа  
**Priority**: HIGH (блокирует разработку фронтенда)  
**Complexity**: Medium

**Начинаем когда готов!** 🚀
