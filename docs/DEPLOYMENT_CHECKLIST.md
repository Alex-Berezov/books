# 📋 Production Deployment Checklist

> Полный чеклист для развертывания Books App Backend в production окружении

## 🏗️ ПОДГОТОВКА ИНФРАСТРУКТУРЫ

### 1. VPS Сервер

- [ ] **Сервер создан и настроен**
  - Минимум: 2 vCPU, 4GB RAM, 40GB SSD
  - Рекомендуемо: 4 vCPU, 8GB RAM, 80GB SSD
  - ОС: Ubuntu 22.04 LTS или Debian 12

- [ ] **Базовая настройка выполнена**

  ```bash
  # Запуск автоматической настройки
  ./scripts/setup_server.sh --domain api.yourdomain.com
  ```

- [ ] **SSH доступ настроен**
  - SSH ключи добавлены для пользователя `deploy`
  - Отключена аутентификация по паролю
  - Fail2ban настроен и активен

### 2. Домены и DNS

- [ ] **Домен зарегистрирован**: `api.yourdomain.com`
- [ ] **DNS записи настроены**:
  ```
  A     api.yourdomain.com     → IP_СЕРВЕРА
  AAAA  api.yourdomain.com     → IPv6_СЕРВЕРА (если есть)
  ```
- [ ] **TTL установлен на 300-600 секунд** (для быстрого переключения при проблемах)
- [ ] **DNS проверен**: `dig +short api.yourdomain.com`

### 3. Безопасность

- [ ] **Firewall настроен** (UFW):

  ```bash
  sudo ufw allow 22/tcp    # SSH
  sudo ufw allow 80/tcp    # HTTP
  sudo ufw allow 443/tcp   # HTTPS
  sudo ufw enable
  ```

- [ ] **SSL сертификат готов** (Let's Encrypt через Caddy)
- [ ] **Система обновлена**:
  ```bash
  sudo apt update && sudo apt upgrade -y
  ```

## 🐳 DOCKER И ПРИЛОЖЕНИЕ

### 4. Docker окружение

- [ ] **Docker установлен и запущен**:

  ```bash
  docker --version
  docker compose version
  systemctl status docker
  ```

- [ ] **Пользователь deploy в группе docker**:
  ```bash
  groups deploy  # должен содержать docker
  ```

### 5. Код приложения

- [ ] **Репозиторий склонирован в `/opt/books/app`**:

  ```bash
  cd /opt/books/app
  git remote -v  # проверить подключение к репозиторию
  ```

- [ ] **Переменные окружения настроены**:
  ```bash
  cp .env.prod.template .env.prod
  vim .env.prod  # обновить для вашего окружения
  chmod 600 .env.prod
  ```

### 6. Ключевые переменные в .env.prod

```bash
# ✅ КРИТИЧЕСКИ ВАЖНЫЕ переменные:
DATABASE_URL=postgresql://books_app:STRONG_PASSWORD@postgres:5432/books_app?schema=public
JWT_ACCESS_SECRET=    # 32+ символов, base64
JWT_REFRESH_SECRET=   # 32+ символов, base64

# ✅ Безопасность продакшена:
NODE_ENV=production
SWAGGER_ENABLED=0
RATE_LIMIT_GLOBAL_ENABLED=1
TRUST_PROXY=1

# ✅ Домены:
LOCAL_PUBLIC_BASE_URL=https://api.yourdomain.com/static
CORS_ORIGIN=https://yourdomain.com,https://app.yourdomain.com

# ✅ Роли:
ADMIN_EMAILS=admin@yourdomain.com
CONTENT_MANAGER_EMAILS=editor@yourdomain.com
```

## 🗄️ БАЗА ДАННЫХ И СЕРВИСЫ

### 7. PostgreSQL

- [ ] **База данных создана**:

  ```bash
  docker compose -f docker-compose.prod.yml up -d postgres
  docker compose -f docker-compose.prod.yml exec postgres psql -U postgres -c "CREATE DATABASE books_app;"
  ```

- [ ] **Миграции применены**:

  ```bash
  docker compose -f docker-compose.prod.yml run --rm app npx prisma migrate deploy
  ```

- [ ] **Пользователи и права настроены**
- [ ] **Бэкапы настроены**:
  ```bash
  ./scripts/setup_backup_cron.sh --daily --weekly --monthly
  ```

### 8. Reverse Proxy (Caddy)

- [ ] **Caddy установлен и настроен**:

  ```bash
  ./scripts/install_caddy.sh --domain api.yourdomain.com
  ```

- [ ] **HTTPS работает**:
  ```bash
  curl -I https://api.yourdomain.com/api/health/liveness
  ```

## 🚀 ПЕРВЫЙ ДЕПЛОЙ

### 9. Сборка и запуск

- [ ] **Образ собран локально** (тест):

  ```bash
  docker build -t books-app:test .
  ```

- [ ] **Production запуск**:
  ```bash
  ./scripts/deploy_production.sh --version main --force
  ```

### 10. Проверка деплоя

- [ ] **Контейнеры запущены**:

  ```bash
  docker compose -f docker-compose.prod.yml ps
  ```

- [ ] **Health checks проходят**:

  ```bash
  curl https://api.yourdomain.com/api/health/liveness
  curl https://api.yourdomain.com/api/health/readiness
  ```

- [ ] **База данных подключена**
- [ ] **Метрики доступны** (защищены от внешнего доступа):

  ```bash
  curl http://localhost:5000/api/metrics  # только локально
  ```

- [ ] **Swagger отключен**:
  ```bash
  curl -I https://api.yourdomain.com/api/docs  # должен вернуть 404
  ```

### 11. Создание админа

- [ ] **Первый админ пользователь создан**:
  - Зарегистрироваться через API с email из `ADMIN_EMAILS`
  - Проверить роль через GET /admin/users/me

## 📊 МОНИТОРИНГ И ЛОГИРОВАНИЕ

### 12. Система мониторинга

- [ ] **Мониторинг настроен**:

  ```bash
  ./scripts/setup_monitoring.sh --production
  ```

- [ ] **Grafana доступна**: `http://your-server:3000`
- [ ] **Prometheus собирает метрики**: `http://your-server:9090`
- [ ] **AlertManager настроен** для уведомлений

### 13. Логи

- [ ] **Логирование настроено** и ротируется
- [ ] **Структурированные логи** пишутся в JSON
- [ ] **Ошибки отслеживаются** через Sentry (если настроен)

## 🔄 CI/CD И АВТОМАТИЗАЦИЯ

### 14. GitHub Actions

- [ ] **Workflow файл настроен**: `.github/workflows/deploy.yml`
- [ ] **Секреты добавлены в GitHub**:
  - `DEPLOY_SSH_KEY` - приватный SSH ключ для деплоя
  - `GITHUB_TOKEN` - для доступа к GHCR (автоматический)

- [ ] **Variables настроены в GitHub**:
  - `PRODUCTION_SERVER` - IP или домен сервера
  - `PRODUCTION_DOMAIN` - домен API (api.yourdomain.com)

### 15. Автоматические деплои

- [ ] **Деплой по тегу работает**:

  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  # Проверить в GitHub Actions
  ```

- [ ] **Rollback тестирован**:
  ```bash
  ./scripts/deploy_production.sh --rollback
  ```

## 🔒 БЕЗОПАСНОСТЬ И COMPLIANCE

### 16. Security checklist

- [ ] **Секреты не в коде** - все в переменных окружения
- [ ] **HTTPS-only** - HTTP редиректится на HTTPS
- [ ] **Rate limiting включен** глобально и для критических эндпоинтов
- [ ] **CORS настроен** только на нужные домены
- [ ] **Headers безопасности** настроены (Helmet)

### 17. Проверка безопасности

```bash
# Запуск полной проверки
./scripts/test_security.sh

# Проверка сетевой безопасности
nmap -sS your-server-ip

# SSL тест
ssllabs.com/ssltest/  # проверить домен
```

## 🧪 ТЕСТИРОВАНИЕ PRODUCTION

### 18. Функциональные тесты

- [ ] **API endpoints доступны**:

  ```bash
  # Публичные эндпоинты
  curl https://api.yourdomain.com/api/health/liveness
  curl https://api.yourdomain.com/api/books

  # Health checks
  curl https://api.yourdomain.com/api/health/readiness
  ```

- [ ] **Авторизация работает** - тесты регистрации/логина
- [ ] **CRUD операции** работают через API
- [ ] **Файлы загружаются** в `/static/uploads`

### 19. Нагрузочное тестирование

- [ ] **Базовая нагрузка**: 100 RPS на 1 минуту
- [ ] **Пиковая нагрузка**: в зависимости от ожиданий
- [ ] **Память не течет** под нагрузкой
- [ ] **База данных отзывчива**

## 📱 ИНТЕГРАЦИЯ С ФРОНТЕНДОМ

### 20. API контракт

- [ ] **OpenAPI схема актуальна**:

  ```bash
  # Локально сгенерировать типы
  yarn openapi:types:prod
  ```

- [ ] **CORS правильно настроен** для фронтенд доменов
- [ ] **API версионирование** понятно фронтенд команде
- [ ] **Breaking changes задокументированы**

## 🚨 ПЛАН НА СЛУЧАЙ ПРОБЛЕМ

### 21. Troubleshooting

**Если деплой не удался:**

```bash
# Посмотреть логи
docker compose -f docker-compose.prod.yml logs app

# Откатиться к предыдущей версии
./scripts/deploy_production.sh --rollback

# Проверить состояние системы
systemctl status docker
df -h  # проверить место на диске
```

**Если база данных недоступна:**

```bash
# Проверить подключение
docker compose -f docker-compose.prod.yml exec postgres psql -U books_app -d books_app -c "SELECT 1;"

# Восстановить из бэкапа
./scripts/restore_database.sh
```

### 22. Контакты экстренной поддержки

- [ ] **Команда разработки**: контакты и роли определены
- [ ] **Системный администратор**: доступен для проблем с сервером
- [ ] **DevOps инженер**: для проблем с CI/CD
- [ ] **Мониторинг настроен** на отправку алертов нужным людям

---

## ✅ ФИНАЛЬНАЯ ПРОВЕРКА

После выполнения всех пунктов:

```bash
# Комплексная проверка всей системы
./scripts/test_security.sh
./scripts/test_monitoring.sh
./scripts/test_backup.sh

# API smoke test
curl -f https://api.yourdomain.com/api/health/liveness
curl -f https://api.yourdomain.com/api/health/readiness
curl -f https://api.yourdomain.com/api/books

# Проверить что приложение работает под нагрузкой
ab -n 1000 -c 10 https://api.yourdomain.com/api/health/liveness
```

### 🎉 Готово к production!

**Документация:**

- [ ] `SERVER_INFO.md` создан и актуален
- [ ] Команда ознакомлена с процедурами деплоя
- [ ] Мониторинг и алерты настроены
- [ ] Контакты для поддержки определены

**Дата завершения:** \***\*\_\_\_\*\***  
**Ответственный:** \***\*\_\_\_\*\***  
**Подпись:** \***\*\_\_\_\*\***
