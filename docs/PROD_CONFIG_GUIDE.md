# Продакшн конфигурация - Быстрый старт

## Файлы для продакшена

### `.env.prod` - Переменные окружения продакшена

- ✅ Создан и настроен с безопасными параметрами
- 🔒 Права доступа: 600 (только владелец может читать)
- 🔑 JWT секреты: обновлены, 44+ символов
- 🗄️ База данных: пользователь `books_app` с сильным паролем

### `docker-compose.prod.yml` - Docker Compose для продакшена

- ✅ Использует `.env.prod` файл
- 🩺 Healthcheck: `/api/metrics` (исправлен)
- 🐳 Profile: `prod` для продакшен сервисов

## Проверка конфигурации

### Автоматическая проверка:

```bash
node check_prod_config.js
```

### Ручная проверка ключевых параметров:

```bash
grep -E "(NODE_ENV|SWAGGER_ENABLED|RATE_LIMIT|TRUST_PROXY)" .env.prod
```

## Развертывание

### На продакшн сервере:

```bash
# 1. Скопировать .env.prod на сервер
scp .env.prod deploy@server:/opt/books/app/src/.env.prod

# 2. Установить правильные права
chmod 600 /opt/books/app/src/.env.prod

# 3. Запустить контейнеры
docker compose -f docker-compose.prod.yml up -d
```

### Проверка работы:

```bash
# Проверить статус контейнеров
docker compose -f docker-compose.prod.yml ps

# Проверить что API отвечает
curl -I http://localhost:5000/api/health/liveness

# Проверить что Swagger отключен (должен быть 404)
curl -I http://localhost:5000/api

# Проверить логи
docker compose -f docker-compose.prod.yml logs -f app | head -20
```

## Безопасность

### ✅ Включено в продакшене:

- Swagger отключен (`SWAGGER_ENABLED=0`)
- Rate limiting включен (`RATE_LIMIT_GLOBAL_ENABLED=1`)
- Proxy trust включен (`TRUST_PROXY=1`)
- Безопасные JWT секреты (44+ символов)
- CORS ограничен доменом фронтенда

### ⚠️ TODO после получения доменов:

- Обновить `CORS_ORIGIN` на реальный домен фронтенда
- Обновить `LOCAL_PUBLIC_BASE_URL` на реальный API домен
- Настроить реальные email для `ADMIN_EMAILS`

## Следующий этап

🚀 **Пункт 7: Reverse Proxy / TLS**

- План: `docs/NEXT_STEPS_REVERSE_PROXY.md`
- Настройка Caddy + автоматический HTTPS
- Проксирование `api.example.com` → контейнер
