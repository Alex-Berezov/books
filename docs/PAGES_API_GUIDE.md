# Pages API - Руководство для Frontend разработчиков

## 🚨 ВАЖНО: Правильный формат запросов

### Проблема: 404 Not Found при создании страницы

Если вы получаете `404 Not Found` при `POST /api/admin/:lang/pages`, скорее всего проблема в **формате request body**.

---

## ✅ Правильный формат создания страницы

### Endpoint

```
POST /api/admin/:lang/pages
```

### Headers

```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

### Request Body (ПРАВИЛЬНО ✅)

```json
{
  "slug": "test-page",
  "title": "Test Page",
  "type": "generic", // ⚠️ ОБЯЗАТЕЛЬНОЕ ПОЛЕ!
  "content": "Test content",
  "seoId": null // ⚠️ NUMBER или NULL, НЕ объект!
}
```

**Допустимые значения `type`:**

- `"generic"` - обычная страница
- `"category_index"` - индекс категорий
- `"author_index"` - индекс авторов

---

## ❌ НЕПРАВИЛЬНЫЕ форматы (вызывают ошибки)

### ❌ Передача SEO как объекта

```json
{
  "slug": "test-page",
  "title": "Test Page",
  "type": "generic",
  "content": "Test content",
  "seo": {
    // ❌ НЕПРАВИЛЬНО!
    "title": "SEO Title",
    "description": "SEO Description"
  }
}
```

**Проблема:** Backend ожидает `seoId` (number|null), а не объект `seo`.

### ❌ Отсутствие обязательного поля `type`

```json
{
  "slug": "test-page",
  "title": "Test Page",
  "content": "Test content"
  // type отсутствует ❌
}
```

**Проблема:** Поле `type` обязательно и должно быть одним из: `generic`, `category_index`, `author_index`.

---

## 📖 Работа с SEO для страниц

### ✅ SEO данные автоматически включаются в ответ

Все endpoints для страниц теперь возвращают вложенный объект `seo` когда он существует:

```json
GET /api/admin/pages/{id}

Response:
{
  "id": "uuid",
  "slug": "about",
  "title": "About Us",
  "seoId": 42,
  "seo": {                    // ✅ Автоматически включён
    "id": 42,
    "metaTitle": "About Us - My Site",
    "metaDescription": "Learn more about our company",
    "canonicalUrl": "https://example.com/about",
    "robots": "index, follow",
    "ogTitle": "About Us",
    "ogDescription": "About page description",
    "ogType": "website",
    "ogImageUrl": "https://example.com/og-image.jpg",
    "twitterCard": "summary_large_image",
    "createdAt": "2025-11-03T...",
    "updatedAt": "2025-11-03T..."
  }
}
```

Если страница без SEO:

```json
{
  "id": "uuid",
  "slug": "contact",
  "seoId": null,
  "seo": null // ✅ null когда SEO не привязан
}
```

### Вариант 1: Создать страницу БЕЗ SEO

```json
POST /api/admin/en/pages
{
  "slug": "about",
  "title": "About Us",
  "type": "generic",
  "content": "Lorem ipsum...",
  "seoId": null              // ✅ Без SEO
}
```

### Вариант 2: Создать SEO, затем привязать к странице

**Шаг 1:** Создайте SEO сущность (если такой endpoint существует)

```json
POST /api/seo
{
  "metaTitle": "About Us - My Site",
  "metaDescription": "Learn more about our company"
}

Response:
{
  "id": 42,
  "metaTitle": "About Us - My Site",
  "metaDescription": "Learn more about our company"
}
```

**Шаг 2:** Создайте страницу с `seoId`

```json
POST /api/admin/en/pages
{
  "slug": "about",
  "title": "About Us",
  "type": "generic",
  "content": "Lorem ipsum...",
  "seoId": 42                // ✅ Используем ID из шага 1
}
```

### Вариант 3: Добавить SEO после создания страницы

**Шаг 1:** Создайте страницу без SEO

```json
POST /api/admin/en/pages
{
  "slug": "about",
  "title": "About Us",
  "type": "generic",
  "content": "Lorem ipsum...",
  "seoId": null
}

Response:
{
  "id": "page-uuid-here",
  ...
}
```

**Шаг 2:** Обновите страницу с SEO

```json
PATCH /api/admin/en/pages/page-uuid-here
{
  "seoId": 42
}
```

---

## 📋 Полная схема DTO для Pages

### CreatePageDto (POST)

```typescript
{
  slug: string;              // Обязательно, только латиница/цифры/дефисы
  title: string;             // Обязательно, минимум 2 символа
  type: 'generic' | 'category_index' | 'author_index';  // Обязательно
  content: string;           // Обязательно
  language?: string;         // Опционально (игнорируется, берется из :lang в URL)
  seoId?: number | null;     // Опционально, по умолчанию null
}
```

### UpdatePageDto (PATCH)

```typescript
{
  slug?: string;
  title?: string;
  type?: 'generic' | 'category_index' | 'author_index';
  content?: string;
  language?: 'en' | 'es' | 'fr' | 'pt';
  seoId?: number | null;
  status?: 'draft' | 'published';
}
```

---

## 📍 Все endpoints для Pages

### Admin endpoints (требуют Auth + Role: admin|content_manager)

```
GET    /api/admin/:lang/pages              - Список страниц (пагинированный)
POST   /api/admin/:lang/pages              - Создать страницу
GET    /api/admin/pages/:id                - Получить страницу по ID (любой статус)
PATCH  /api/admin/:lang/pages/:id          - Обновить страницу
DELETE /api/admin/:lang/pages/:id          - Удалить страницу
PATCH  /api/admin/:lang/pages/:id/publish  - Опубликовать страницу
PATCH  /api/admin/:lang/pages/:id/unpublish - Снять с публикации
```

### Public endpoints (без авторизации)

```
GET    /api/:lang/pages/:slug              - Получить опубликованную страницу
GET    /api/pages/:slug                    - Legacy: язык из ?lang или Accept-Language
```

---

## 🔍 Пример полного flow создания страницы

```javascript
// 1. Создать страницу
const createResponse = await fetch('https://api.bibliaris.com/api/admin/en/pages', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    slug: 'privacy-policy',
    title: 'Privacy Policy',
    type: 'generic',
    content: '# Privacy Policy\n\nWe care about your privacy...',
    seoId: null, // Без SEO пока что
  }),
});

const page = await createResponse.json();
console.log('Created page:', page);
// { id: "uuid", slug: "privacy-policy", status: "draft", ... }

// 2. Получить страницу для редактирования
const getResponse = await fetch(`https://api.bibliaris.com/api/admin/pages/${page.id}`, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

const pageData = await getResponse.json();
console.log('Page data:', pageData);
// { id: "uuid", slug: "privacy-policy", status: "draft", content: "...", ... }

// 3. Опубликовать страницу
const publishResponse = await fetch(
  `https://api.bibliaris.com/api/admin/en/pages/${page.id}/publish`,
  {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  },
);

const published = await publishResponse.json();
console.log('Published page:', published);
// { id: "uuid", slug: "privacy-policy", status: "published", ... }

// 4. Проверить на публичном endpoint
const publicResponse = await fetch('https://api.bibliaris.com/api/en/pages/privacy-policy');
const publicPage = await publicResponse.json();
console.log('Public page:', publicPage);
```

---

## 🐛 Troubleshooting

### Получаю 404 при POST /admin/:lang/pages

**Возможные причины:**

1. ❌ Отправляете `seo` объект вместо `seoId` number
2. ❌ Не передаете обязательное поле `type`
3. ❌ Неправильный формат slug (должен быть lowercase, только латиница/цифры/дефисы)
4. ❌ Неправильный URL (проверьте, что используете `/api/admin/:lang/pages`, а не `/api/:lang/pages`)

### Получаю 400 Bad Request

**Возможные причины:**

1. Страница с таким slug уже существует для этого языка
2. Невалидный `seoId` (SEO entity не существует в БД)
3. Невалидный формат slug (должен соответствовать паттерну: `^[a-z0-9-]+$`)

### Получаю 401 Unauthorized

**Причина:** Не передан JWT token или токен невалидный.

**Решение:** Добавьте header `Authorization: Bearer <your-jwt-token>`

### Получаю 403 Forbidden

**Причина:** У пользователя нет роли `admin` или `content_manager`.

**Решение:** Попросите администратора выдать вам нужную роль через:

```
POST /api/users/:userId/roles/content_manager
```

---

## 📚 См. также

- [ENDPOINTS.md](ENDPOINTS.md) - Полный список всех API endpoints
- [FIX_BOOK_VERSION_404.md](FIX_BOOK_VERSION_404.md) - Похожая проблема с Book Versions
- [FRONTEND_COMMON_ISSUES.md](FRONTEND_COMMON_ISSUES.md) - Частые проблемы интеграции
