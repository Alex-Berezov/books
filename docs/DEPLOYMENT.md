# Production Deployment Guide

> Цель: Быстро и безопасно развернуть текущий backend (NestJS + PostgreSQL + Prisma + Redis/BullMQ + Docker) в прод на VPS, чтобы фронтенд мог использовать стабильный API.

## 1. Домены и DNS

- Основной: `api.example.com` — публичный API.
- (Опц.) `admin.example.com` — если появится отдельная админка.
- DNS: A/AAAA → IP VPS. TTL 300–600 на этапе частых апдейтов.
- Проверка: `dig +short api.example.com`.

## 2. VPS / Сервер

- Рекомендуемый старт: 2 vCPU, 2–4 GB RAM, 20+ GB SSD.
- ОС: Ubuntu 24.04 LTS или Debian 12.
- Создать пользователя `deploy`, добавить в группу `docker`.
- Порты: 80/443 (proxy), 22 (SSH), БД/Redis не публиковать наружу.
- Обновление: `apt update && apt upgrade -y`.

## 3. Контейнеры и Артефакты

- Используем `Dockerfile` (multi-stage) + `docker-compose.prod.yml`.
- Redis можно временно не включать (если не критичен BullMQ) — просто не задавать `REDIS_*`.
- Теги образов: `prod-vX.Y.Z`, `sha-<SHORT_SHA>`, `latest` (не как единственный источник истины).
- Registry: GitLab / GHCR / частный.

## 4. Git / Ветки / Релизы

- `main` — прод.
- Feature ветки → PR → merge в `main`.
- Тег при релизе: `v1.0.0` (триггер деплоя).
- Возможен trunk-based без develop.

## 5. CI/CD (Концепт)

Stages:

1. Install: `yarn --frozen-lockfile`.
2. Lint: `yarn lint`.
3. Typecheck: `yarn typecheck`.
4. Unit: `yarn test`.
5. E2E: `yarn test:e2e` (в CI сервис Postgres + миграции).
6. Build image: `docker build -t registry/books-app:${CI_COMMIT_SHA} -f Dockerfile .`.
7. Tag + push: `prod-vX.Y.Z` (если релиз).
8. Deploy: pull на сервере → `docker compose ... up -d`.

- Миграции выполняет entrypoint (`prisma migrate deploy`) — запускать один инстанс.

## 6. Переменные окружения (.env.prod пример)

```
DATABASE_URL=postgresql://app_user:STRONG_PASS@postgres:5432/books?schema=public
PORT=5000
HOST=0.0.0.0
DEFAULT_LANGUAGE=en
LOCAL_PUBLIC_BASE_URL=https://api.example.com/static
CORS_ORIGIN=https://frontend.example.com
SWAGGER_ENABLED=0
RATE_LIMIT_GLOBAL_ENABLED=1
ADMIN_EMAILS=admin@example.com
CONTENT_MANAGER_EMAILS=editor@example.com
# Опционально Redis / BullMQ
# REDIS_HOST=redis
# REDIS_PORT=6379
# BULLMQ_IN_PROCESS_WORKER=0
TRUST_PROXY=1
```

Хранение: CI protected vars + на сервере `chmod 600 /opt/books/app/.env.prod`.

## 7. Reverse Proxy / TLS

- Nginx или Caddy (Caddy проще → авто TLS).
- Прокси: `api.example.com` → `app:5000`.
- `/metrics` защитить (basic auth/IP whitelist) или закрыть полностью.
- Установить `TRUST_PROXY=1`.

## 8. Статика и Uploads

- Локальные загрузки: volume → `/opt/books/uploads` (или docker volume).
- BACKUP включать uploads вместе с БД.
- Позже можно вынести в S3 (меняем URL генерацию + ENV).

## 9. PostgreSQL (Прод)

- Отдельный пользователь: минимум прав (не superuser).
- Volume/dir: `/var/lib/postgresql/data`.
- Автобэкап (cron): `pg_dump books | gzip > /opt/books/backups/books-$(date +%F).sql.gz`.
- Хранение 7–14 дней, периодический restore тест.

## 10. Redis (Опционально сейчас)

- Включить позже при активном использовании очередей.
- Если включён: только внутренняя сеть Docker, persistence при необходимости.

## 11. Наблюдаемость

- `/metrics` (Prometheus формат) — использовать uptime монитор.
- Логи: docker stdout (агрегация позже — Loki / ELK).
- Базовый алерт: 5xx спайки и недоступность health.
- Возможное будущее: Sentry (DSN env).

## 12. Безопасность

- SSH: только ключи, disable password auth.
- UFW: allow 22,80,443; deny остальное.
- Swagger отключён (`SWAGGER_ENABLED=0`) в прод.
- CORS ограничен фронт‑доменом.
- Rate limiting включить (глобальный + комментарии).
- Регулярные apt обновления / unattended-upgrades.
- Ограничить доступ к `/metrics`.

## 13. Процесс Релиза

1. Merge в `main`.
2. CI зелёный → создаём тег `vX.Y.Z`.
3. Build + push образ `prod-vX.Y.Z`.
4. На сервере: pull + `docker compose up -d`.
5. Проверка health (`GET /metrics` 200).
6. Оповещение фронта (если изменился контракт).
   Rollback:

- Pull предыдущего тега → up -d.
- Если миграции необратимы — использовать pre-release DB dump.

## 14. Staging (Рекомендовано)

- Домен: `api-staging.example.com`.
- Отдельная БД: `books_staging`.
- Автодеплой из feature merges (develop). Миграции каждое обновление.
- Анонимизация данных прод (при копировании).

## 15. Доступы и Права

- Нет публичного доступа к Postgres/Redis.
- Пользователь БД с ограничением по DB.
- CI deploy ключ с ограниченным scp/ssh (или использование GitLab Deploy Token / GitHub Actions OIDC → registry).

## 16. DEPLOYMENT.md Поддержка / Документация

Добавить в README ссылку (опционально) + поддерживать при изменении Docker/CI.

## 17. Первый Ручной Деплой (Cheat Sheet)

```
# На сервере (один раз)
apt update && apt upgrade -y
apt install -y docker.io docker-compose-plugin fail2ban ufw
useradd -m -s /bin/bash deploy
usermod -aG docker deploy
# (Relogin)

mkdir -p /opt/books/{app,uploads,backups}
vim /opt/books/app/.env.prod

# Скопировать docker-compose.prod.yml (из репо)
# Войти в registry (если приватный)
docker login <registry>

docker compose --profile prod -f docker-compose.prod.yml pull
docker compose --profile prod -f docker-compose.prod.yml up -d

# Проверка
curl -sf http://127.0.0.1:5000/metrics | head -n 5
# (После настройки TLS)
curl -sf https://api.example.com/metrics | head -n 5
```

Создание админа: зарегистрировать email из `ADMIN_EMAILS`.

## 18. Бэкапы

- Cron (пример `/etc/cron.d/books_backups`):

```
0 2 * * * postgres pg_dump books | gzip > /opt/books/backups/books-$(date +\%F).sql.gz
0 3 * * * root find /opt/books/backups -type f -mtime +14 -delete
```

- Восстановление тестировать: `psql books < dump.sql`.

## 19. Минимальный Чеклист Перед PROD

- [ ] Домен и DNS настроены
- [ ] HTTPS работает
- [ ] Контейнер healthy
- [ ] `/metrics` доступ ограничен
- [ ] Rate limiting включён
- [ ] Swagger выключен
- [ ] Бэкап cron активен
- [ ] Админ пользователь создан
- [ ] Образ задокументирован (версия / тег)

## 20. Интеграция с Фронтендом

- Предоставить BASE_API_URL.
- Сгенерировать OpenAPI типы: `yarn openapi:types:prod` (временно включить Swagger или сгенерировать из staging).
- Стабильный контракт — фиксировать breaking changes через CHANGELOG.

## 21. Дальнейшие Улучшения

- Terraform/IaC.
- Watchtower (с осторожностью) или GitOps (ArgoCD).
- S3/GCS для медиа.
- Prometheus + Grafana bundle.
- Centralized logging (Loki / OpenSearch).

---

Обновляйте этот файл при изменениях инфраструктуры, CI или переменных окружения.

## 22. Рекомендуемые прод настройки (Тариф Quasar + Cloudflare R2)

Профиль плана: 4 vCPU / 6 GB RAM / 120 GB SSD. Ниже параметры и ENV для запуска с внешним объектным хранилищем (R2) и без Redis на старте.

### 22.1 Распределение ресурсов

- Node/NestJS: 300–450 MB RAM. Ограничить GC heap: `NODE_OPTIONS=--max-old-space-size=1024`.
- Postgres (~1.5–2 GB целевое использование):
  - shared_buffers=1GB
  - effective_cache_size=4GB
  - work_mem=32MB (16MB если много соединений)
  - maintenance_work_mem=256MB
  - max_connections=80 (позже PgBouncer при росте)
  - wal_compression=on, checkpoint_timeout=15min, max_wal_size=2GB
- Proxy (Nginx/Caddy)+статический фронт <100 MB.
- Резерв RAM >3 GB под пики/миграции/фоновый воркер.

### 22.2 Системные тюнинги

- Swap 1–2 GB (страховка, не рабочая нагрузка):
  - `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`
  - sysctl: `vm.swappiness=10`, `vm.vfs_cache_pressure=50`.
- `ulimit -n 4096` (Docker ulimit или systemd).
- Лог-ротация journald / nginx / app (logrotate или size‑ограничения).

### 22.3 Cloudflare R2 (S3 API)

Переменные (добавить при интеграции адаптера):

```
R2_ACCOUNT_ID=<id>
R2_ACCESS_KEY_ID=<access_key>
R2_SECRET_ACCESS_KEY=<secret_key>
R2_BUCKET=books-media
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_PUBLIC_BASE_URL=https://media.example.com
```

Рекомендации:

- Выделенный bucket, отключить публичный листинг.
- API token с минимальными правами.
- CORS в R2 разрешить только фронт домен.
- CDN/Custom domain через Cloudflare для кеша.

### 22.4 Стратегия загрузок

1. Presigned URL (рекомендуется): API выдаёт PUT URL → клиент заливает → API `confirm` создаёт `MediaAsset`.
2. Серверный proxy (fallback) — дороже по CPU/трафику.
   Адаптер хранения: интерфейс `upload/delete/getPublicUrl/presign` + локальный провайдер для тестов.

### 22.5 Политика хранения и контроль

- Не включать версионность объектов на старте.
- Использовать поле `hash` в `MediaAsset` для dedup.
- Размеры проверять в API (лимиты уже есть ENV).

### 22.6 Бэкапы

- R2 не бэкапим отдельно (встроенная надёжность); критично — бэкапить Postgres (метаданные `MediaAsset`).
- Постдеплойная проверка: случайная выборка media → запрос публичного URL.

### 22.7 Метрики

- Добавить counters (после внедрения): `media_upload_success_total`, `media_upload_fail_total`.
- Логировать ключ и размер (info) для аудита.

### 22.8 Когда добавлять Redis/BullMQ

- Появились фоновые задачи (аудио-транскодинг, массовые уведомления) или долгие операции блокируют запросы.
- После включения: отдельный контейнер воркера + лимит heap `--max-old-space-size=512`.

### 22.9 Масштабирование выше Quasar

- CPU >60% среднее по 4 vCPU длительно.
- RAM >75% без кеша ОС.
- P99 задержка простых SELECT >20–30ms.
- Увеличение медиапотока → вынести Postgres в managed + реплики.

### 22.10 Чеклист Quasar + R2

```
[ ] VPS (Quasar) создан, обновлён
[ ] Swap 2G + sysctl параметры применены
[ ] Docker/Compose установлены
[ ] Postgres тюнинг внедрён (shared_buffers=1GB ...)
[ ] Bucket R2 создан, token выпущен
[ ] ENV R2_* подготовлены (можно закомментировать до кода адаптера)
[ ] .env.prod без Redis на старте
[ ] Первый deploy: health OK
[ ] Cron бэкапов Postgres активен
[ ] Админ пользователь подтверждён
```

Секция обновится после добавления кода адаптера R2.
