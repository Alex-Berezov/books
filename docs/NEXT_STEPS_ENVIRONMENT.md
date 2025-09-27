# Deployment Plan: Environment Variables Setup (Пункт 6 DEPLOYMENT.md)

## Текущий статус (27.09.2025)

### ✅ Что ЗАВЕРШЕНО:

- Пункт 1: Домены и DNS (будем настраивать позже)
- Пункт 2: VPS/Сервер (настроен, пользователь deploy, Docker работает)
- Пункт 3: Контейнеры и Артефакты (✅ ГОТОВО - контейнеры работают)

### 🎯 ТЕКУЩАЯ ЗАДАЧА: Пункт 6 - Переменные окружения

## Цель:

Настроить правильные переменные окружения для продакшена согласно пункту 6 DEPLOYMENT.md

## План выполнения:

### Шаг 1: Проверить текущие переменные на сервере

```bash
# На сервере посмотреть что сейчас в .env
deploy@server1:/opt/books/app/src$ cat .env
```

### Шаг 2: Создать .env.prod с правильными настройками

Создать файл `/opt/books/app/src/.env.prod` на основе примера из DEPLOYMENT.md:

```bash
# Обязательные для продакшена
DATABASE_URL=postgresql://app_user:STRONG_PASS@postgres:5432/books_app?schema=public
PORT=5000
HOST=0.0.0.0
NODE_ENV=production

# Язык и локализация
DEFAULT_LANGUAGE=en

# URL для статических файлов (будет настроено после reverse proxy)
LOCAL_PUBLIC_BASE_URL=https://api.example.com/static

# CORS (будет настроено после получения домена фронтенда)
CORS_ORIGIN=https://frontend.example.com

# Безопасность - ВАЖНО для продакшена
SWAGGER_ENABLED=0
RATE_LIMIT_GLOBAL_ENABLED=1
TRUST_PROXY=1

# Пользователи с правами админа/редактора
ADMIN_EMAILS=admin@example.com
CONTENT_MANAGER_EMAILS=editor@example.com

# JWT секрет (сгенерировать новый!)
JWT_SECRET=<SECURE_RANDOM_STRING>

# Опционально Redis/BullMQ (пока закомментировать)
# REDIS_HOST=redis
# REDIS_PORT=6379
# BULLMQ_IN_PROCESS_WORKER=0
```

### Шаг 3: Обновить docker-compose.prod.yml

Убедиться что используется правильный .env файл:

```yaml
services:
  app:
    env_file:
      - .env.prod # вместо .env
```

### Шаг 4: Генерация безопасных секретов

```bash
# Сгенерировать JWT секрет
openssl rand -base64 32

# Сгенерировать пароль для БД (если нужно)
openssl rand -base64 20
```

### Шаг 5: Проверить критические настройки

Убедиться что установлены:

- [ ] `NODE_ENV=production`
- [ ] `SWAGGER_ENABLED=0` (отключить Swagger в проде)
- [ ] `RATE_LIMIT_GLOBAL_ENABLED=1` (включить rate limiting)
- [ ] `TRUST_PROXY=1` (для работы за reverse proxy)
- [ ] Правильный `DATABASE_URL`
- [ ] Безопасный `JWT_SECRET`

### Шаг 6: Обновить права доступа к файлу

```bash
# Ограничить доступ к .env файлу
chmod 600 /opt/books/app/src/.env.prod
chown deploy:deploy /opt/books/app/src/.env.prod
```

### Шаг 7: Перезапустить контейнеры с новыми переменными

```bash
cd /opt/books/app/src
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

### Шаг 8: Проверить что все работает

```bash
# Проверить статус контейнеров
docker compose -f docker-compose.prod.yml ps

# Проверить что API отвечает
curl -I http://localhost:5000/api/health/liveness

# Проверить что Swagger отключен (должен быть 404)
curl -I http://localhost:5000/api

# Проверить логи приложения
docker compose -f docker-compose.prod.yml logs -f app | head -20
```

## Важные моменты:

### 🔒 Безопасность:

- **JWT_SECRET** должен быть уникальным и длинным (32+ символа)
- **DATABASE_URL** не должен использовать дефолтные пароли
- **.env.prod** должен иметь права 600 (только владелец может читать)
- **Swagger отключен** в продакшене

### 🌐 Домены (временные значения):

- `api.example.com` - заменить на реальный домен API
- `frontend.example.com` - заменить на реальный домен фронтенда
- Пока можно оставить example.com, обновим когда будут реальные домены

### 📋 Что проверить после применения:

- [ ] Приложение запускается без ошибок
- [ ] Swagger недоступен (404 на /api)
- [ ] Rate limiting работает
- [ ] База данных доступна
- [ ] Логи не содержат ошибок конфигурации

## После завершения этого этапа:

Переходим к **Пункту 7: Reverse Proxy / TLS** (план уже есть в NEXT_STEPS_REVERSE_PROXY.md)

## Возможные проблемы:

1. **Контейнер не запускается** - проверить синтаксис .env.prod
2. **База недоступна** - проверить DATABASE_URL
3. **JWT ошибки** - убедиться что JWT_SECRET установлен
4. **CORS ошибки** - пока не критично, исправим когда будет фронтенд

---

Создан: 2025-09-27  
Статус: Готов к выполнению  
Следует после: Пункт 3 (Контейнеры) ✅  
Перед: Пункт 7 (Reverse Proxy)
