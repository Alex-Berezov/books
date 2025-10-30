# 🚀 Быстрый старт для фронтенд разработки

## 📍 Важные URL

### Production API

```
Base URL:     https://api.bibliaris.com/api
Swagger UI:   https://api.bibliaris.com/docs
OpenAPI JSON: https://api.bibliaris.com/docs-json
```

### Local Development

```
Base URL:     http://localhost:5000/api
Swagger UI:   http://localhost:5000/docs
OpenAPI JSON: http://localhost:5000/docs-json
```

## ⚠️ ВАЖНО: Структура URL

**Документация БЕЗ префикса `/api`:**

- ✅ `/docs` - Swagger UI
- ✅ `/docs-json` - OpenAPI схема

**API endpoints С префиксом `/api`:**

- ✅ `/api/books` - Books API
- ✅ `/api/auth/login` - Auth
- ✅ `/api/health/liveness` - Health

## 🔧 Генерация TypeScript типов

```bash
# Production
npx openapi-typescript https://api.bibliaris.com/docs-json -o src/types/api.ts

# Local
npx openapi-typescript http://localhost:5000/docs-json -o src/types/api.ts
```

## 📦 Настройка клиента

```typescript
// .env.local
NEXT_PUBLIC_API_URL=https://api.bibliaris.com

// lib/api.ts
const API_URL = process.env.NEXT_PUBLIC_API_URL + '/api';

export async function fetchAPI(endpoint: string) {
  const response = await fetch(`${API_URL}${endpoint}`);
  return response.json();
}

// Использование
const books = await fetchAPI('/books'); // → https://api.bibliaris.com/api/books
```

## 📚 Полная документация

- **[AI_AGENT_FRONTEND_GUIDE.md](AI_AGENT_FRONTEND_GUIDE.md)** - детальное руководство
- **[API_URL_STRUCTURE.md](API_URL_STRUCTURE.md)** - объяснение структуры URL
- **[ENDPOINTS.md](ENDPOINTS.md)** - полный список endpoints

## ✅ Быстрая проверка

```bash
# API работает?
curl https://api.bibliaris.com/api/health/liveness

# Swagger доступен?
curl https://api.bibliaris.com/docs | grep Swagger

# Схема загружается?
curl https://api.bibliaris.com/docs-json | jq '.info'
```

Готово! 🎉
