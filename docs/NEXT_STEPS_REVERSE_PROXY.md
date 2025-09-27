# Deployment Plan: Reverse Proxy Setup (Пункт 7 DEPLOYMENT.md)

## Текущий статус (27.09.2025)

### ✅ Что ДОЛЖНО БЫТЬ ЗАВЕРШЕНО ПЕРЕД ЭТИМ ЭТАПОМ:

1. **Пункт 3 - Контейнеры и Артефакты (✅ ЗАВЕРШЕНО):**
   - NestJS приложение запущено на порту 5000
   - PostgreSQL запущен и healthy
   - Миграции Prisma применены (23 migrations)
   - Entrypoint скрипт исправлен и работает корректно

2. **Пункт 6 - Переменные окружения (📋 ДОЛЖНО БЫТЬ СДЕЛАНО СНАЧАЛА!):**
   - .env.prod настроен с правильными значениями
   - SWAGGER_ENABLED=0, RATE_LIMIT_GLOBAL_ENABLED=1, TRUST_PROXY=1
   - Безопасные JWT_SECRET и DATABASE_URL
   - См. план в NEXT_STEPS_ENVIRONMENT.md

3. **Исправленные проблемы:**
   - **TypeScript конфигурация**: Добавлен `rootDir: "./src"` в tsconfig.json
   - **NestJS сборка**: Используется `nest build --webpack` для генерации dist/main.js
   - **ESLint конфигурация**: Создан tsconfig.eslint.json для работы с тестами
   - **Docker entrypoint**: Упрощен для поиска dist/main.js по стандартному пути

4. **Сервер готов:**
   - Локация: `/opt/books/app/src`
   - Пользователь: `deploy`
   - Git репозиторий обновлен до последней версии
   - Docker Compose запущен с prod конфигурацией

### 🔧 Текущие известные мелкие проблемы:

1. Healthcheck показывает unhealthy (ищет `/metrics`, получает 404)
2. Endpoint должен быть `/api/metrics` вместо `/metrics`

## Следующий этап: Reverse Proxy + HTTPS (Пункт 7 из DEPLOYMENT.md)

### Цель:

Настроить Caddy reverse proxy для:

1. Автоматического HTTPS через Let's Encrypt
2. Проксирования `api.example.com` → контейнер на порту 5000
3. Базовой безопасности и rate limiting

### План выполнения:

#### Шаг 1: Подготовка домена

- [ ] Настроить DNS A-запись `api.example.com` → IP сервера
- [ ] Проверить доступность домена: `dig +short api.example.com`
- [ ] Убедиться что порты 80/443 открыты в UFW

#### Шаг 2: Установка Caddy

```bash
# Установить Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# Проверить статус
sudo systemctl status caddy
```

#### Шаг 3: Конфигурация Caddy

Создать `/etc/caddy/Caddyfile`:

```caddy
api.example.com {
    reverse_proxy localhost:5000

    # Базовые заголовки безопасности (дублируют то что есть в NestJS, но для надежности)
    header {
        # Remove server info
        -Server

        # Security headers
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        X-XSS-Protection "1; mode=block"
        Referrer-Policy strict-origin-when-cross-origin

        # CORS (если нужно, но лучше оставить на уровне приложения)
        # Access-Control-Allow-Origin https://frontend.example.com
    }

    # Rate limiting (базовый)
    rate_limit {
        zone dynamic_rl {
            key {remote_host}
            events 100
            window 1m
        }
    }

    # Логирование
    log {
        output file /var/log/caddy/api.log {
            roll_size 100mb
            roll_keep 5
            roll_keep_for 720h
        }
        format json
    }

    # Специальная обработка для metrics endpoint (ограничить доступ)
    @metrics path /api/metrics
    respond @metrics "Metrics endpoint disabled" 403
}

# Перенаправление с www
www.api.example.com {
    redir https://api.example.com{uri}
}
```

#### Шаг 4: Настройка файрвола

```bash
# Открыть порты для HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Проверить правила
sudo ufw status
```

#### Шаг 5: Запуск и тестирование

```bash
# Проверить конфигурацию
sudo caddy validate --config /etc/caddy/Caddyfile

# Запустить Caddy
sudo systemctl enable caddy
sudo systemctl start caddy

# Проверить статус
sudo systemctl status caddy

# Проверить логи
sudo journalctl -u caddy -f
```

#### Шаг 6: Тестирование

```bash
# Проверить что домен отвечает
curl -I https://api.example.com/api/health/liveness

# Проверить что HTTPS работает
curl -I https://api.example.com

# Проверить что metrics заблокированы
curl -I https://api.example.com/api/metrics

# Проверить автоматическое перенаправление HTTP → HTTPS
curl -I http://api.example.com
```

#### Шаг 7: Обновление docker-compose.prod.yml

- [ ] Убрать публичный порт 5000 (оставить только внутренний)
- [ ] Исправить healthcheck на правильный путь `/api/metrics`
- [ ] Добавить переменные окружения для TRUST_PROXY

#### Шаг 8: Обновление переменных окружения

Обновить `.env` на сервере:

```bash
# Добавить/обновить
TRUST_PROXY=1
CORS_ORIGIN=https://frontend.example.com  # заменить на реальный домен фронта
LOCAL_PUBLIC_BASE_URL=https://api.example.com/static
SWAGGER_ENABLED=0
```

### Файлы для изменения:

1. `/etc/caddy/Caddyfile` - конфигурация Caddy
2. `docker-compose.prod.yml` - убрать публичный порт
3. `.env` - обновить переменные окружения

### Ожидаемый результат:

- `https://api.example.com/api/health/liveness` → 200 OK
- `https://api.example.com/api/metrics` → 403 Forbidden (заблокировано)
- Автоматический HTTPS сертификат от Let's Encrypt
- Приложение доступно только через домен, не через IP:5000

### Возможные проблемы и решения:

1. **DNS не работает**: Проверить A-запись, подождать распространения
2. **Let's Encrypt ошибки**: Проверить что домен доступен извне, порты 80/443 открыты
3. **502 Bad Gateway**: Проверить что контейнер работает на localhost:5000
4. **CORS ошибки**: Настроить CORS_ORIGIN в приложении

### Следующие этапы после Reverse Proxy:

1. Настройка мониторинга (пункт 11 DEPLOYMENT.md)
2. Настройка автоматических бэкапов (пункт 18)
3. Создание админ пользователя
4. Интеграция с фронтендом (пункт 20)
5. Оптимизация Docker образа

### Критические замечания:

- Обязательно заменить `api.example.com` на реальный домен
- Настроить `CORS_ORIGIN` под реальный домен фронтенда
- Проверить что `/api/metrics` действительно существует в приложении
- Убедиться что порты 80/443 открыты в облачном провайдере (не только UFW)

---

Файл создан: 2025-09-27, статус контейнеров проверен, готовы к следующему этапу.
