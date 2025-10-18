# Настройка GitHub Secrets для Production Deployment

Это руководство описывает, как настроить необходимые секреты в GitHub для автоматического деплоя в production.

## Обязательные секреты

### 1. `ENV_PROD` - Production Environment Variables

Содержит все переменные окружения для production сервера.

#### Создание ENV_PROD

1. **Создайте `.env.prod` локально**:

   ```bash
   cp .env.prod.template .env.prod
   ```

2. **Отредактируйте критичные переменные**:

   ```bash
   vim .env.prod  # или используйте свой редактор
   ```

   Обязательно обновите:
   - **DATABASE_URL** - строка подключения к PostgreSQL:
     ```
     postgresql://books_app:YOUR_STRONG_PASSWORD@postgres:5432/books_app?schema=public
     ```
     ⚠️ **ВАЖНО**: Пароль НЕ должен содержать спецсимволы `/`, `=`, `@` (Prisma не может их парсить)
   - **JWT Secrets** - сгенерируйте сильные ключи:
     ```bash
     openssl rand -base64 32  # для JWT_ACCESS_SECRET
     openssl rand -base64 32  # для JWT_REFRESH_SECRET
     ```
   - **ADMIN_EMAILS** - реальные email адреса администраторов:
     ```
     ADMIN_EMAILS=admin@yourdomain.com,admin2@yourdomain.com
     ```
   - **LOCAL_PUBLIC_BASE_URL** - URL для статических файлов:
     ```
     LOCAL_PUBLIC_BASE_URL=https://api.yourdomain.com/static
     ```
   - **CORS_ORIGIN** - разрешённые frontend домены:
     ```
     CORS_ORIGIN=https://yourdomain.com,https://app.yourdomain.com
     ```

3. **Проверьте конфигурацию**:

   ```bash
   # Убедитесь, что все CHANGE_THIS заменены
   grep -i "CHANGE_THIS" .env.prod
   # Не должно быть результатов!

   # Проверьте формат DATABASE_URL
   grep "DATABASE_URL" .env.prod
   ```

4. **Скопируйте содержимое файла**:

   ```bash
   cat .env.prod
   # Выделите весь вывод и скопируйте в буфер обмена
   ```

5. **Добавьте в GitHub Secrets**:
   - Откройте: `https://github.com/Alex-Berezov/books/settings/secrets/actions`
   - Нажмите **"New repository secret"**
   - **Name**: `ENV_PROD`
   - **Secret**: вставьте **полное содержимое** файла `.env.prod`
   - Нажмите **"Add secret"**

6. **Удалите локальный файл** (опционально, для безопасности):
   ```bash
   shred -u .env.prod  # Linux
   # или просто удалите файл
   ```

### 2. `DEPLOY_SSH_KEY` - SSH ключ для деплоя

Приватный SSH ключ для подключения к production серверу.

#### Создание и настройка

1. **Сгенерируйте ED25519 SSH ключ**:

   ```bash
   ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/deploy_ed25519
   ```

   - Оставьте passphrase пустым (для автоматизации)

2. **Добавьте публичный ключ на production сервер**:

   ```bash
   # Скопируйте публичный ключ
   cat ~/.ssh/deploy_ed25519.pub

   # На production сервере (от имени deploy пользователя):
   ssh deploy@bibliaris.com
   mkdir -p ~/.ssh
   chmod 700 ~/.ssh
   echo "ПУБЛИЧНЫЙ_КЛЮЧ_СЮДА" >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```

3. **Проверьте подключение**:

   ```bash
   ssh -i ~/.ssh/deploy_ed25519 deploy@bibliaris.com "echo 'SSH OK'"
   ```

4. **Добавьте приватный ключ в GitHub Secrets**:

   ```bash
   # Скопируйте приватный ключ
   cat ~/.ssh/deploy_ed25519
   # Выделите весь вывод (включая BEGIN/END строки)
   ```

   - Откройте: `https://github.com/Alex-Berezov/books/settings/secrets/actions`
   - Нажмите **"New repository secret"**
   - **Name**: `DEPLOY_SSH_KEY`
   - **Secret**: вставьте **весь приватный ключ**
   - Нажмите **"Add secret"**

5. **Удалите локальный ключ** (опционально):
   ```bash
   shred -u ~/.ssh/deploy_ed25519
   ```

## Обязательные Variables

GitHub Variables (не секреты, но необходимы):

### 1. `PRODUCTION_SERVER`

Адрес production сервера:

```
bibliaris.com
```

### 2. `PRODUCTION_DOMAIN`

Домен production API:

```
bibliaris.com
```

#### Добавление Variables

1. Откройте: `https://github.com/Alex-Berezov/books/settings/variables/actions`
2. Нажмите **"New repository variable"**
3. Добавьте оба variable с соответствующими значениями

## Проверка настройки

### 1. Проверьте наличие всех секретов

В `https://github.com/Alex-Berezov/books/settings/secrets/actions` должны быть:

- ✅ `ENV_PROD`
- ✅ `DEPLOY_SSH_KEY`

### 2. Проверьте Variables

В `https://github.com/Alex-Berezov/books/settings/variables/actions` должны быть:

- ✅ `PRODUCTION_SERVER`
- ✅ `PRODUCTION_DOMAIN`

### 3. Запустите тестовый деплой

Через GitHub Actions:

1. Откройте: `https://github.com/Alex-Berezov/books/actions/workflows/deploy.yml`
2. Нажмите **"Run workflow"**
3. Выберите `main` branch
4. Нажмите **"Run workflow"**

Или просто сделайте push в `main`:

```bash
git push origin main
```

### 4. Проверьте логи

Если всё настроено правильно, в логах деплоя вы увидите:

```
📝 Creating .env.prod from secrets...
✅ .env.prod created successfully
🚀 Starting deployment...
✅ Deployment completed!
```

## Безопасность

### Что НЕ делать

- ❌ **НЕ коммитьте** `.env.prod` в Git
- ❌ **НЕ делитесь** содержимым GitHub Secrets
- ❌ **НЕ копируйте** секреты в незащищённые места (Slack, email, etc)
- ❌ **НЕ используйте** слабые пароли или ключи

### Best Practices

- ✅ Используйте **сильные пароли** (минимум 32 символа)
- ✅ Генерируйте **уникальные** JWT секреты для каждого окружения
- ✅ Регулярно **ротируйте** секреты (каждые 3-6 месяцев)
- ✅ Используйте **ED25519** вместо RSA для SSH ключей
- ✅ Храните **backup** секретов в безопасном месте (password manager)

### Ротация секретов

Если секреты скомпрометированы:

1. **Создайте новые** секреты (пароли, ключи)
2. **Обновите** на production сервере
3. **Обновите** в GitHub Secrets
4. **Выполните** деплой для применения
5. **Удалите** старые ключи из `authorized_keys`

## Troubleshooting

### Deploy падает с "Permission denied (publickey)"

- Проверьте, что `DEPLOY_SSH_KEY` содержит **весь** приватный ключ (включая `-----BEGIN/END-----`)
- Убедитесь, что публичный ключ добавлен в `~/.ssh/authorized_keys` на сервере
- Проверьте права: `~/.ssh` = 700, `authorized_keys` = 600

### Deploy падает с ".env.prod не найден"

- Убедитесь, что `ENV_PROD` секрет создан и содержит **полный** `.env.prod`
- Проверьте, что в workflow есть шаг создания `.env.prod`

### Приложение не запускается: "invalid port number in database URL"

- Проверьте `DATABASE_URL` в `ENV_PROD`
- Убедитесь, что пароль **НЕ содержит** `/`, `=`, `@`
- Пересоздайте пароль БД без спецсимволов

## Ссылки

- [GitHub Encrypted Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [GitHub Actions Variables](https://docs.github.com/en/actions/learn-github-actions/variables)
- [SSH Key Authentication](https://www.ssh.com/academy/ssh/key)
- `.env.prod.template` - шаблон конфигурации
- `docs/TROUBLESHOOTING.md` - решение распространённых проблем
