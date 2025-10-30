# API Client Types для Frontend

Автогенерированные TypeScript типы из OpenAPI спецификации backend API.

## 📦 Что здесь находится

- `types.ts` - TypeScript типы для всех API endpoints (автогенерированный)
- `api-schema.json` - OpenAPI JSON схема (опциональный, для кэша)
- `.gitignore` - исключает сгенерированные файлы из Git (если настроен)

## 🚀 Использование во фронтенде

### 1. Генерация типов

```bash
# В корне backend проекта

# Вариант А: Генерация из локального API (dev сервер должен быть запущен)
yarn openapi:types

# Вариант Б: Генерация из production API
yarn openapi:types:prod

# Вариант В: Сначала скачать схему, потом сгенерировать типы
yarn openapi:schema        # или yarn openapi:schema:prod
yarn openapi:types:from-schema
```

### 2. Копирование в фронтенд проект

```bash
# Из корня backend проекта
cp libs/api-client/types.ts ../frontend/src/types/api.ts
```

Или создайте npm script в фронтенде:

```json
{
  "scripts": {
    "api:types:update": "cp ../books-app-back/libs/api-client/types.ts ./src/types/api.ts"
  }
}
```

### 3. Использование в коде

```typescript
import { paths, components } from '@/types/api';

// Типы для endpoints
type LoginResponse =
  paths['/api/auth/login']['post']['responses']['200']['content']['application/json'];

type BookDTO = components['schemas']['BookDto'];
type UserDTO = components['schemas']['UserDto'];

// Пример с fetch
const login = async (email: string, password: string): Promise<LoginResponse> => {
  const response = await fetch('https://api.bibliaris.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`);
  }

  return response.json();
};
```

## 🔄 Автоматическое обновление типов

### В CI/CD фронтенда

Добавьте шаг обновления типов в GitHub Actions:

```yaml
name: Update API Types

on:
  schedule:
    - cron: '0 2 * * *' # Каждый день в 2:00
  workflow_dispatch: # Ручной запуск

jobs:
  update-types:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate API types
        run: |
          npx openapi-typescript https://api.bibliaris.com/api/docs-json -o src/types/api.ts

      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v5
        with:
          commit-message: 'chore: update API types'
          title: 'Update API types from production'
          branch: 'update-api-types'
```

## 📚 Дополнительные инструменты

### RTK Query Code Generation

Если используете Redux Toolkit Query:

```bash
# Установка
yarn add -D @rtk-query/codegen-openapi

# Конфигурация: rtk-query-codegen.config.ts
import type { ConfigFile } from '@rtk-query/codegen-openapi';

const config: ConfigFile = {
  schemaFile: 'https://api.bibliaris.com/api/docs-json',
  apiFile: './src/store/emptyApi.ts',
  apiImport: 'emptySplitApi',
  outputFile: './src/store/api.ts',
  exportName: 'api',
  hooks: true,
};

export default config;

# Генерация
yarn rtk-query-codegen rtk-query-codegen.config.ts
```

### React Query / TanStack Query

```typescript
// src/lib/api-client.ts
import { paths } from '@/types/api';

type ApiPath = keyof paths;
type ApiMethod<P extends ApiPath> = keyof paths[P];

export async function apiRequest<P extends ApiPath, M extends ApiMethod<P>>(
  path: P,
  method: M,
  options?: RequestInit,
) {
  const response = await fetch(`https://api.bibliaris.com${path}`, {
    method: method.toString().toUpperCase(),
    ...options,
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}
```

## 🔗 Полезные ссылки

- **Production API**: https://api.bibliaris.com
- **Swagger UI**: https://api.bibliaris.com/docs
- **OpenAPI JSON**: https://api.bibliaris.com/api/docs-json
- **Health Check**: https://api.bibliaris.com/api/health/liveness

## 📖 Документация API

Полная документация для интеграции фронтенда:

- [Frontend Integration Guide](../../docs/FRONTEND_INTEGRATION.md)
- [API Examples](../../docs/examples/frontend-examples.ts)

## 🛠️ Troubleshooting

### Ошибка: "Cannot find module '@/types/api'"

Убедитесь, что:

1. Типы сгенерированы: `yarn openapi:types` (в backend)
2. Файл скопирован в фронтенд проект
3. TypeScript alias `@` настроен в `tsconfig.json`

### Ошибка: "Error fetching schema"

Проверьте:

1. API сервер запущен (для локальной генерации)
2. Доступность `/docs-json` endpoint (Swagger всегда включен)
3. Доступность production URL (для prod генерации)
