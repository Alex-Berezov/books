# 🚨 БЫСТРОЕ ИСПРАВЛЕНИЕ: Deploy падает с ".env.prod не найден"

## Что случилось?

Deploy падает с ошибкой:

```
❌ .env.prod не найден в /opt/books/app/src
```

## Почему?

`.env.prod` содержит production секреты и **не хранится в Git** (в `.gitignore`).
GitHub Actions должен создавать этот файл из секретов при каждом деплое.

## ✅ Решение (5 минут)

### Шаг 1: Создайте `.env.prod` локально

```bash
cd /home/aleber/Dev/books-app-back
cp .env.prod.template .env.prod
vim .env.prod  # Обновите критичные переменные
```

**Обязательно измените**:

- `DATABASE_URL` - реальный пароль БД (БЕЗ символов `/`, `=`, `@`)
- `JWT_ACCESS_SECRET` - сгенерируйте: `openssl rand -base64 32`
- `JWT_REFRESH_SECRET` - сгенерируйте: `openssl rand -base64 32`
- `ADMIN_EMAILS` - ваш email
- `LOCAL_PUBLIC_BASE_URL` - `https://bibliaris.com/static`
- `CORS_ORIGIN` - frontend домены

### Шаг 2: Добавьте в GitHub Secrets

```bash
# Скопируйте содержимое файла
cat .env.prod
```

1. Откройте: https://github.com/Alex-Berezov/books/settings/secrets/actions
2. Нажмите **"New repository secret"**
3. Name: `ENV_PROD`
4. Secret: **Вставьте весь вывод** из `cat .env.prod`
5. **"Add secret"**

### Шаг 3: Закоммитьте исправленный workflow

```bash
git add .github/workflows/deploy.yml
git add docs/TROUBLESHOOTING.md
git add docs/GITHUB_SECRETS_SETUP.md
git add CHANGELOG.md
git commit -m "fix: создание .env.prod из GitHub Secrets в deploy workflow"
git push origin main
```

### Шаг 4: Деплой запустится автоматически

GitHub Actions автоматически запустит деплой после push в `main`.

Проверьте логи: https://github.com/Alex-Berezov/books/actions

Должны увидеть:

```
📝 Creating .env.prod from secrets...
✅ .env.prod created successfully
🚀 Starting deployment...
```

## 📚 Полная документация

- **Подробная инструкция**: `docs/GITHUB_SECRETS_SETUP.md`
- **Troubleshooting**: `docs/TROUBLESHOOTING.md` (секция "Deploy падает: .env.prod не найден")
- **Шаблон конфигурации**: `.env.prod.template`

## ⚠️ ВАЖНО: Безопасность

- ❌ **НЕ коммитьте** `.env.prod` в Git (уже в `.gitignore`)
- ✅ После добавления в GitHub Secrets можно удалить локальный файл:
  ```bash
  rm .env.prod  # Опционально
  ```
