# Тестовый пример: PATCH с SEO данными

## Быстрая проверка работы SEO

### 1. Получите существующую страницу

```bash
curl -X GET 'http://localhost:3000/api/admin/en/pages/8ee2d5cf-0dc9-48f1-b7a4-419230ea5d1e' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN'
```

### 2. Обновите страницу с SEO данными

```bash
curl -X PATCH 'http://localhost:3000/api/admin/en/pages/8ee2d5cf-0dc9-48f1-b7a4-419230ea5d1e' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -d '{
    "title": "Test Page with SEO",
    "seo": {
      "metaTitle": "Test SEO Title",
      "metaDescription": "Test SEO Description for this page"
    }
  }'
```

### 3. Проверьте ответ

Должны получить:

```json
{
  "id": "8ee2d5cf-0dc9-48f1-b7a4-419230ea5d1e",
  "title": "Test Page with SEO",
  "seoId": 123,           // ✅ Должен быть number, не null
  "seo": {                // ✅ Должен быть объект, не null
    "id": 123,
    "metaTitle": "Test SEO Title",
    "metaDescription": "Test SEO Description for this page",
    "canonicalUrl": null,
    ...
  }
}
```

## Пример для JavaScript/TypeScript

```typescript
async function updatePageWithSEO(pageId: string, token: string) {
  const response = await fetch(`http://localhost:3000/api/admin/en/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: 'My Updated Page',
      seo: {
        metaTitle: 'SEO Meta Title',
        metaDescription: 'SEO Meta Description',
      },
    }),
  });

  const data = await response.json();

  console.log('SEO ID:', data.seoId); // Должен быть number
  console.log('SEO Object:', data.seo); // Должен быть объект

  if (data.seoId && data.seo) {
    console.log('✅ SEO данные успешно созданы/обновлены!');
  } else {
    console.log('❌ SEO данные не сохранились');
  }
}
```

## Для проверки в браузере DevTools

1. Откройте DevTools → Network
2. Найдите PATCH запрос к `/api/admin/:lang/pages/:id`
3. Проверьте **Request Payload** - должно быть поле `seo`:

```json
{
  "title": "...",
  "slug": "...",
  "type": "generic",
  "seo": {
    // ✅ Это поле ОБЯЗАТЕЛЬНО
    "metaTitle": "...",
    "metaDescription": "..."
  }
}
```

4. Проверьте **Response** - должны вернуться `seoId` и `seo`:

```json
{
  "id": "...",
  "seoId": 42,               // ✅ number, не null
  "seo": {                   // ✅ объект, не null
    "id": 42,
    "metaTitle": "...",
    ...
  }
}
```

## Если не работает

- [ ] Проверьте, что Request Payload содержит поле `seo`
- [ ] Проверьте, что `seo` это объект (не строка, не массив)
- [ ] Проверьте, что хотя бы одно поле в `seo` заполнено (не все null)
- [ ] Проверьте версию backend - должен быть commit 869a248 или новее
