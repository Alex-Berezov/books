# Monitoring Guide - Books App

## Обзор

Система мониторинга для Books App включает в себя:

- **Prometheus** - сбор и хранение метрик
- **Grafana** - визуализация метрик и дашборды
- **AlertManager** - управление алертами и уведомлениями
- **Node Exporter** - системные метрики сервера

## Быстрый старт

### 1. Установка

```bash
# Клонируйте репозиторий и перейдите в директорию
cd books-app-back

# Запустите автоматическую установку
./scripts/setup_monitoring.sh
```

### 2. Проверка работоспособности

```bash
# Запустите тесты мониторинга
./scripts/test_monitoring.sh
```

### 3. Доступ к интерфейсам

- **Grafana**: http://localhost:3000 (admin/admin123)
- **Prometheus**: http://localhost:9090
- **AlertManager**: http://localhost:9093
- **Node Exporter**: http://localhost:9100

## Конфигурация

### Переменные окружения

Скопируйте и настройте файл переменных окружения:

```bash
cp .env.monitoring .env.monitoring.local
```

Основные переменные:

- `GRAFANA_ADMIN_PASSWORD` - пароль администратора Grafana
- `ALERT_EMAIL_TO` - email для получения алертов
- `SLACK_WEBHOOK_URL` - webhook для Slack уведомлений

### Безопасность

**⚠️ В продакшене обязательно измените:**

1. Пароль администратора Grafana
2. Настройте HTTPS для всех интерфейсов
3. Ограничьте доступ к мониторингу по IP
4. Используйте Docker secrets для чувствительных данных

## Дашборды

### 1. NestJS Application Dashboard

Мониторинг производительности приложения:

- **HTTP Requests/sec** - количество запросов в секунду
- **Error Rate** - процент ошибок (4xx/5xx)
- **Response Time** - время отклика (P50/P95/P99)
- **Most Active Endpoints** - самые активные эндпоинты

### 2. System Resources Dashboard

Системные ресурсы сервера:

- **CPU Usage** - загрузка процессора
- **Memory Usage** - использование памяти
- **Disk Usage** - использование диска
- **Network Traffic** - сетевой трафик

### 3. Error Monitoring Dashboard

Специализированный мониторинг ошибок:

- **Current Error Rate** - текущий уровень ошибок
- **5xx/4xx Errors** - количество ошибок по типам
- **Slowest Endpoints** - самые медленные эндпоинты

## Алерты

### Критические алерты

Требуют немедленного вмешательства:

- **BooksAppDown** - приложение недоступно > 1 минуты
- **HighErrorRate** - уровень ошибок > 10% за 5 минут
- **VeryHighResponseTime** - P99 > 5 секунд за 5 минут
- **HighMemoryUsage** - использование памяти > 95%
- **DiskSpaceFull** - использование диска > 90%

### Предупреждающие алерты

Требуют внимания в разумное время:

- **ModerateErrorRate** - уровень ошибок > 5% за 10 минут
- **HighResponseTime** - P99 > 2 секунд за 10 минут
- **HighCPUUsage** - загрузка CPU > 80% за 15 минут

### Настройка уведомлений

#### Email уведомления

Настройте SMTP в `.env.monitoring`:

```env
SMTP_HOST=smtp.gmail.com:587
SMTP_USERNAME=your-email@gmail.com
SMTP_PASSWORD=your-app-password
ALERT_EMAIL_FROM=alerts@yourapp.com
ALERT_EMAIL_TO=admin@yourapp.com
```

#### Slack уведомления

1. Создайте Incoming Webhook в Slack
2. Добавьте URL в `.env.monitoring`:

```env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
SLACK_CHANNEL=#alerts
```

## Метрики приложения

### HTTP метрики

- `http_request_duration_seconds` - время выполнения HTTP запросов
- `http_request_duration_seconds_count` - количество HTTP запросов
- `http_request_duration_seconds_sum` - общее время выполнения

Лейблы:

- `method` - HTTP метод (GET, POST, etc.)
- `route` - маршрут запроса
- `status_code` - код статуса ответа

### Системные метрики (Node.js)

- `process_cpu_user_seconds_total` - время CPU в пользовательском режиме
- `process_cpu_system_seconds_total` - время CPU в системном режиме
- `process_resident_memory_bytes` - используемая память
- `process_heap_bytes` - размер heap
- `nodejs_eventloop_lag_seconds` - задержка event loop

## Мониторинг в продакшене

### Требования к ресурсам

**Минимальная конфигурация:**

- CPU: 1 vCPU (для всех компонентов мониторинга)
- RAM: 2 GB (Prometheus ~1GB, Grafana ~512MB, остальное ~512MB)
- Диск: 10 GB (для хранения метрик за 14 дней)

**Рекомендуемая конфигурация:**

- CPU: 2 vCPU
- RAM: 4 GB
- Диск: 20 GB SSD

### Настройка хранения

По умолчанию Prometheus хранит данные 14 дней. Для изменения периода:

```yaml
# В docker-compose.monitoring.yml
command:
  - '--storage.tsdb.retention.time=30d' # 30 дней
  - '--storage.tsdb.retention.size=5GB' # или лимит по размеру
```

### Бэкапы

Важные данные для бэкапа:

1. **Grafana конфигурация**:

   ```bash
   docker cp books-grafana:/var/lib/grafana ./backup/grafana-$(date +%Y%m%d)
   ```

2. **Prometheus данные** (опционально):
   ```bash
   docker cp books-prometheus:/prometheus ./backup/prometheus-$(date +%Y%m%d)
   ```

### Обновления

Обновление версий:

```bash
# Остановка мониторинга
docker-compose -f docker-compose.monitoring.yml down

# Обновление образов в docker-compose.monitoring.yml
# Запуск с новыми версиями
docker-compose -f docker-compose.monitoring.yml pull
docker-compose -f docker-compose.monitoring.yml up -d
```

## Troubleshooting

### Частые проблемы

#### 1. Prometheus не видит метрики приложения

**Симптомы**: Target "books-app" показывает состояние "down"

**Решение**:

```bash
# Проверьте доступность метрик напрямую
curl http://localhost:5000/api/metrics

# Проверьте сетевые настройки Docker
docker network ls
docker network inspect books-network

# На Linux может потребоваться другой target:
# Измените в configs/prometheus.yml с host.docker.internal:5000 на 172.17.0.1:5000
```

#### 2. Grafana не подключается к Prometheus

**Симптомы**: Дашборды показывают "No data"

**Решение**:

```bash
# Проверьте логи Grafana
docker-compose -f docker-compose.monitoring.yml logs grafana

# Проверьте доступность Prometheus из контейнера Grafana
docker-compose -f docker-compose.monitoring.yml exec grafana wget -qO- http://prometheus:9090/-/healthy
```

#### 3. Алерты не отправляются

**Симптомы**: Алерты срабатывают в Prometheus, но уведомления не приходят

**Решение**:

```bash
# Проверьте конфигурацию AlertManager
docker-compose -f docker-compose.monitoring.yml logs alertmanager

# Проверьте настройки SMTP/Slack в .env.monitoring

# Протестируйте алерт вручную через API AlertManager
curl -X POST http://localhost:9093/api/v1/alerts \
  -H 'Content-Type: application/json' \
  -d '[{"labels":{"alertname":"test"}}]'
```

### Полезные команды

```bash
# Просмотр логов всех сервисов мониторинга
docker-compose -f docker-compose.monitoring.yml logs -f

# Перезапуск конкретного сервиса
docker-compose -f docker-compose.monitoring.yml restart prometheus

# Проверка состояния всех сервисов
docker-compose -f docker-compose.monitoring.yml ps

# Очистка старых данных (будьте осторожны!)
docker-compose -f docker-compose.monitoring.yml down -v
```

### Мониторинг мониторинга

Следите за состоянием самой системы мониторинга:

```bash
# Проверка использования ресурсов
docker stats books-prometheus books-grafana books-alertmanager

# Размер данных Prometheus
docker exec books-prometheus du -sh /prometheus

# Статус targets в Prometheus
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job, health}'
```

## Кастомизация

### Добавление новых метрик

Для добавления собственных метрик в приложение:

```typescript
// В вашем NestJS сервисе
import { MetricsService } from './modules/metrics/metrics.service';

@Injectable()
export class YourService {
  private customCounter = new Counter({
    name: 'custom_operations_total',
    help: 'Total number of custom operations',
    labelNames: ['type', 'status'],
  });

  constructor(private metrics: MetricsService) {
    // Регистрируем метрику
    this.metrics.registry.registerMetric(this.customCounter);
  }

  doSomething(type: string) {
    // Увеличиваем счетчик
    this.customCounter.inc({ type, status: 'success' });
  }
}
```

### Создание новых дашбордов

1. Создайте дашборд в UI Grafana
2. Экспортируйте JSON через Settings → JSON Model
3. Сохраните в `configs/grafana/dashboards/`
4. Дашборд автоматически загрузится при следующем старте

### Добавление новых алертов

Добавьте правила в `configs/alert_rules.yml`:

```yaml
- alert: CustomAlert
  expr: your_metric > threshold
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: 'Custom alert fired'
    description: 'Your custom condition detected'
```

---

## Поддержка

При возникновении проблем:

1. Запустите диагностику: `./scripts/test_monitoring.sh`
2. Проверьте логи: `docker-compose -f docker-compose.monitoring.yml logs`
3. Обратитесь к документации Prometheus/Grafana
4. Создайте issue в репозитории проекта
