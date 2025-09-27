# Reverse Proxy Setup - Инструкция по развертыванию

## Файлы для настройки reverse proxy

### 📁 Созданные файлы:

- `configs/Caddyfile.prod` - конфигурация Caddy для продакшена
- `scripts/install_caddy.sh` - автоматическая установка Caddy
- `scripts/test_reverse_proxy.sh` - проверка работы reverse proxy

### 📝 Обновленные файлы:

- `docker-compose.prod.yml` - убран публичный порт 5000
- `.env.prod` - обновлены URL для работы с proxy

## Пошаговое развертывание

### Предварительные требования:

- ✅ Пункт 6 (Переменные окружения) выполнен
- ✅ Контейнеры приложения запущены и работают
- 🌐 DNS A-запись `api.example.com` настроена на IP сервера
- 🔥 Порты 80 и 443 открыты в облачном провайдере

### 1. Подготовка на сервере:

```bash
# На сервере в папке проекта
cd /opt/books/app/src

# Скопировать файлы конфигурации (если еще не скопированы)
# git pull  # или скопировать вручную configs/ и scripts/
```

### 2. Установка Caddy:

```bash
# Запустить скрипт установки (от sudo)
sudo ./scripts/install_caddy.sh
```

Скрипт выполнит:

- Установку Caddy из официального репозитория
- Копирование конфигурации из `configs/Caddyfile.prod`
- Настройку файрвола (порты 80, 443)
- Проверку конфигурации и запуск сервиса

### 3. Обновление приложения:

```bash
# Перезапустить контейнеры с обновленной конфигурацией
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d

# Проверить что приложение работает только внутренне
curl -I http://localhost:5000/api/health/liveness  # должен работать
```

### 4. Проверка работы:

```bash
# Запустить тесты reverse proxy
./scripts/test_reverse_proxy.sh api.example.com
```

Или ручная проверка:

```bash
# HTTPS должен работать автоматически
curl -I https://api.example.com/api/health/liveness

# HTTP должен перенаправлять на HTTPS
curl -I http://api.example.com

# Metrics должны быть заблокированы
curl -I https://api.example.com/api/metrics  # 403 Forbidden

# WWW должен перенаправлять
curl -I http://www.api.example.com
```

## Конфигурация Caddy

### Основные функции:

1. **Автоматический HTTPS**:
   - Let's Encrypt сертификаты
   - Автоматическое обновление
   - HSTS заголовки

2. **Reverse Proxy**:
   - Проксирование `api.example.com` → `localhost:5000`
   - Прозрачная передача заголовков

3. **Безопасность**:
   - Rate limiting (100 запросов/минуту на IP)
   - Блокировка `/api/metrics` в продакшене
   - Заголовки безопасности (XSS, CSRF, etc.)

4. **Логирование**:
   - JSON формат в `/var/log/caddy/api.log`
   - Ротация логов (100MB, 5 файлов)

### Мониторинг:

```bash
# Статус сервиса
systemctl status caddy

# Логи в реальном времени
journalctl -u caddy -f

# Логи доступа
tail -f /var/log/caddy/api.log

# Проверка конфигурации
caddy validate --config /etc/caddy/Caddyfile
```

## Безопасность

### ✅ Включено:

- HTTPS принудительно (HSTS)
- Rate limiting на уровне proxy
- Блокировка metrics endpoint
- Заголовки безопасности
- Приложение недоступно напрямую (только через proxy)

### ⚠️ Рекомендации:

- Регулярно проверять обновления Caddy
- Мониторить логи на подозрительную активность
- Настроить alerting на 5xx ошибки
- Периодически проверять SSL сертификаты

## Troubleshooting

### Caddy не запускается:

```bash
# Проверить конфигурацию
sudo caddy validate --config /etc/caddy/Caddyfile

# Проверить логи
sudo journalctl -u caddy -n 50
```

### 502 Bad Gateway:

```bash
# Проверить что приложение работает
curl -I http://localhost:5000/api/health/liveness

# Проверить контейнеры
docker compose -f docker-compose.prod.yml ps
```

### Let's Encrypt ошибки:

```bash
# Проверить что домен доступен извне
nslookup api.example.com

# Проверить порты
sudo ufw status
sudo netstat -tlnp | grep :80
sudo netstat -tlnp | grep :443
```

## Следующие шаги

После успешной настройки reverse proxy:

1. **Мониторинг** (Пункт 11 DEPLOYMENT.md)
2. **Автоматические бэкапы** (Пункт 18)
3. **Создание админ пользователя**
4. **Интеграция с фронтендом**

---

Обновлено: 2025-09-27  
Статус: Готово к использованию
