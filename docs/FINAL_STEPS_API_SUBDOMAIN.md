# Финальные шаги настройки api.bibliaris.com

> **Дата:** 18.10.2025  
> **Статус:** Осталось 3 команды с sudo

---

## ✅ Что уже сделано

- ✅ DNS настроен: api.bibliaris.com → 209.74.88.183
- ✅ .env.prod обновлён:
  - LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com
  - CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001
- ✅ Приложение перезапущено (контейнер healthy)
- ✅ API работает через bibliaris.com
- ✅ Новый Caddyfile скопирован на сервер (~/Caddyfile.new)

---

## 🔧 Что нужно выполнить (3 команды, 2 минуты)

Подключитесь к серверу и выполните:

```bash
ssh deploy@209.74.88.183
```

### Команда 1: Создать backup текущего Caddyfile

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.backup.$(date +%Y%m%d_%H%M%S)
```

### Команда 2: Применить новую конфигурацию Caddy

```bash
sudo cp ~/Caddyfile.new /etc/caddy/Caddyfile
```

### Команда 3: Проверить синтаксис и перезапустить

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

### Команда 4: Проверить статус

```bash
sudo systemctl status caddy
```

Если всё OK (должно быть `active (running)`), выходите:

```bash
exit
```

---

## ✅ Проверка результата

После выполнения команд выше, проверьте локально:

```bash
# 1. Health Check через новый домен
curl https://api.bibliaris.com/api/health/liveness

# 2. Swagger UI (откройте в браузере)
https://api.bibliaris.com/docs

# 3. Metrics
curl https://api.bibliaris.com/metrics | head -n 20

# 4. CORS headers
curl -I https://api.bibliaris.com/api/health/liveness -H "Origin: https://bibliaris.com"

# 5. Редирект с основного домена
curl -I https://bibliaris.com
# Должен вернуть 307 и Location: https://api.bibliaris.com/docs
```

---

## 🎯 После успешной проверки

### Обновите GitHub Secret ENV_PROD

1. Откройте: https://github.com/Alex-Berezov/books/settings/secrets/actions
2. Найдите секрет `ENV_PROD`
3. Нажмите "Update"
4. Найдите и обновите строки:
   ```bash
   LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com
   CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001
   ```
5. Сохраните

---

## 🐛 Troubleshooting

### Если Caddy не перезагружается:

```bash
# Проверить логи
sudo journalctl -u caddy -n 50

# Проверить синтаксис конфигурации
sudo caddy validate --config /etc/caddy/Caddyfile

# Если ошибка, откатить на backup
sudo cp /etc/caddy/Caddyfile.backup.XXXXXXXX /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### Если SSL не выпускается:

- Подождите 1-2 минуты - Let's Encrypt может занять время
- Проверьте логи: `sudo journalctl -u caddy -f`
- Убедитесь что DNS корректно резолвится: `dig api.bibliaris.com +short`

---

## 🎉 Результат

После выполнения всех шагов:

- ✅ `https://api.bibliaris.com` - работает полностью
- ✅ `https://bibliaris.com` - редиректит на API docs
- ✅ SSL сертификат автоматически выпущен
- ✅ CORS настроен для фронтенда
- ✅ Backend полностью готов к интеграции с фронтендом!

**Следующий шаг:** Создание Frontend приложения на Next.js 🚀
