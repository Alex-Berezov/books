# Production Quick Commands

Быстрые команды для управления production сервером.

## 📍 SSH доступ

```bash
ssh deploy@bibliaris.com
```

## 🔧 Swagger

```bash
# Включить Swagger
./scripts/toggle_swagger.sh enable

# Проверить статус
./scripts/toggle_swagger.sh status

# Отключить Swagger
./scripts/toggle_swagger.sh disable
```

**URLs после включения:**

- Swagger UI: https://api.bibliaris.com/docs
- OpenAPI JSON: https://api.bibliaris.com/docs-json

**Примечание:** Swagger находится на `/docs` (без префикса `/api`), в то время как все API endpoints на `/api/*`

## 🐳 Docker

```bash
# Статус контейнеров
docker compose --profile prod -f docker-compose.prod.yml ps

# Логи приложения
docker compose --profile prod -f docker-compose.prod.yml logs -f app

# Логи БД
docker compose --profile prod -f docker-compose.prod.yml logs -f postgres

# Перезапустить приложение
docker compose --profile prod -f docker-compose.prod.yml restart app

# Остановить все
docker compose --profile prod -f docker-compose.prod.yml down

# Запустить все
docker compose --profile prod -f docker-compose.prod.yml up -d
```

## 🩺 Health Checks

```bash
# Liveness (приложение живо?)
curl https://api.bibliaris.com/api/health/liveness

# Readiness (БД доступна?)
curl https://api.bibliaris.com/api/health/readiness

# Метрики
curl https://api.bibliaris.com/api/metrics

# Swagger UI (если включен)
open https://api.bibliaris.com/docs

# OpenAPI схема
curl https://api.bibliaris.com/docs-json
```

## 🔄 Деплой

```bash
# Локально - создать и запушить тег
git tag v1.0.x
git push origin v1.0.x

# На сервере - ручной деплой
cd /opt/books/app/src
./scripts/deploy_production.sh --version main

# Откат к предыдущей версии
./scripts/deploy_production.sh --rollback
```

## 💾 База данных

```bash
# Создать бэкап
./scripts/backup_database.sh daily

# Восстановить из бэкапа
./scripts/restore_database.sh

# Prisma миграции
cd /opt/books/app/src
docker compose --profile prod -f docker-compose.prod.yml exec app yarn prisma migrate deploy

# Prisma Studio (на сервере)
docker compose --profile prod -f docker-compose.prod.yml exec app yarn prisma studio
# Доступен на: http://SERVER_IP:5555
```

## 📝 Логи

```bash
# Все логи
docker compose --profile prod -f docker-compose.prod.yml logs -f

# Только приложение
docker compose --profile prod -f docker-compose.prod.yml logs -f app

# Последние 100 строк
docker compose --profile prod -f docker-compose.prod.yml logs --tail=100 app

# Фильтр по ключевому слову
docker compose --profile prod -f docker-compose.prod.yml logs app | grep ERROR
```

## ⚙️ Конфигурация

```bash
# Редактировать .env.prod
nano /opt/books/app/src/.env.prod

# После изменений - перезапустить
docker compose --profile prod -f docker-compose.prod.yml restart app
```

## 🔐 Безопасность

```bash
# Проверить открытые порты
sudo ufw status

# Проверить SSL сертификат
curl -vI https://bibliaris.com 2>&1 | grep -i "expire"

# Обновить SSL (автоматически через Caddy)
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## 📊 Мониторинг

```bash
# Использование ресурсов контейнеров
docker stats

# Использование диска
df -h

# Размер логов Docker
du -sh /var/lib/docker/containers/*/*-json.log

# Очистить старые логи
truncate -s 0 /var/lib/docker/containers/*/*-json.log
```

## 🚨 Emergency

```bash
# Быстрый перезапуск всего
docker compose --profile prod -f docker-compose.prod.yml restart

# Откат деплоя
./scripts/deploy_production.sh --rollback

# Остановить приложение (БД продолжает работать)
docker compose --profile prod -f docker-compose.prod.yml stop app

# Запустить приложение
docker compose --profile prod -f docker-compose.prod.yml start app
```

## 🔍 Отладка

```bash
# Войти в контейнер приложения
docker compose --profile prod -f docker-compose.prod.yml exec app sh

# Войти в PostgreSQL
docker compose --profile prod -f docker-compose.prod.yml exec postgres psql -U books_app -d books

# Проверить переменные окружения в контейнере
docker compose --profile prod -f docker-compose.prod.yml exec app env | grep SWAGGER

# Проверить версию Node.js
docker compose --profile prod -f docker-compose.prod.yml exec app node --version
```

## 📚 Полезные ссылки

- [Полное руководство по деплою](PRODUCTION_DEPLOYMENT_GUIDE.md)
- [Swagger на production](SWAGGER_ON_PRODUCTION.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Бэкапы](BACKUP_GUIDE.md)
- [Мониторинг](MONITORING_GUIDE.md)
- [Безопасность](SECURITY_GUIDE.md)
