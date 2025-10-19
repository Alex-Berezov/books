# Как открыть Swagger на Production

## ⚠️ Важно

Swagger **отключен по умолчанию** на production по соображениям безопасности:

- Не раскрывает структуру API публично
- Уменьшает поверхность атаки
- Снижает нагрузку (не генерируется документация при старте)

**📖 Подробнее о рисках:** [SWAGGER_SECURITY_RISKS.md](SWAGGER_SECURITY_RISKS.md)

## 🚀 Быстрый способ (с помощью скрипта)

```bash
# SSH на сервер
ssh deploy@bibliaris.com

# Включить Swagger
./scripts/toggle_swagger.sh enable

# Проверить статус
./scripts/toggle_swagger.sh status

# Отключить обратно (ОБЯЗАТЕЛЬНО после использования!)
./scripts/toggle_swagger.sh disable
```

После включения Swagger доступен по адресу:

- **Swagger UI**: https://bibliaris.com/docs
- **OpenAPI JSON**: https://bibliaris.com/docs-json

## Способы включения Swagger на Production

### 1. Временное включение (рекомендуется)

Если нужно временно открыть Swagger для отладки или генерации схемы:

#### На сервере:

```bash
# 1. SSH на сервер
ssh deploy@bibliaris.com

# 2. Перейдите в директорию приложения
cd /opt/books/app/src

# 3. Отредактируйте .env.prod
nano .env.prod

# 4. Измените SWAGGER_ENABLED на 1
SWAGGER_ENABLED=1

# 5. Перезапустите приложение
docker compose --profile prod -f docker-compose.prod.yml restart app

# 6. Проверьте логи
docker compose --profile prod -f docker-compose.prod.yml logs -f app

# 7. Swagger доступен по адресу:
# https://bibliaris.com/docs
# https://bibliaris.com/docs-json
```

#### ⚠️ НЕ ЗАБУДЬТЕ ОТКЛЮЧИТЬ ОБРАТНО:

```bash
# После использования
nano .env.prod
# Верните SWAGGER_ENABLED=0

docker compose --profile prod -f docker-compose.prod.yml restart app
```

### 2. Через GitHub Secret (для постоянного включения)

Если нужно включить Swagger постоянно (не рекомендуется):

1. Откройте GitHub репозиторий → Settings → Secrets → Actions
2. Найдите secret `ENV_PROD`
3. Нажмите "Update"
4. В содержимом найдите строку `SWAGGER_ENABLED=0`
5. Измените на `SWAGGER_ENABLED=1`
6. Сохраните
7. Выполните редеплой:

```bash
# Локально
git tag v1.0.x
git push origin v1.0.x

# Или manual workflow
# GitHub → Actions → Production Deployment → Run workflow
```

### 3. Защищенный доступ к Swagger (рекомендуется для постоянного использования)

Если нужен постоянный доступ к Swagger, защитите его:

#### Вариант A: Basic Auth через Caddy

Отредактируйте `configs/Caddyfile.prod`:

```caddy
bibliaris.com {
    # Основные маршруты
    reverse_proxy localhost:5000

    # Защищенный доступ к Swagger
    handle /docs* {
        basicauth {
            admin $2a$14$Xg.ZZf0... # создайте bcrypt хеш пароля
        }
        reverse_proxy localhost:5000
    }
}
```

Создание bcrypt хеша:

```bash
caddy hash-password
# Введите пароль, скопируйте хеш
```

#### Вариант B: IP Whitelist через Caddy

```caddy
bibliaris.com {
    # Ограничить доступ к /docs только с определенных IP
    @docs_restricted {
        path /docs*
        not remote_ip 1.2.3.4 5.6.7.8  # Ваши IP
    }

    respond @docs_restricted "Access Denied" 403

    reverse_proxy localhost:5000
}
```

#### Вариант C: Отдельный поддомен для админ-панели

```caddy
# Публичный API
bibliaris.com {
    reverse_proxy localhost:5000
}

# Админ-доступ (защищенный)
admin.bibliaris.com {
    basicauth {
        admin $2a$14$...
    }
    reverse_proxy localhost:5000
}
```

Установите:

```bash
SWAGGER_ENABLED=1
```

И в `src/main.ts` добавьте сервер:

```typescript
.addServer('https://admin.bibliaris.com', 'Admin')
```

### 4. Локальная генерация OpenAPI схемы (без production доступа)

Если нужна только схема для фронтенда:

```bash
# Локально в dev режиме
yarn start:dev

# В другом терминале
curl http://localhost:5000/api/docs-json > openapi.json

# Или используйте yarn скрипт
yarn openapi:types
```

## URL-адреса Swagger на Production

После включения `SWAGGER_ENABLED=1`:

- **Swagger UI**: https://bibliaris.com/docs
- **OpenAPI JSON**: https://bibliaris.com/docs-json

⚠️ **Примечание**: Глобальный префис `/api` не применяется к `/docs` и `/docs-json` - они доступны напрямую.

## Best Practices

### ✅ DO:

- Включайте Swagger временно для отладки
- Используйте Basic Auth или IP whitelist если нужен постоянный доступ
- Генерируйте схему локально для фронтенда
- Отключайте после использования

### ❌ DON'T:

- Не оставляйте Swagger открытым без аутентификации
- Не используйте production для генерации схемы (делайте локально)
- Не забывайте выключить после отладки

## Troubleshooting

### Swagger не открывается после включения SWAGGER_ENABLED=1

```bash
# Проверьте логи приложения
docker compose --profile prod -f docker-compose.prod.yml logs app | grep -i swagger

# Должно быть:
# Swagger setup: isProd=true, SWAGGER_ENABLED=1, swaggerEnabled=true
# Setting up Swagger documentation...
```

### 404 на /docs

Проверьте что контейнер перезапустился:

```bash
docker compose --profile prod -f docker-compose.prod.yml ps
docker compose --profile prod -f docker-compose.prod.yml restart app
```

### Swagger показывает старую схему

Очистите кеш браузера или откройте в режиме инкогнито.
