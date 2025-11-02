# Синхронизация типов API между Backend и Frontend

## 🔍 Проблема которая произошла

### Что случилось?

После изменения формата ответа `GET /admin/:lang/pages` с простого массива на пагинированный объект, **E2E тесты упали**, но проблема могла остаться незамеченной на frontend до production.

### Почему это произошло?

#### 1. **Backend возвращал `Promise<any>` вместо типизированного ответа**

```typescript
// ❌ БЫЛО (плохо):
adminList(...): Promise<any> {
  // Swagger не знает точную структуру ответа
  return this.service.adminList(...);
}
```

**Проблема:** Swagger генерирует схему с типом `any`, frontend получает некорректные типы.

#### 2. **Frontend не обновил типы после изменений**

Frontend использует сгенерированные типы из OpenAPI schema, но:

- Типы не были обновлены после изменения backend
- TypeScript не показал ошибку, потому что тип был `any`
- Код скомпилировался, но в runtime произошла ошибка

### Цепочка событий:

```
1. Backend изменен: возвращает { data: [], meta: {} }
2. Swagger schema НЕ обновлена (тип был any)
3. Frontend НЕ обновил типы
4. TypeScript НЕ показал ошибку (потому что any)
5. Код работает, но в runtime - ошибка
6. E2E тесты падают (это хорошо! 🎉)
```

---

## ✅ Решение

### 1. **Backend: Добавлены типизированные DTO для ответов**

**Создан файл:** `src/modules/pages/dto/page-response.dto.ts`

```typescript
export class PageResponse {
  @ApiProperty({ example: 'uuid-here' })
  id!: string;

  @ApiProperty({ example: 'about-us' })
  slug!: string;

  // ... остальные поля
}

export class PaginationMeta {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 45 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

export class PaginatedPagesResponse {
  @ApiProperty({ type: [PageResponse] })
  data!: PageResponse[];

  @ApiProperty({ type: PaginationMeta })
  meta!: PaginationMeta;
}
```

### 2. **Backend: Обновлен контроллер с типами и ApiResponse**

```typescript
// ✅ СТАЛО (правильно):
@Get('admin/:lang/pages')
@ApiResponse({ status: 200, type: PaginatedPagesResponse })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
adminList(...): Promise<PaginatedPagesResponse> {
  return this.service.adminList(...);
}
```

**Результат:**

- Swagger знает точную структуру ответа
- Генерируемая OpenAPI schema корректна
- Frontend получит правильные типы

### 3. **Frontend должен обновить типы**

#### Автоматическая генерация типов из OpenAPI schema:

```bash
# В backend репозитории уже настроено:
yarn openapi:types:prod

# Эта команда:
# 1. Скачивает schema с https://api.bibliaris.com/docs-json
# 2. Генерирует TypeScript типы в libs/api-client/types.ts
# 3. Frontend может использовать эти типы
```

#### Как frontend должен использовать:

**Вариант 1: Скопировать сгенерированные типы из backend репозитория**

```bash
# Backend генерирует типы
yarn openapi:types:prod

# Скопировать файл libs/api-client/types.ts в frontend проект
cp libs/api-client/types.ts ../frontend/src/types/api.ts
```

**Вариант 2: Frontend генерирует типы самостоятельно**

```bash
# В frontend репозитории
npx openapi-typescript https://api.bibliaris.com/docs-json -o src/types/api.ts
```

**Вариант 3: Использовать общий npm package (рекомендуется для будущего)**

```bash
# 1. Опубликовать libs/api-client как @your-org/api-client
# 2. Frontend устанавливает: npm install @your-org/api-client
# 3. Import: import type { PaginatedPagesResponse } from '@your-org/api-client'
```

---

## 🛡️ Как предотвратить подобные проблемы в будущем?

### 1. **Всегда типизируйте ответы контроллеров**

```typescript
// ❌ НЕ ДЕЛАЙТЕ ТАК:
@Get('/items')
getItems(): Promise<any> { ... }

// ✅ ДЕЛАЙТЕ ТАК:
@Get('/items')
@ApiResponse({ status: 200, type: [ItemDto] })
getItems(): Promise<ItemDto[]> { ... }
```

### 2. **Используйте строгие настройки TypeScript**

В `tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true
  }
}
```

### 3. **Автоматизируйте генерацию типов**

**На backend (уже настроено):**

```json
// package.json
{
  "scripts": {
    "openapi:types:prod": "openapi-typescript https://api.bibliaris.com/docs-json -o libs/api-client/types.ts"
  }
}
```

**На frontend (нужно добавить):**

```json
// package.json
{
  "scripts": {
    "types:generate": "openapi-typescript https://api.bibliaris.com/docs-json -o src/types/api.ts",
    "postinstall": "npm run types:generate"
  }
}
```

### 4. **Добавьте проверку в CI/CD**

**Backend CI** (уже есть в `.github/workflows/ci.yml`):

```yaml
- name: Run tests
  run: yarn test:e2e:serial
```

✅ E2E тесты поймают несоответствия типов!

**Frontend CI** (рекомендуется добавить):

```yaml
- name: Regenerate types
  run: npm run types:generate

- name: Check for type changes
  run: |
    if git diff --exit-code src/types/api.ts; then
      echo "✅ Types are up to date"
    else
      echo "❌ ERROR: API types changed! Please commit updated types."
      exit 1
    fi
```

### 5. **Документируйте процесс обновления**

**Создайте `FRONTEND_API_SYNC.md`:**

````markdown
# Синхронизация API типов

## Когда обновлять типы?

1. После каждого деплоя backend в production
2. При появлении неожиданных ошибок типов
3. Перед началом работы с новыми API endpoints

## Как обновить?

```bash
npm run types:generate
git add src/types/api.ts
git commit -m "chore: update API types"
```
````

---

## 📊 Сравнение: До и После

### До (проблемная ситуация):

```typescript
// Backend
adminList(): Promise<any> { ... }

// Swagger Schema
{
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {} // пустая схема!
        }
      }
    }
  }
}

// Frontend (старые типы)
const response = await api.get('/admin/en/pages');
response.data.forEach(...) // ❌ Runtime error: data.forEach is not a function
```

### После (исправлено):

```typescript
// Backend
adminList(): Promise<PaginatedPagesResponse> { ... }

// Swagger Schema
{
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "type": "object",
            "properties": {
              "data": { "type": "array", "items": { "$ref": "#/components/schemas/PageResponse" } },
              "meta": { "$ref": "#/components/schemas/PaginationMeta" }
            }
          }
        }
      }
    }
  }
}

// Frontend (обновленные типы)
import type { PaginatedPagesResponse } from '@/types/api';

const response = await api.get<PaginatedPagesResponse>('/admin/en/pages');
response.data.data.forEach(...) // ✅ TypeScript проверит это!
```

---

## 🎯 Рекомендации для Frontend команды

### Немедленные действия:

1. **Обновите типы прямо сейчас:**

   ```bash
   npx openapi-typescript https://api.bibliaris.com/docs-json -o src/types/api.ts
   ```

2. **Найдите все места использования Pages API:**

   ```bash
   grep -r "admin.*pages" src/
   ```

3. **Исправьте обращения:**

   ```typescript
   // ❌ БЫЛО:
   const pages = response.data;
   pages.forEach(...)

   // ✅ СТАЛО:
   const { data: pages, meta } = response.data;
   pages.forEach(...)
   ```

### Долгосрочные улучшения:

1. **Настройте автогенерацию типов** (см. выше)
2. **Добавьте проверку в CI**
3. **Используйте typed API client** (например, `openapi-fetch` или `@rtk-query/codegen-openapi`)

---

## 📚 Дополнительные ресурсы

- **Backend OpenAPI Schema:** https://api.bibliaris.com/docs-json
- **Swagger UI:** https://api.bibliaris.com/docs
- **openapi-typescript:** https://openapi-ts.pages.dev/
- **Наша документация:** `docs/ENDPOINTS.md`, `docs/PAGES_API_GUIDE.md`

---

## ✅ Чеклист для Frontend разработчика

- [ ] Обновлены TypeScript типы из OpenAPI schema
- [ ] Исправлены все обращения к `response.data` → `response.data.data`
- [ ] Добавлена обработка `meta` (пагинация)
- [ ] Протестировано локально
- [ ] Настроена автогенерация типов
- [ ] Добавлен процесс в CI/CD
- [ ] Обновлена документация команды
