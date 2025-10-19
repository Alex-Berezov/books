# Риски открытого Swagger на Production

## 🤔 Вопрос: Зачем скрывать Swagger, если роуты защищены?

Да, у нас все критичные роуты защищены JWT + Roles, но открытый Swagger всё равно создаёт риски:

## ⚠️ Реальные риски

### 1. 🗺️ Разведка (Information Disclosure)

Swagger предоставляет **полную карту вашего API**:

```yaml
# Что видит атакующий в Swagger:
- Все endpoints и их параметры
- Структура данных (DTO, модели)
- Бизнес-логика приложения
- Версии библиотек (через swagger metadata)
- Названия полей БД (через DTO)
- Роли и права доступа
- Скрытые/незадокументированные endpoints
```

**Пример атаки:**

1. Атакующий видит в Swagger: `POST /api/admin/users/:id/roles`
2. Видит, что нужна роль `admin`
3. Начинает целенаправленно атаковать систему аутентификации
4. Знает точные имена ролей: `admin`, `content_manager`
5. Может искать способы повышения привилегий

### 2. 🎯 Целенаправленные атаки

Зная структуру API, атакующий может:

**Rate Limiting:**

```typescript
// Swagger показывает:
POST / api / auth / login;
POST / api / auth / register;
POST / api / auth / refresh;

// Атакующий видит все auth endpoints
// Может атаковать каждый по отдельности
// Или искать endpoints без rate limiting
```

**Validation Bypass:**

```typescript
// Swagger показывает точную структуру DTO:
{
  "email": "string (email format)",
  "password": "string (min 8 chars)",
  "role": "admin" // ← Опа! А что если отправить role в регистрации?
}

// Атакующий может искать параметры, которые НЕ должны приниматься
```

**Business Logic Flaws:**

```typescript
// Swagger показывает последовательность операций:
1. POST /api/books/{id}/versions - создать версию
2. PATCH /api/versions/{id}/publish - опубликовать

// Атакующий видит: "А что если опубликовать чужую версию?"
// Пробует разные комбинации ID
```

### 3. 🔍 Поиск уязвимостей

**Endpoints без аутентификации:**

```typescript
// В Swagger видно, какие endpoints БЕЗ 🔒 Bearer Auth
// Атакующий концентрируется именно на них:

GET /api/books/:id/versions        // Нет замка
POST /api/views                     // Нет замка
GET /api/sitemap.xml               // Нет замка

// Начинает искать уязвимости именно в этих endpoints
```

**Параметры для инъекций:**

```typescript
// Swagger показывает все параметры:
GET /api/books?search={query}&lang={lang}&sort={field}

// Атакующий видит:
// - search - может быть SQL injection?
// - lang - может быть path traversal?
// - sort - может быть NoSQL injection?
```

### 4. 🎭 Social Engineering

```typescript
// Атакующий видит в Swagger:
POST /api/admin/users/:id/delete
Requires: Bearer Token + Role: admin
Email: admin@example.com (from description)

// Теперь атакующий знает:
// 1. Есть админ с email admin@example.com
// 2. Может отправить фишинг именно на этот email
// 3. Знает структуру админ-панели
```

### 5. 🐛 Deprecated/Hidden Endpoints

```typescript
// В коде могут быть забытые endpoints:
@ApiExcludeEndpoint() // Забыли добавить
@Post('debug/logs')
async getDebugLogs() { ... }

// Swagger всё равно показывает!
// Или старые версии API:
@Post('v1/legacy/import')  // Может иметь уязвимости
```

### 6. 📊 Метрики и мониторинг

```typescript
// Swagger может показывать:
GET / api / metrics; // Prometheus метрики
GET / api / health / detailed; // Детальная информация о системе

// Атакующий видит:
// - Версии зависимостей
// - Использование ресурсов
// - Структуру БД (через Prisma queries в метриках)
// - Время выполнения запросов (для timing attacks)
```

## 🎯 Конкретные примеры из нашего API

### Что видит атакующий:

```typescript
// 1. Структура пользователя
{
  "id": "string (uuid)",
  "email": "string",
  "createdAt": "datetime",
  "roles": ["admin", "content_manager", "user"]
}
// ⚠️ Теперь знает точные названия ролей

// 2. Admin endpoints
POST /api/admin/{lang}/pages
PATCH /api/admin/{lang}/pages/:slug
DELETE /api/admin/{lang}/pages/:slug
// ⚠️ Видит, что язык передаётся в пути - можно попробовать ../../../

// 3. Upload endpoints
POST /api/uploads/presign
POST /api/uploads/confirm
POST /api/uploads/direct
// ⚠️ Видит 3 разных способа загрузки - начинает тестировать каждый

// 4. Rate limiting info
// Swagger комментарии могут раскрывать:
"Rate limit: 10 requests per minute"
// ⚠️ Знает точный лимит - может атаковать прямо под лимитом
```

## ✅ Реальные инциденты

### GitHub API Key Leak (2023)

- Swagger показывал структуру webhooks
- Атакующий нашёл способ получить webhook secrets
- Через них получил доступ к приватным репозиториям

### Uber Security Breach (2016)

- Открытая API документация показывала admin endpoints
- Атакующий нашёл незащищенный debug endpoint
- Получил доступ к 57 миллионам записей

### Facebook API Exposure (2019)

- GraphQL Introspection (аналог Swagger)
- Показывал приватные поля пользователей
- Позволил массовый сбор данных

## 🛡️ Правильный подход

### ❌ НЕ безопасно:

```bash
# Production с открытым Swagger
SWAGGER_ENABLED=1  # Все видят структуру API
```

### ✅ Безопасно:

**Вариант 1: Отключен по умолчанию**

```bash
SWAGGER_ENABLED=0  # Включать только при отладке
```

**Вариант 2: Basic Auth**

```caddy
handle /docs* {
    basicauth {
        admin $2a$14$hashed_password
    }
    reverse_proxy localhost:5000
}
```

**Вариант 3: IP Whitelist**

```caddy
@swagger_allowed {
    path /docs*
    remote_ip 1.2.3.4 5.6.7.8  # Только ваши IP
}

@swagger_denied {
    path /docs*
    not remote_ip 1.2.3.4 5.6.7.8
}

respond @swagger_denied "Not Found" 404
reverse_proxy @swagger_allowed localhost:5000
```

**Вариант 4: Отдельный поддомен**

```caddy
# Публичный API - без Swagger
api.bibliaris.com {
    reverse_proxy localhost:5000
}

# Внутренний admin - со Swagger + Auth
admin.bibliaris.com {
    basicauth {
        admin $2a$14$...
    }
    reverse_proxy localhost:5000
}
```

**Вариант 5: VPN Only**

```bash
# Swagger доступен только через VPN/Tailscale
# В Caddy блокируем публичный доступ
```

## 📝 Рекомендации для нашего проекта

### Текущая ситуация:

```typescript
// src/main.ts
const swaggerEnabled = (process.env.SWAGGER_ENABLED ?? (isProd ? '0' : '1')) === '1';
```

✅ **Правильно**: отключен по умолчанию на production

### Предлагаемая стратегия:

```bash
# 1. Development
SWAGGER_ENABLED=1  # Всегда включен

# 2. Production (default)
SWAGGER_ENABLED=0  # Отключен

# 3. Production (временная отладка)
./scripts/toggle_swagger.sh enable
# Отладка...
./scripts/toggle_swagger.sh disable

# 4. Production (для фронтенд-команды)
# Вариант A: Basic Auth через Caddy
# Вариант B: Отдельный admin поддомен с Auth
# Вариант C: Генерировать схему локально и шарить в S3/CDN
```

## 🎓 Вывод

**Swagger - это не просто документация, это:**

- 🗺️ Карта всего вашего приложения
- 🎯 Инструкция для атакующих
- 🔍 Список потенциальных уязвимостей
- 📊 Метаданные о вашей инфраструктуре

**Даже с защищенными роутами, Swagger раскрывает:**

- Логику приложения (последовательность операций)
- Названия ролей (для brute force)
- Структуру данных (для инъекций)
- Незащищенные endpoints (для атак)
- Ошибки в логике (business logic flaws)

**Принцип безопасности: "Principle of Least Privilege"**

- Не показывай то, что не обязательно показывать
- Даже если endpoints защищены, не раскрывай структуру
- Атакующий должен гадать, а не знать точно

## 🔗 Дополнительно

- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [API1:2023 - Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/)
- [API9:2023 - Improper Assets Management](https://owasp.org/API-Security/editions/2023/en/0xa9-improper-inventory-management/)
