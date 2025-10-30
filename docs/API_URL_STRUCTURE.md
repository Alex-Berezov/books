# API URL Structure - Архитектурное решение

## 📋 Текущая структура

### Swagger и документация (БЕЗ префикса `/api`)

- **Swagger UI**: `https://api.bibliaris.com/docs`
- **OpenAPI JSON**: `https://api.bibliaris.com/docs-json`

### API endpoints (С префиксом `/api`)

- **Health**: `https://api.bibliaris.com/api/health/liveness`
- **Metrics**: `https://api.bibliaris.com/api/metrics`
- **Business API**: `https://api.bibliaris.com/api/books`, `/api/auth/login`, etc.

## ✅ Почему это оптимально?

### 1. Четкое разделение ответственности

```
/docs           → Документация (для разработчиков)
/docs-json      → OpenAPI схема (для кодогенерации)
/api/*          → Бизнес-логика (для приложения)
```

### 2. Простой доступ к документации

- Разработчикам не нужно помнить `/api/docs` - просто `/docs`
- Swagger доступен по короткому и понятному URL
- OpenAPI схема легко найти: `/docs-json`

### 3. Стандартная практика

Многие API используют похожую структуру:

- GitHub API: `api.github.com/`
- Stripe API: `api.stripe.com/`
- Документация обычно на корневом пути или отдельном домене

### 4. Гибкость конфигурации

```typescript
// src/main.ts
SwaggerModule.setup('docs', app, document); // Swagger ПЕРЕД префиксом
app.setGlobalPrefix('api'); // Префикс только для API
```

Это позволяет:

- Легко добавить другие служебные endpoints без префикса (например `/admin-panel`)
- Изолировать API endpoints под общим префиксом
- Упростить маршрутизацию в Caddy/Nginx

### 5. Совместимость с инструментами

- **openapi-typescript**: `https://api.bibliaris.com/docs-json`
- **Swagger UI**: Встроенный в приложение на `/docs`
- **Postman/Insomnia**: Могут импортировать схему из `/docs-json`

## 🔧 Техническая реализация

### NestJS Setup (src/main.ts)

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Настройка Swagger БЕЗ префикса
  if (swaggerEnabled) {
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs-json',
    });
  }

  // 2. Установка глобального префикса для API
  app.setGlobalPrefix('api');

  await app.listen(5000);
}
```

### Результат маршрутизации:

```
GET /docs           → Swagger UI
GET /docs-json      → OpenAPI JSON
GET /api/books      → Books API
GET /api/auth/login → Auth API
GET /api/health/*   → Health checks
```

## 🌐 Примеры использования

### Для разработчика (человек)

```bash
# Открыть документацию
open https://api.bibliaris.com/docs

# Быстрая проверка API
curl https://api.bibliaris.com/api/health/liveness
```

### Для фронтенд-разработчика (кодогенерация)

```bash
# Сгенерировать TypeScript типы
yarn openapi:types:prod
# → Загружает https://api.bibliaris.com/docs-json

# Локальная разработка
yarn openapi:types
# → Загружает http://localhost:5000/docs-json
```

### Для интеграции (Postman/Insomnia)

```
Import OpenAPI Spec:
URL: https://api.bibliaris.com/docs-json
```

## 🔄 Альтернативные подходы (НЕ используются)

### ❌ Вариант 1: Всё под `/api`

```
/api/docs       → Swagger
/api/docs-json  → OpenAPI
/api/books      → Books API
```

**Минусы**: Длиннее, менее интуитивно, docs смешана с API

### ❌ Вариант 2: Docs на отдельном домене

```
docs.bibliaris.com  → Swagger
api.bibliaris.com   → API
```

**Минусы**: Нужен дополнительный домен, сложнее CORS, избыточно для проекта

### ✅ Вариант 3: Текущий (используется)

```
/docs           → Swagger (документация)
/docs-json      → OpenAPI (схема)
/api/*          → API (бизнес-логика)
```

**Плюсы**: Чистое разделение, короткие URL, стандартная практика

## 📝 Рекомендации

### При разработке

1. Всегда используй `/docs-json` для кодогенерации
2. Swagger UI на `/docs` для ручного тестирования
3. API endpoints всегда с префиксом `/api/*`

### При развертывании

1. Swagger можно отключить через `SWAGGER_ENABLED=0`
2. API endpoints останутся на `/api/*` независимо от Swagger
3. Health checks всегда доступны: `/api/health/*`

### При интеграции

1. **Frontend**: `https://api.bibliaris.com/docs-json` → типы
2. **Mobile**: `https://api.bibliaris.com/api/*` → HTTP клиент
3. **Third-party**: Документация на `https://api.bibliaris.com/docs`

## 🎯 Вывод

**Текущая структура оптимальна потому что:**

- ✅ Четкое разделение документации и API
- ✅ Короткие и понятные URL для docs
- ✅ Единый префикс `/api` для всех бизнес-эндпойнтов
- ✅ Стандартная практика в индустрии
- ✅ Легко масштабируется
- ✅ Совместима со всеми инструментами

**Менять ничего не нужно!** 🎉
