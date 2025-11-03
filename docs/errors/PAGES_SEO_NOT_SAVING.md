# ❌ Проблема: SEO Settings не сохраняются при PATCH

## Симптомы

- Заполняете поля **Meta Title** и **Meta Description** в форме SEO Settings
- Нажимаете "Update Page"
- В ответе приходит `seo: null` и `seoId: null`
- SEO данные не сохраняются

## 🔍 Диагностика

Откройте Chrome DevTools → Network → найдите PATCH запрос → посмотрите **Request Payload**.

### ❌ Неправильный формат (проблема)

```json
{
  "title": "New page 123",
  "slug": "new-page-123",
  "type": "generic"
}
```

**Проблема:** Отсутствует поле `seo` с данными из формы SEO Settings!

### ✅ Правильный формат

```json
{
  "title": "New page 123",
  "slug": "new-page-123",
  "type": "generic",
  "seo": {
    "metaTitle": "About Us - Company Name",
    "metaDescription": "Learn more about our company, mission, and team..."
  }
}
```

## 🐛 Причина

**Frontend не отправляет SEO данные в request body!**

Backend готов принять и автоматически создать/обновить SEO entity, но фронтенд не включает поле `seo` в PATCH запрос.

## ✅ Решение для Frontend разработчика

### 1. Проверьте, что форма собирает SEO данные

```typescript
// ❌ НЕПРАВИЛЬНО - SEO данные игнорируются
const formData = {
  title: form.title,
  slug: form.slug,
  type: form.type,
  // seo данные потеряны!
};

// ✅ ПРАВИЛЬНО - SEO данные включены
const formData = {
  title: form.title,
  slug: form.slug,
  type: form.type,
  seo: {
    metaTitle: form.seoMetaTitle,
    metaDescription: form.seoMetaDescription,
    canonicalUrl: form.seoCanonicalUrl,
    robots: form.seoRobots,
    ogTitle: form.seoOgTitle,
    ogDescription: form.seoOgDescription,
    ogImageUrl: form.seoOgImageUrl,
    twitterCard: form.seoTwitterCard,
    twitterTitle: form.seoTwitterTitle,
    twitterDescription: form.seoTwitterDescription,
  },
};
```

### 2. Правильная структура PATCH запроса

```typescript
// Пример с fetch
fetch(`/api/admin/${lang}/pages/${pageId}`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    title: 'Page Title',
    slug: 'page-slug',
    type: 'generic',
    content: 'Page content...',

    // ✅ ОБЯЗАТЕЛЬНО включите seo объект если есть SEO данные
    seo: {
      metaTitle: 'SEO Meta Title', // Опционально
      metaDescription: 'SEO Description', // Опционально
      canonicalUrl: 'https://site.com/page', // Опционально
      robots: 'index, follow', // Опционально
      ogTitle: 'OG Title', // Опционально
      ogDescription: 'OG Description', // Опционально
      ogImageUrl: 'https://site.com/og.jpg', // Опционально
      twitterCard: 'summary_large_image', // Опционально
      twitterTitle: 'Twitter Title', // Опционально
      twitterDescription: 'Twitter Desc', // Опционально
    },
  }),
});
```

**Важно:** Все поля внутри `seo` опциональны. Можно отправить только те, которые заполнены:

```typescript
// ✅ Можно отправить только заполненные поля
seo: {
  metaTitle: 'Only Meta Title',
  metaDescription: 'Only Meta Description'
  // остальные поля не обязательны
}
```

### 3. Backend автоматически создаст/обновит SEO

Когда вы отправляете `seo` объект, backend:

1. **Если у страницы нет `seoId`** → создаст новую SEO entity и привяжет к странице
2. **Если у страницы есть `seoId`** → обновит существующую SEO entity
3. **Если все поля `null`** → открепит SEO entity (установит `seoId = null`)

### 4. Проверка ответа

После успешного PATCH вы получите:

```json
{
  "id": "8ee2d5cf-0dc9-48f1-b7a4-419230ea5d1e",
  "slug": "new-page-123",
  "title": "New page 123",
  "seoId": 42, // ✅ ID созданной SEO entity
  "seo": {
    // ✅ Полный объект SEO
    "id": 42,
    "metaTitle": "About Us - Company Name",
    "metaDescription": "Learn more about our company",
    "canonicalUrl": null,
    "robots": null,
    "ogTitle": null,
    "ogDescription": null,
    "ogImageUrl": null,
    "twitterCard": null,
    "twitterTitle": null,
    "twitterDescription": null,
    "createdAt": "2025-11-03T08:17:01.277Z",
    "updatedAt": "2025-11-03T08:33:40.235Z"
  },
  "status": "draft",
  "type": "generic",
  "content": "New page 123",
  "language": "en",
  "createdAt": "2025-11-02T17:17:17.272Z",
  "updatedAt": "2025-11-03T08:33:40.235Z"
}
```

## 📋 Checklist для отладки

- [ ] DevTools → Network → PATCH запрос содержит поле `seo` в Request Payload?
- [ ] Поле `seo` является объектом (не строкой, не массивом)?
- [ ] Хотя бы одно поле внутри `seo` заполнено (не все `null`)?
- [ ] Response содержит `seoId` (не `null`) и вложенный объект `seo`?

## 🔗 См. также

- [PAGES_API_GUIDE.md](../PAGES_API_GUIDE.md) - Полное руководство по Pages API
- [PAGES_404_GET_BY_ID.md](./PAGES_404_GET_BY_ID.md) - Решение проблемы 404 при GET /admin/pages/:id

## 📅 История

- **3 ноября 2025** - Создан документ после обнаружения проблемы на frontend
- Backend поддерживает автоматическое создание SEO с 3 ноября 2025 (commit 869a248)
