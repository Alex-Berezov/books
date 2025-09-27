# Next Steps: Monitoring Setup (Пункт 11 DEPLOYMENT.md)

## Текущий статус (27.09.2025)

### ✅ Что ЗАВЕРШЕНО ПЕРЕД ЭТИМ ЭТАПОМ:

1. **Пункт 6 - Переменные окружения (✅ ЗАВЕРШЕНО):**
   - ✅ `.env.prod` с безопасными настройками
   - ✅ JWT секреты, DATABASE_URL, rate limiting настроены
   - ✅ `check_prod_config.js` для автоматической проверки

2. **Пункт 7 - Reverse Proxy (✅ ЗАВЕРШЕНО):**
   - ✅ Caddy конфигурация с автоматическим HTTPS
   - ✅ Rate limiting, заголовки безопасности
   - ✅ Блокировка `/api/metrics` в продакшене
   - ✅ Скрипты установки и проверки

3. **Готовая инфраструктура:**
   - ✅ NestJS приложение с Prometheus metrics (`/api/metrics`)
   - ✅ Health endpoints (`/api/health/liveness`, `/api/health/readiness`)
   - ✅ Docker контейнеры настроены
   - ✅ Reverse proxy готов к продакшену

### 🎯 ТЕКУЩАЯ ЗАДАЧА: Пункт 11 - Наблюдаемость (Мониторинг)

## Цель:

Настроить систему мониторинга для:

1. Сбора метрик из `/api/metrics` (Prometheus)
2. Визуализации метрик (Grafana)
3. Базовых алертов (5xx ошибки, недоступность)
4. Мониторинга ресурсов сервера

## План выполнения:

### Шаг 1: Создание docker-compose для мониторинга

Создать `docker-compose.monitoring.yml` с:

- [ ] Prometheus (сбор метрик)
- [ ] Grafana (визуализация)
- [ ] Node Exporter (метрики сервера)
- [ ] AlertManager (алерты) - опционально

### Шаг 2: Конфигурация Prometheus

Создать `configs/prometheus.yml`:

- [ ] Scrape job для NestJS app (`/api/metrics`)
- [ ] Scrape job для Node Exporter (системные метрики)
- [ ] Retention policy (7-14 дней для начала)
- [ ] Основные recording rules

### Шаг 3: Настройка Grafana

Создать дашборды:

- [ ] NestJS Application Dashboard (HTTP метрики, response times)
- [ ] System Resources Dashboard (CPU, RAM, Disk)
- [ ] Error Monitoring Dashboard (4xx/5xx rates)
- [ ] Database Connection Pool Dashboard

### Шаг 4: Базовые алерты

Настроить AlertManager для:

- [ ] HTTP 5xx rate > 5% за 5 минут
- [ ] Response time P99 > 2s за 5 минут
- [ ] Application down (health check fail)
- [ ] High memory usage > 85%

### Шаг 5: Интеграция с основным stack

Обновить продакшн конфигурацию:

- [ ] Разрешить доступ к `/api/metrics` для Prometheus
- [ ] Настроить Caddy для мониторинга subdomain
- [ ] Security группы для мониторинга

### Шаг 6: Создание скриптов автоматизации

Создать утилиты:

- [ ] `scripts/setup_monitoring.sh` - установка мониторинга
- [ ] `scripts/test_monitoring.sh` - проверка работы
- [ ] Бэкап конфигурации Grafana

## Архитектура мониторинга:

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────┐
│   NestJS App    │───▶│  Prometheus  │───▶│   Grafana   │
│  /api/metrics   │    │   (9090)     │    │   (3000)    │
└─────────────────┘    └──────────────┘    └─────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │ AlertManager │
                       │   (9093)     │
                       └──────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │  Slack/Email │
                       │   Webhook    │
                       └──────────────┘
```

## Созданные файлы (план):

- `configs/prometheus.yml` - конфигурация Prometheus
- `configs/grafana/` - дашборды и настройки Grafana
- `configs/alertmanager.yml` - правила алертов
- `docker-compose.monitoring.yml` - сервисы мониторинга
- `scripts/setup_monitoring.sh` - автоматическая установка
- `scripts/test_monitoring.sh` - проверка работы
- `docs/MONITORING_GUIDE.md` - руководство по мониторингу

## Безопасность мониторинга:

### 🔒 Требования:

- Grafana за авторизацией (admin/password из env)
- Prometheus доступен только локально или через VPN
- AlertManager с защищенными webhook URL
- `/api/metrics` разрешить только для Prometheus IP

### 🌐 Доступ (планируется):

- `monitoring.example.com` → Grafana (через Caddy)
- `prometheus.example.com` → Prometheus (только для админов)
- Internal network для всех компонентов мониторинга

## Метрики для отслеживания:

### 📊 NestJS Application:

- HTTP requests/sec по методам и статус кодам
- Response time P50/P95/P99
- Active connections
- Memory/CPU usage процесса

### 🖥️ System Resources:

- CPU usage (user/system/idle)
- Memory usage (used/free/cached)
- Disk usage и I/O
- Network traffic

### 🗄️ Database (если добавим позже):

- Connection pool size
- Query execution time
- Slow queries count

## Алерты (критичность):

### 🚨 Critical (немедленно):

- Application down > 1 минута
- HTTP 5xx rate > 10% за 5 минут
- Memory usage > 95%
- Disk usage > 90%

### ⚠️ Warning (в течение часа):

- HTTP 5xx rate > 5% за 10 минут
- Response time P99 > 2s за 10 минут
- Memory usage > 85%
- High CPU usage > 80% за 15 минут

## Успешные критерии:

- [ ] Prometheus собирает метрики из NestJS приложения
- [ ] Grafana показывает дашборды с real-time данными
- [ ] Алерты срабатывают при симуляции проблем
- [ ] Система мониторинга автоматически стартует с сервером
- [ ] Данные сохраняются между перезапусками
- [ ] Документация позволяет воссоздать setup

## После завершения этого этапа:

Переходим к одному из:

- **Пункт 18 - Бэкапы** (автоматические бэкапы PostgreSQL)
- **Пункт 20 - Интеграция с фронтендом** (OpenAPI типы)
- **Создание админ пользователя** и тестирование API

## Возможные проблемы:

1. **Prometheus не видит метрики**: Проверить network в Docker, firewall правила
2. **Grafana не стартует**: Проверить права на volumes, env переменные
3. **Алерты не срабатывают**: Проверить AlertManager конфигурацию, webhook URL
4. **Высокое потребление ресурсов**: Настроить retention policy, sampling

---

Создан: 2025-09-27  
Статус: Готов к выполнению  
Следует после: Пункт 7 (Reverse Proxy) ✅  
Перед: Пункт 18 (Бэкапы) или Пункт 20 (Фронтенд интеграция)
