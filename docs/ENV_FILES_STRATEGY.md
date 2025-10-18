# Стратегия управления переменными окружения

## Файлы конфигурации

### 📝 `.env` (локальная разработка)

- **Статус**: В `.gitignore`, НЕ коммитится
- **Назначение**: Локальная разработка каждого разработчика
- **Создание**: Копировать из `.env.example`
- **Содержит**: Настройки для локальной БД, Redis, JWT секреты для dev

```bash
cp .env.example .env
# Отредактируйте под свои локальные настройки
```

### 🧪 `.env.test` (E2E тесты)

- **Статус**: **КОММИТИТСЯ в Git**
- **Назначение**: E2E тесты локально и в CI/CD
- **Содержит**: Только тестовые credentials (безопасно для публичного репо)
- **Требования**: PostgreSQL с правами суперпользователя (для CREATE/DROP DATABASE)

**Почему коммитится?**

- Содержит только тестовые данные, не production секреты
- Нужен для GitHub Actions CI/CD
- Обеспечивает единую конфигурацию для всех разработчиков

**Локальное переопределение:**

```bash
# Если нужны локальные изменения (не коммитить!)
cp .env.test .env.test.local
# Отредактируйте .env.test.local
```

### 🚀 `.env.prod` (Production)

- **Статус**: В `.gitignore`, **НИКОГДА не коммитить!**
- **Назначение**: Production сервер
- **Создание**: На сервере из `.env.prod.template`
- **Содержит**: **Реальные секреты** (пароли БД, JWT ключи, API ключи)
- **Управление**: Через GitHub Secrets в CI/CD

**⚠️ КРИТИЧЕСКИ ВАЖНО:**

- НИКОГДА не коммитьте `.env.prod` в Git
- В GitHub Actions используется secret `ENV_PROD` для создания файла
- На сервере файл должен иметь права `600` (только владелец может читать/писать)

## Переменные окружения в GitHub Actions

### Test Job

В CI тесты получают переменные двумя способами:

1. Из закоммиченного `.env.test`
2. Переопределение через `env:` в workflow (для DATABASE_URL с service credentials)

```yaml
- name: 🧪 E2E Tests
  run: yarn test:e2e:serial
  env:
    NODE_ENV: test
    DATABASE_URL: postgresql://test_user:test_pass@localhost:5432/books_test
    REDIS_HOST: localhost
```

### Deploy Job

Production credentials:

1. Хранятся в GitHub Secret: `ENV_PROD`
2. Создаются на сервере через SSH перед деплоем
3. Используются Docker контейнером для работы приложения

## Приоритет загрузки

NestJS ConfigModule загружает переменные в следующем порядке (последний побеждает):

1. `.env` (если существует)
2. `.env.test` (только для тестов через setup-e2e.ts)
3. Переменные окружения процесса (`process.env`)
4. В GitHub Actions: `env:` из workflow

## Best Practices

### ✅ DO:

- Коммитьте `.env.test` с тестовыми credentials
- Используйте `.env.example` как шаблон для `.env`
- Используйте `.env.prod.template` как шаблон для `.env.prod`
- Храните production секреты в GitHub Secrets
- Используйте `.env.test.local` для локальных переопределений тестов

### ❌ DON'T:

- НЕ коммитьте `.env` (локальные настройки могут различаться)
- НЕ коммитьте `.env.prod` (**НИКОГДА!**)
- НЕ используйте production credentials локально
- НЕ храните реальные API ключи в коммитах

## Отладка

### Проверка загруженных переменных:

```typescript
console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('NODE_ENV:', process.env.NODE_ENV);
```

### Проверка какой файл загружен:

```bash
# В приложении
yarn start:dev

# В тестах
yarn test:e2e

# Какие переменные видит процесс
env | grep DATABASE_URL
```

## Миграция существующих проектов

Если у вас уже есть `.env.test` в `.gitignore`:

```bash
# 1. Удалите из .gitignore
git rm --cached .env.test

# 2. Убедитесь что там нет секретов
cat .env.test

# 3. Добавьте в Git
git add .env.test
git commit -m "feat: track .env.test for CI/CD compatibility"
```
