# Настройка API поддомена (api.bibliaris.com)

> **Дата создания:** 18.10.2025  
> **Статус:** 📋 ИНСТРУКЦИЯ - Требуется выполнение на сервере

---

## 🎯 Цель

Разделить API backend и Frontend приложение на разные домены:

- `api.bibliaris.com` → API backend (NestJS)
- `bibliaris.com` → Frontend приложение (будущее)

---

## 📋 Пошаговая инструкция

### Шаг 1: Настройка DNS в Namecheap (5 мин)

1. Войдите в [Namecheap Dashboard](https://ap.www.namecheap.com/)
2. Перейдите в управление доменом `bibliaris.com`
3. Откройте раздел **Advanced DNS**
4. Добавьте новую A-запись:

```
Type: A Record
Host: api
Value: 209.74.88.183
TTL: Automatic (или 1 min для быстрого тестирования)
```

5. Сохраните изменения
6. Дождитесь обновления DNS (обычно 1-5 минут)

**Проверка DNS:**

```bash
# Локально на вашем компьютере
dig api.bibliaris.com +short
# Должно вернуть: 209.74.88.183

# Или через nslookup
nslookup api.bibliaris.com
```

---

### Шаг 2: Обновление Caddy конфигурации на сервере (10 мин)

**Подключитесь к серверу:**

```bash
ssh deploy@209.74.88.183
```

**Создайте бэкап текущей конфигурации:**

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.backup.$(date +%Y%m%d_%H%M%S)
```

**Обновите файл `/etc/caddy/Caddyfile`:**

```bash
sudo nano /etc/caddy/Caddyfile
```

**Замените содержимое на:**

```caddyfile
# API Backend
api.bibliaris.com {
    reverse_proxy localhost:5000

    # Security headers
    header {
        # HSTS
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"

        # Prevent clickjacking
        X-Frame-Options "SAMEORIGIN"

        # Prevent MIME sniffing
        X-Content-Type-Options "nosniff"

        # XSS Protection
        X-XSS-Protection "1; mode=block"

        # Referrer Policy
        Referrer-Policy "strict-origin-when-cross-origin"

        # CORS (разрешаем фронтенд домены)
        Access-Control-Allow-Origin "https://bibliaris.com"
        Access-Control-Allow-Credentials "true"
        Access-Control-Allow-Methods "GET, POST, PUT, DELETE, PATCH, OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization, X-Admin-Language, Accept-Language"
    }

    # Логирование
    log {
        output file /var/log/caddy/api.bibliaris.com.access.log
        format json
    }
}

# Frontend (временно редирект на API, потом будет фронтенд)
bibliaris.com {
    # Временно: редирект на API docs
    redir https://api.bibliaris.com/docs permanent

    # В будущем здесь будет:
    # root * /var/www/bibliaris.com
    # file_server
    # try_files {path} /index.html
}

# Редирект с www на основной домен
www.bibliaris.com {
    redir https://bibliaris.com{uri} permanent
}

www.api.bibliaris.com {
    redir https://api.bibliaris.com{uri} permanent
}
```

**Сохраните файл:**

- Нажмите `Ctrl+O`, затем `Enter` для сохранения
- Нажмите `Ctrl+X` для выхода

**Проверьте синтаксис конфигурации:**

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

Должен вывести: `Valid configuration`

**Примените новую конфигурацию:**

```bash
sudo systemctl reload caddy
```

**Проверьте статус Caddy:**

```bash
sudo systemctl status caddy
```

**Следите за логами в реальном времени:**

```bash
sudo journalctl -u caddy -f
```

Вы должны увидеть:

- Caddy автоматически запрашивает Let's Encrypt SSL сертификат для `api.bibliaris.com`
- Сертификат успешно получен и установлен

---

### Шаг 3: Обновление .env.prod на сервере (5 мин)

**Откройте файл .env.prod:**

```bash
cd /opt/books/app/src
nano .env.prod
```

**Обновите следующие переменные:**

```bash
# API Base URL - ОБЯЗАТЕЛЬНО обновить!
LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com

# CORS Settings для production - ОБЯЗАТЕЛЬНО обновить!
CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001
CORS_CREDENTIALS=1

# Trust proxy (за Caddy) - должно быть включено
TRUST_PROXY=1
```

**ВАЖНО:** Убедитесь, что остальные переменные (DATABASE_URL, JWT_SECRET, и т.д.) остались без изменений!

**Сохраните файл:**

- Нажмите `Ctrl+O`, затем `Enter`
- Нажмите `Ctrl+X` для выхода

---

### Шаг 4: Перезапуск приложения (5 мин)

**Перезапустите Docker контейнер приложения:**

```bash
cd /opt/books/app/src
docker compose -f docker-compose.prod.yml restart app
```

**Проверьте статус контейнеров:**

```bash
docker compose -f docker-compose.prod.yml ps
```

Статус `app` должен быть `healthy` (может занять ~30 секунд).

**Следите за логами приложения:**

```bash
docker compose -f docker-compose.prod.yml logs -f app
```

Нажмите `Ctrl+C` для выхода из логов.

---

### Шаг 5: Тестирование (10 мин)

**5.1. Проверка Health Checks:**

```bash
# Liveness (должен вернуть 200 OK)
curl -I https://api.bibliaris.com/api/health/liveness

# Readiness (должен вернуть 200 OK с информацией о БД)
curl https://api.bibliaris.com/api/health/readiness
```

**5.2. Проверка Swagger UI:**

```bash
# Откройте в браузере
https://api.bibliaris.com/docs
```

Должен загрузиться Swagger UI с документацией API.

**5.3. Проверка SSL сертификата:**

```bash
# Проверка сертификата
curl -vI https://api.bibliaris.com/api/health/liveness 2>&1 | grep -A 10 "SSL certificate"
```

Должен показать валидный Let's Encrypt сертификат.

**5.4. Проверка CORS headers:**

```bash
curl -I https://api.bibliaris.com/api/health/liveness \
  -H "Origin: https://bibliaris.com"
```

В ответе должны быть заголовки:

```
access-control-allow-origin: https://bibliaris.com
access-control-allow-credentials: true
```

**5.5. Проверка метрик Prometheus:**

```bash
curl https://api.bibliaris.com/metrics | head -n 20
```

Должен вернуть метрики в формате Prometheus.

**5.6. Проверка основного домена:**

```bash
# Должен редиректить на api.bibliaris.com/docs
curl -I https://bibliaris.com
```

---

## ✅ Критерии успеха

После выполнения всех шагов должно работать:

- ✅ DNS `api.bibliaris.com` резолвится в `209.74.88.183`
- ✅ `https://api.bibliaris.com/api/health/liveness` возвращает `200 OK`
- ✅ `https://api.bibliaris.com/api/health/readiness` возвращает информацию о БД
- ✅ `https://api.bibliaris.com/docs` открывает Swagger UI
- ✅ `https://api.bibliaris.com/metrics` возвращает метрики
- ✅ SSL сертификат автоматически выпущен Let's Encrypt
- ✅ CORS headers присутствуют для `https://bibliaris.com`
- ✅ `https://bibliaris.com` редиректит на API docs (временно)
- ✅ Docker контейнер в статусе `healthy`

---

## 🔧 Откат изменений (при проблемах)

Если что-то пошло не так, можно быстро откатить изменения:

**1. Откатить Caddy конфигурацию:**

```bash
# Найти последний бэкап
ls -lah /etc/caddy/Caddyfile.backup.*

# Восстановить из бэкапа (замените timestamp)
sudo cp /etc/caddy/Caddyfile.backup.20251018_120000 /etc/caddy/Caddyfile

# Применить
sudo systemctl reload caddy
```

**2. Откатить .env.prod:**

```bash
cd /opt/books/app/src

# Если делали бэкап
cp .env.prod.backup .env.prod

# Или вручную изменить обратно:
# LOCAL_PUBLIC_BASE_URL=https://bibliaris.com
# CORS_ORIGIN=https://bibliaris.com,http://localhost:3000

# Перезапустить приложение
docker compose -f docker-compose.prod.yml restart app
```

---

## 📝 Следующие шаги

После успешной настройки `api.bibliaris.com`:

1. **Обновить GitHub Secret `ENV_PROD`** с новыми значениями `LOCAL_PUBLIC_BASE_URL` и `CORS_ORIGIN`
2. **Деплой через GitHub Actions** для проверки CI/CD с новой конфигурацией
3. **Подготовить фронтенд** - создать Next.js/React приложение
4. **Настроить деплой фронтенда** на `bibliaris.com`
5. **Обновить Caddy конфигурацию** для фронтенда (заменить редирект на `file_server`)

---

## 🐛 Troubleshooting

### Проблема: DNS не резолвится

**Симптомы:**

```bash
dig api.bibliaris.com +short
# Ничего не возвращает
```

**Решение:**

1. Проверьте настройки DNS в Namecheap
2. Убедитесь, что добавили A-запись с Host=`api`
3. Подождите 5-10 минут для распространения DNS
4. Попробуйте другой DNS сервер: `dig @8.8.8.8 api.bibliaris.com`

### Проблема: SSL сертификат не выпускается

**Симптомы:**

```bash
curl https://api.bibliaris.com
# SSL certificate problem
```

**Решение:**

1. Проверьте логи Caddy: `sudo journalctl -u caddy -f`
2. Убедитесь, что DNS резолвится корректно
3. Проверьте, что порты 80 и 443 открыты: `sudo ufw status`
4. Let's Encrypt требует, чтобы домен был доступен из интернета

### Проблема: CORS headers не работают

**Симптомы:**

```bash
curl -I https://api.bibliaris.com/api/health/liveness -H "Origin: https://bibliaris.com"
# Нет access-control-allow-origin
```

**Решение:**

1. Проверьте, что `.env.prod` содержит правильный `CORS_ORIGIN`
2. Перезапустите приложение: `docker compose -f docker-compose.prod.yml restart app`
3. Убедитесь, что приложение читает правильный `.env.prod`

### Проблема: Контейнер не healthy

**Симптомы:**

```bash
docker compose -f docker-compose.prod.yml ps
# app: unhealthy
```

**Решение:**

1. Проверьте логи: `docker compose -f docker-compose.prod.yml logs app`
2. Проверьте, что БД доступна: `docker compose -f docker-compose.prod.yml ps postgres`
3. Проверьте healthcheck вручную:
   ```bash
   docker compose -f docker-compose.prod.yml exec app node -e "require('http').get('http://localhost:5000/metrics', res => console.log(res.statusCode))"
   ```

---

## 📞 Поддержка

Если возникли вопросы или проблемы:

1. Проверьте логи:
   - Caddy: `sudo journalctl -u caddy -n 100`
   - App: `docker compose -f docker-compose.prod.yml logs --tail=100 app`
2. См. [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) для других проблем
3. Проверьте статус сервисов: `docker compose -f docker-compose.prod.yml ps`
