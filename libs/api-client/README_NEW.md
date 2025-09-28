# 📚 Books App API Client

Готовый TypeScript API клиент для быстрой интеграции фронтенда с Books App.

## 🚀 Быстрый старт

### 1. Копирование

```bash
cp -r libs/api-client your-frontend/src/api
```

### 2. Зависимости

```bash
yarn add axios
```

### 3. Использование

```typescript
import { BooksApiClient } from './api';

const api = new BooksApiClient({
  baseURL: 'https://api.example.com',
});

// Аутентификация
await api.login({ email: 'user@example.com', password: 'pass' });

// Получение данных
const books = await api.books.getAll({ limit: 20 });
const user = await api.users.getMe();
```

## 📋 Доступные API

- **Аутентификация**: login, register, logout
- **Книги**: getAll, getById, getOverview
- **Категории**: getAll, getTree
- **Пользователи**: getMe, updateMe
- **Библиотека**: get, add, remove
- **Прогресс чтения**: get, update

## 📖 Полная документация

См. `FRONTEND_INTEGRATION.md` для детального руководства и примеров React/Vue/Node.js.

---

✅ **Готов к продакшену**: Полная типизация TypeScript, автообновление JWT токенов, обработка ошибок
