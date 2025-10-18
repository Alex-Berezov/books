## Исправление: Deploy падает с ".env.prod не найден"

### Проблема

Deploy падал на стадии "Deploy to Production" с ошибкой:

```
❌ .env.prod не найден в /opt/books/app/src
Error: Process completed with exit code 1
```

### Причина

`.env.prod` находится в `.gitignore` (содержит production секреты) и не хранится в Git.
При деплое код обновлялся через `git reset --hard origin/main`, но `.env.prod` не создавался автоматически.

### Решение

Добавлен шаг создания `.env.prod` из GitHub Secret в deploy workflow:

```yaml
# Создание .env.prod из секретов
echo "📝 Creating .env.prod from secrets..."
cat > .env.prod << 'ENVEOF'
${{ secrets.ENV_PROD }}
ENVEOF
chmod 600 .env.prod
echo "✅ .env.prod created successfully"
```

### Изменённые файлы

- `.github/workflows/deploy.yml` - добавлен шаг создания `.env.prod`
- `docs/TROUBLESHOOTING.md` - добавлена секция "Deploy падает: .env.prod не найден"
- `docs/GITHUB_SECRETS_SETUP.md` - полное руководство по настройке секретов (НОВЫЙ)
- `QUICK_FIX_ENV_PROD.md` - краткая инструкция для быстрого исправления (НОВЫЙ)
- `CHANGELOG.md` - добавлена запись об исправлении

### Как использовать

1. Создайте `.env.prod` локально из `.env.prod.template`
2. Добавьте содержимое в GitHub Secrets как `ENV_PROD`
3. Push в main - workflow автоматически создаст файл на сервере

### Безопасность

- ✅ Секреты не хранятся в Git
- ✅ Зашифрованы в GitHub Secrets
- ✅ Файл на сервере с правами 600 (только владелец)

### Документация

- Подробная инструкция: `docs/GITHUB_SECRETS_SETUP.md`
- Быстрое исправление: `QUICK_FIX_ENV_PROD.md`
- Troubleshooting: `docs/TROUBLESHOOTING.md`
