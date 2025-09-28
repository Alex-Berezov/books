# Итерация 6: Настройка доступа к домену bibliaris.com

> **Дата:** 2025-09-28  
> **Цель:** Обеспечить HTTPS доступ к приложению через домен bibliaris.com  
> **Текущий статус:** ГОТОВ К НАЧАЛУ

## 📋 Предварительные условия

✅ **Выполнено в Итерации 5:**

- Сервер диагностирован и работает стабильно
- Docker контейнер приложения исправлен и имеет статус `(healthy)`
- API полностью функциональный на `localhost:5000`
- База данных PostgreSQL работает корректно

## 🎯 Цели итерации

### Основная цель

Настроить полнофункциональный доступ к приложению через домен `bibliaris.com` с HTTPS

### Технические цели

1. **Reverse Proxy**: Установить и настроить Caddy
2. **DNS**: Перенастроить Namecheap для прямого доступа
3. **HTTPS**: Автоматические SSL сертификаты от Let's Encrypt
4. **Тестирование**: Проверить полную функциональность

## 📝 Детальный план

### Этап 1: Установка и настройка Caddy (30 мин)

```bash
# Установка Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# Создание Caddyfile
sudo nano /etc/caddy/Caddyfile
```

**Содержимое Caddyfile:**

```
bibliaris.com {
    reverse_proxy localhost:5000

    # Заголовки безопасности
    header {
        # Скрыть информацию о сервере
        -Server

        # Security headers
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # Логирование
    log {
        output file /var/log/caddy/bibliaris.com.log
        format json
    }
}
```

### Этап 2: DNS конфигурация в Namecheap (15 мин)

**Действия в панели Namecheap:**

1. **Удалить URL Forward:**
   - Войти в Namecheap Dashboard
   - Выбрать домен `bibliaris.com`
   - Domain List → Manage
   - Redirects → Delete URL Forward

2. **Настроить DNS записи:**
   - Advanced DNS → Add New Record
   - Type: `A Record`
   - Host: `@`
   - Value: `209.74.88.183`
   - TTL: `Automatic`

3. **Дополнительные записи (опционально):**
   - Type: `A Record`
   - Host: `www`
   - Value: `209.74.88.183`

### Этап 3: Запуск и тестирование (15 мин)

```bash
# Проверка конфигурации Caddy
sudo caddy validate --config /etc/caddy/Caddyfile

# Запуск Caddy
sudo systemctl enable caddy
sudo systemctl start caddy

# Проверка статуса
sudo systemctl status caddy

# Проверка логов
sudo journalctl -u caddy -f
```

### Этап 4: Проверка доступности (10 мин)

```bash
# Проверка DNS propagation
nslookup bibliaris.com

# Проверка доступности
curl -I https://bibliaris.com
curl -I https://bibliaris.com/api/health/liveness

# Проверка SSL сертификата
openssl s_client -connect bibliaris.com:443 -servername bibliaris.com
```

## 🔍 Критерии успеха

- [ ] `https://bibliaris.com` доступен и возвращает приложение
- [ ] `https://bibliaris.com/api/health/liveness` возвращает HTTP 200
- [ ] SSL сертификат валидный и выпущен Let's Encrypt
- [ ] Автоматический редирект HTTP → HTTPS работает
- [ ] DNS записи корректно настроены

## 🚨 Возможные проблемы и решения

### DNS Propagation

- **Проблема**: DNS изменения не вступили в силу
- **Решение**: Ждать до 48 часов или использовать внешние DNS серверы для проверки

### Let's Encrypt Rate Limits

- **Проблема**: Превышены лимиты на выпуск сертификатов
- **Решение**: Использовать тестовую конфигурацию или ждать сброса лимитов

### Firewall блокирует порты

- **Проблема**: UFW не пропускает 80/443 порты
- **Решение**: `sudo ufw allow 80` и `sudo ufw allow 443`

## 📊 Время выполнения

- **Общее время:** ~70 минут
- **Установка Caddy:** 30 минут
- **DNS настройка:** 15 минут
- **Конфигурация и запуск:** 15 минут
- **Тестирование:** 10 минут

## 🔄 Следующие шаги после завершения

1. **Мониторинг**: Настроить мониторинг доступности домена
2. **Бэкапы**: Включить Caddyfile в систему бэкапов
3. **Документация**: Обновить production deployment guide
4. **Оптимизация**: Настроить кэширование и сжатие

---

**Статус:** ГОТОВ К ВЫПОЛНЕНИЮ  
**Ответственный:** Deploy Engineer  
**Предварительные условия:** ✅ Все выполнены
