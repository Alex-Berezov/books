# Быстрая инструкция: Применение настроек api.bibliaris.com

> **Дата:** 18.10.2025  
> **Цель:** Настроить api.bibliaris.com на production сервере

---

## 🎯 Что будет сделано

1. ✅ Настройка DNS записи api.bibliaris.com → 209.74.88.183
2. ✅ Обновление Caddy конфигурации (разделение api.bibliaris.com и bibliaris.com)
3. ✅ Обновление .env.prod с новыми URL
4. ✅ Перезапуск приложения
5. ✅ Проверка всех endpoints

---

## 📋 Пошаговый процесс

### Шаг 1: Настройка DNS в Namecheap (5 минут)

**Важно:** Это нужно сделать вручную через веб-интерфейс!

1. Откройте [Namecheap Advanced DNS](https://ap.www.namecheap.com/)
2. Выберите домен `bibliaris.com`
3. Добавьте новую A-запись:
   ```
   Type: A Record
   Host: api
   Value: 209.74.88.183
   TTL: Automatic
   ```
4. Сохраните изменения
5. Подождите 1-5 минут для распространения DNS

**Проверка (локально на вашем компьютере):**

```bash
dig api.bibliaris.com +short
# Должно вернуть: 209.74.88.183
```

---

### Шаг 2: Применение настроек на сервере (10 минут)

Я создал автоматизированный скрипт, который выполнит все необходимые действия.

#### Вариант A: Автоматическое применение (рекомендуется)

```bash
# 1. Скопируйте скрипт на сервер
scp scripts/apply-api-subdomain.sh deploy@209.74.88.183:~/

# 2. Подключитесь к серверу
ssh deploy@209.74.88.183

# 3. Сначала запустите в dry-run режиме (проверка без изменений)
bash apply-api-subdomain.sh --dry-run

# 4. Если всё выглядит правильно, примените настройки
bash apply-api-subdomain.sh

# 5. Выйдите с сервера
exit
```

#### Вариант Б: Ручное применение

Если предпочитаете делать вручную, следуйте инструкциям в:

- `docs/API_SUBDOMAIN_SETUP.md` (полная версия)

---

### Шаг 3: Проверка результата (5 минут)

После применения настроек проверьте все endpoints:

```bash
# С вашего локального компьютера:

# 1. Health Check
curl https://api.bibliaris.com/api/health/liveness

# 2. Database Check
curl https://api.bibliaris.com/api/health/readiness

# 3. Swagger UI (откройте в браузере)
https://api.bibliaris.com/docs

# 4. Metrics
curl https://api.bibliaris.com/metrics | head -n 20

# 5. CORS headers
curl -I https://api.bibliaris.com/api/health/liveness \
  -H "Origin: https://bibliaris.com"
# Должен содержать: access-control-allow-origin: https://bibliaris.com

# 6. Основной домен (должен редиректить)
curl -I https://bibliaris.com
# Должен вернуть 301 и Location: https://api.bibliaris.com/docs
```

**Все проверки должны вернуть HTTP 200 (или 301 для редиректа).**

---

### Шаг 4: Обновление GitHub Secret ENV_PROD (5 минут)

После успешной настройки обновите GitHub Secret для CI/CD:

1. Откройте [GitHub Secrets](https://github.com/Alex-Berezov/books/settings/secrets/actions)
2. Найдите секрет `ENV_PROD`
3. Нажмите "Update"
4. Обновите следующие строки в содержимом:
   ```bash
   LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com
   CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001
   ```
5. Сохраните изменения

---

## ✅ Критерии успеха

После выполнения всех шагов:

- ✅ DNS `api.bibliaris.com` резолвится в `209.74.88.183`
- ✅ `https://api.bibliaris.com/api/health/liveness` возвращает `{"status":"up"}`
- ✅ `https://api.bibliaris.com/api/health/readiness` возвращает детальную информацию
- ✅ `https://api.bibliaris.com/docs` открывает Swagger UI
- ✅ `https://api.bibliaris.com/metrics` возвращает метрики Prometheus
- ✅ SSL сертификат автоматически выпущен Let's Encrypt для api.bibliaris.com
- ✅ CORS headers присутствуют для `https://bibliaris.com`
- ✅ `https://bibliaris.com` редиректит на `https://api.bibliaris.com/docs`
- ✅ Docker контейнер в статусе `healthy`
- ✅ GitHub Secret ENV_PROD обновлен

---

## 🐛 Troubleshooting

### DNS не резолвится

**Проблема:** `dig api.bibliaris.com` не возвращает IP

**Решение:**

1. Проверьте настройки в Namecheap (Host должен быть `api`, не `api.bibliaris.com`)
2. Подождите 5-10 минут для распространения DNS
3. Очистите DNS кэш локально: `sudo systemd-resolve --flush-caches`

### SSL сертификат не выпускается

**Проблема:** `curl https://api.bibliaris.com` возвращает SSL ошибку

**Решение:**

1. Проверьте логи Caddy: `sudo journalctl -u caddy -n 100`
2. Убедитесь, что DNS корректно настроен
3. Проверьте, что порты 80 и 443 открыты: `sudo ufw status`
4. Caddy автоматически запросит сертификат при первом обращении

### CORS headers не работают

**Проблема:** Фронтенд не может делать запросы к API

**Решение:**

1. Проверьте, что `.env.prod` содержит правильный `CORS_ORIGIN`
2. Перезапустите приложение: `docker compose -f docker-compose.prod.yml restart app`
3. Проверьте заголовки: `curl -I https://api.bibliaris.com/api/health/liveness -H "Origin: https://bibliaris.com"`

### Контейнер не healthy

**Проблема:** `docker compose ps` показывает статус `unhealthy`

**Решение:**

1. Проверьте логи: `docker compose -f docker-compose.prod.yml logs app`
2. Проверьте, что БД доступна: `docker compose -f docker-compose.prod.yml ps postgres`
3. Проверьте healthcheck вручную внутри контейнера

---

## 📞 Поддержка

Если возникли проблемы:

1. Проверьте логи:
   - Caddy: `sudo journalctl -u caddy -n 100`
   - App: `docker compose -f docker-compose.prod.yml logs --tail=100 app`
2. См. [TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md) для других проблем
3. Проверьте статус всех сервисов: `docker compose -f docker-compose.prod.yml ps`

---

## 🎉 Следующие шаги

После успешной настройки api.bibliaris.com:

1. ✅ **Backend готов** - API полностью функционален на api.bibliaris.com
2. 🚀 **Создать Frontend** - начать разработку Next.js приложения
3. 📊 **Сгенерировать типы** - `yarn openapi:types:prod` для TypeScript типов
4. 🌐 **Задеплоить Frontend** - настроить bibliaris.com для фронтенда

**Проект готов к полноценной разработке фронтенда!**
