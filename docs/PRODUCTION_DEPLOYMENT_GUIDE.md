# 🚀 Production Deployment Guide - Полное руководство

> Пошаговое руководство по развертыванию Books App Backend в production окружении

## 📋 Обзор процесса

Данное руководство покрывает полный процесс развертывания от настройки сервера до мониторинга production приложения.

### 🎯 Что будет развернуто:

- **NestJS API сервер** с PostgreSQL и Redis
- **Reverse proxy** (Caddy) с автоматическим HTTPS
- **Система мониторинга** (Prometheus + Grafana + AlertManager)
- **Автоматические бэкапы** базы данных и файлов
- **CI/CD pipeline** через GitHub Actions
- **Система безопасности** и мониторинга

### ⏱️ Время развертывания: 2-4 часа

---

## 🏁 ЭТАП 1: ПОДГОТОВКА

### 1.1 Требования

**Сервер:**

- Ubuntu 22.04+ или Debian 12+
- Минимум: 2 vCPU, 4GB RAM, 40GB SSD
- Рекомендуемо: 4 vCPU, 8GB RAM, 80GB SSD
- Открытые порты: 22 (SSH), 80 (HTTP), 443 (HTTPS)

**Домен:**

- Зарегистрированный домен (например: `api.yourdomain.com`)
- Доступ к DNS настройкам

**Локальная среда:**

- Git репозиторий этого проекта
- SSH ключ для доступа к серверу
- Docker и Docker Compose (для тестирования)

### 1.2 Создание SSH ключа (если нет)

```bash
# Генерация SSH ключа
ssh-keygen -t ed25519 -C "your-email@example.com"

# Копирование публичного ключа
cat ~/.ssh/id_ed25519.pub
# Скопируйте вывод - понадобится при настройке сервера
```

### 1.3 Настройка DNS

Добавьте A-запись в DNS вашего домена:

```
Тип: A
Имя: api (или @, если поддомен не нужен)
Значение: IP_ВАШЕГО_СЕРВЕРА
TTL: 300 (5 минут - для быстрого переключения)
```

Проверка:

```bash
dig +short api.yourdomain.com
# Должен вернуть IP вашего сервера
```

---

## 🔧 ЭТАП 2: НАСТРОЙКА СЕРВЕРА

### 2.1 Подключение к серверу

```bash
# Первое подключение (под root или с sudo)
ssh root@YOUR_SERVER_IP

# Или через sudo пользователя
ssh user@YOUR_SERVER_IP
```

### 2.2 Автоматическая настройка сервера

Скопируйте скрипт настройки на сервер:

```bash
# На сервере
curl -o setup_server.sh https://raw.githubusercontent.com/your-repo/main/scripts/setup_server.sh
chmod +x setup_server.sh

# Запуск автоматической настройки
sudo ./setup_server.sh --domain api.yourdomain.com
```

**Что делает скрипт:**

- Обновляет систему и устанавливает необходимые пакеты
- Устанавливает Docker и Docker Compose
- Создает пользователя `deploy` с правами sudo и docker
- Настраивает структуру каталогов `/opt/books/`
- Конфигурирует системные лимиты и параметры производительности
- Настраивает логирование и ротацию логов

**Во время выполнения скрипта:**

1. Подтвердите установку (Y/n)
2. Вставьте ваш публичный SSH ключ когда будет запрос
3. Дождитесь завершения (5-10 минут)

### 2.3 Проверка настройки

```bash
# Переключение на пользователя deploy
su deploy
cd /opt/books

# Проверка Docker
docker --version
docker compose version
docker ps

# Проверка структуры каталогов
ls -la /opt/books/
# Должно быть: app/ uploads/ backups/ logs/
```

---

## 📦 ЭТАП 3: РАЗВЕРТЫВАНИЕ ПРИЛОЖЕНИЯ

### 3.1 Клонирование репозитория

```bash
# Под пользователем deploy
cd /opt/books/app
git clone https://github.com/your-username/books-app-back.git .

# Проверка
ls -la
# Должны быть файлы: package.json, Dockerfile, docker-compose.prod.yml, etc.
```

### 3.2 Настройка переменных окружения

```bash
# Создание production конфигурации
cp .env.prod.template .env.prod
vim .env.prod  # или nano .env.prod
```

**Обязательно обновите:**

```bash
# Database
DATABASE_URL=postgresql://books_app:YOUR_STRONG_DB_PASSWORD@postgres:5432/books_app?schema=public

# JWT Secrets (сгенерируйте новые!)
JWT_ACCESS_SECRET=$(openssl rand -base64 32)
JWT_REFRESH_SECRET=$(openssl rand -base64 32)

# Домены
LOCAL_PUBLIC_BASE_URL=https://api.yourdomain.com/static
CORS_ORIGIN=https://yourdomain.com,https://app.yourdomain.com

# Администраторы
ADMIN_EMAILS=admin@yourdomain.com
CONTENT_MANAGER_EMAILS=editor@yourdomain.com

# PostgreSQL (обновите пароль)
POSTGRES_PASSWORD=YOUR_STRONG_DB_PASSWORD
```

**Безопасность файла:**

```bash
chmod 600 .env.prod
ls -la .env.prod
# Должно быть: -rw------- 1 deploy deploy
```

### 3.3 Первый деплой

```bash
# Проверка конфигурации
node check_prod_config.js

# Запуск деплоя
./scripts/deploy_production.sh --version main --force

# Мониторинг процесса
docker compose -f docker-compose.prod.yml logs -f app
```

**Что происходит при деплое:**

1. Создается бэкап текущего состояния
2. Обновляется код до нужной версии
3. Собирается Docker образ
4. Выполняются миграции базы данных
5. Перезапускаются сервисы
6. Выполняются проверки здоровья

### 3.4 Проверка деплоя

```bash
# Статус контейнеров
docker compose -f docker-compose.prod.yml ps

# Проверки API
curl http://localhost:5000/api/health/liveness
curl http://localhost:5000/api/health/readiness

# Комплексная проверка
./scripts/health_check.sh --detailed
```

---

## 🔒 ЭТАП 4: НАСТРОЙКА БЕЗОПАСНОСТИ

### 4.1 Автоматическая настройка безопасности

```bash
# Запуск скрипта безопасности
sudo ./scripts/setup_security.sh --production

# Проверка настроек
./scripts/test_security.sh
```

**Что настраивается:**

- SSH: отключение паролей, только ключи
- UFW Firewall: разрешены только 22, 80, 443 порты
- Fail2ban: защита от брутфорса
- Автоматические обновления безопасности
- Системные параметры безопасности

### 4.2 Настройка Caddy Reverse Proxy

```bash
# Установка и настройка Caddy
sudo ./scripts/install_caddy.sh --domain api.yourdomain.com

# Проверка HTTPS
curl -I https://api.yourdomain.com/api/health/liveness
```

**Caddy автоматически:**

- Получает SSL сертификат от Let's Encrypt
- Настраивает автоматическое обновление сертификатов
- Конфигурирует HSTS заголовки
- Скрывает внутренний порт 5000 от внешнего доступа

---

## 📊 ЭТАП 5: МОНИТОРИНГ И БЭКАПЫ

### 5.1 Настройка мониторинга

```bash
# Установка системы мониторинга
sudo ./scripts/setup_monitoring.sh --production

# Проверка компонентов
./scripts/test_monitoring.sh

# Доступ к Grafana
echo "Grafana: http://YOUR_SERVER_IP:3000"
echo "Логин: admin, Пароль: admin (смените при первом входе)"
```

**Что мониторится:**

- HTTP метрики приложения (response time, error rate, throughput)
- Системные метрики (CPU, RAM, диск, сеть)
- База данных (подключения, размер, производительность)
- Docker контейнеры (статус, ресурсы)

### 5.2 Настройка автоматических бэкапов

```bash
# Настройка расписания бэкапов
sudo ./scripts/setup_backup_cron.sh --daily --weekly --monthly

# Тестовый бэкап
./scripts/backup_database.sh daily

# Проверка бэкапов
./scripts/test_backup.sh

# Просмотр расписания
crontab -l
```

**Расписание бэкапов:**

- **Ежедневно в 02:00** - полный бэкап БД и файлов
- **Еженедельно в воскресенье 03:00** - архив недели
- **Ежемесячно 1-го числа в 04:00** - архив месяца
- **Автоматическая ротация** - хранится 14 дней (настраивается)

---

## 🔄 ЭТАП 6: CI/CD PIPELINE

### 6.1 Настройка GitHub Repository

**Добавьте Secrets в GitHub Repository Settings → Secrets and Variables → Actions:**

```
DEPLOY_SSH_KEY - ваш приватный SSH ключ для доступа к серверу
```

**Добавьте Variables:**

```
PRODUCTION_SERVER=YOUR_SERVER_IP_OR_DOMAIN
PRODUCTION_DOMAIN=api.yourdomain.com
```

### 6.2 Создание SSH ключа для деплоя

```bash
# На локальной машине - создайте отдельный ключ для CI/CD
ssh-keygen -t ed25519 -f ~/.ssh/deploy_key -C "ci-cd-deploy"

# Добавьте публичный ключ на сервер
ssh deploy@YOUR_SERVER_IP
echo "YOUR_PUBLIC_KEY_CONTENT" >> ~/.ssh/authorized_keys

# Скопируйте приватный ключ в GitHub Secrets
cat ~/.ssh/deploy_key
# Содержимое добавьте в DEPLOY_SSH_KEY secret
```

### 6.3 Тестирование CI/CD

```bash
# Создайте тестовый релиз
git tag v1.0.0
git push origin v1.0.0

# Или запустите вручную через GitHub Actions
# Repository → Actions → "Production Deployment" → Run workflow
```

**Процесс CI/CD:**

1. **Tests** - линтинг, типы, юнит и e2e тесты
2. **Build** - сборка Docker образа и push в GHCR
3. **Deploy** - автоматический деплой на сервер
4. **Verify** - проверки здоровья after деплоя
5. **Notify** - уведомления о статусе

---

## 👤 ЭТАП 7: СОЗДАНИЕ ПЕРВОГО АДМИНИСТРАТОРА

### 7.1 Регистрация администратора

Используйте email из переменной `ADMIN_EMAILS`:

```bash
# Пример регистрации через API
curl -X POST https://api.yourdomain.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@yourdomain.com",
    "password": "YourStrongPassword123!",
    "name": "Admin User"
  }'
```

### 7.2 Проверка роли

```bash
# Получение токена
curl -X POST https://api.yourdomain.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@yourdomain.com",
    "password": "YourStrongPassword123!"
  }'

# Проверка профиля (используйте полученный access_token)
curl https://api.yourdomain.com/api/admin/users/me \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

Должна быть роль `admin` в ответе.

---

## ✅ ЭТАП 8: ФИНАЛЬНАЯ ПРОВЕРКА

### 8.1 Комплексная проверка системы

```bash
# На сервере - проверка всех компонентов
./scripts/health_check.sh --url https://api.yourdomain.com --detailed --save health_report.json

# Проверка безопасности
./scripts/test_security.sh

# Проверка мониторинга
./scripts/test_monitoring.sh

# Проверка бэкапов
./scripts/test_backup.sh
```

### 8.2 Функциональные тесты

```bash
# API endpoints
curl https://api.yourdomain.com/api/health/liveness
curl https://api.yourdomain.com/api/health/readiness
curl https://api.yourdomain.com/api/books

# SSL и безопасность
curl -I https://api.yourdomain.com/api/docs  # должен быть 404
nmap -p 22,80,443 YOUR_SERVER_IP  # только эти порты открыты

# Проверка redirect HTTP → HTTPS
curl -I http://api.yourdomain.com/api/health/liveness
# Должен быть редирект 301 → https://
```

### 8.3 Нагрузочное тестирование

```bash
# Простой нагрузочный тест
ab -n 1000 -c 10 https://api.yourdomain.com/api/health/liveness

# Мониторинг во время нагрузки
htop  # системные ресурсы
docker stats  # ресурсы контейнеров
```

---

## 📱 ЭТАП 9: ИНТЕГРАЦИЯ С ФРОНТЕНДОМ

### 9.1 Подготовка API документации

```bash
# Генерация OpenAPI типов для фронтенда
yarn openapi:types:prod

# Файл будет создан в: libs/api-client/types.ts
```

### 9.2 Передача данных фронтенд команде

**Предоставьте фронтенд команде:**

```
API Base URL: https://api.yourdomain.com
OpenAPI Schema: https://api.yourdomain.com/api/docs-json (временно включить SWAGGER_ENABLED=1)
Types: libs/api-client/types.ts

CORS настроен для:
- https://yourdomain.com
- https://app.yourdomain.com
```

---

## 🚨 ПЛАН РЕАГИРОВАНИЯ НА ИНЦИДЕНТЫ

### Общие проблемы и решения

**Приложение недоступно:**

```bash
# 1. Проверка статуса
docker compose -f docker-compose.prod.yml ps
systemctl status docker

# 2. Перезапуск
docker compose -f docker-compose.prod.yml restart app

# 3. Логи
docker compose -f docker-compose.prod.yml logs app --tail 100
```

**База данных недоступна:**

```bash
# Проверка подключения
docker compose -f docker-compose.prod.yml exec postgres psql -U books_app -d books_app -c "SELECT 1;"

# Восстановление из бэкапа
./scripts/restore_database.sh
```

**Откат деплоя:**

```bash
# Автоматический откат
./scripts/deploy_production.sh --rollback

# Ручной откат к конкретной версии
./scripts/deploy_production.sh --version v1.0.0
```

### Контакты экстренной поддержки

- **Разработка:** [контакты команды]
- **DevOps:** [контакты DevOps инженера]
- **Системный администратор:** [контакты сисадмина]

---

## 📚 ДОПОЛНИТЕЛЬНАЯ ДОКУМЕНТАЦИЯ

### Созданные файлы и скрипты:

**Скрипты деплоя:**

- `scripts/setup_server.sh` - автоматическая настройка сервера
- `scripts/deploy_production.sh` - деплой приложения
- `scripts/health_check.sh` - проверка здоровья системы

**Конфигурация:**

- `.env.prod.template` - template переменных окружения
- `docker-compose.prod.yml` - production compose файл
- `.github/workflows/deploy.yml` - CI/CD pipeline

**Документация:**

- `docs/DEPLOYMENT_CHECKLIST.md` - чеклист деплоя
- `docs/DEPLOYMENT.md` - техническое руководство
- `/opt/books/SERVER_INFO.md` - информация о сервере (создается автоматически)

### Полезные команды:

```bash
# Мониторинг
docker compose -f docker-compose.prod.yml logs -f app
htop
df -h
systemctl status docker

# Бэкапы
./scripts/backup_database.sh daily
ls -la /opt/books/backups/

# Обновление
git pull origin main
./scripts/deploy_production.sh --version main

# Проверки
./scripts/health_check.sh --detailed
./scripts/test_security.sh
```

---

## 🎉 ГОТОВО!

Ваш Books App Backend успешно развернут в production!

**Что у вас есть:**

- ✅ Безопасный HTTPS API на домене api.yourdomain.com
- ✅ Автоматические бэкапы и мониторинг
- ✅ CI/CD pipeline для автоматических деплоев
- ✅ Система безопасности и защиты
- ✅ Готовность к интеграции с фронтендом

**Следующие шаги:**

1. Интегрируйте с фронтендом
2. Настройте алерты в Grafana
3. Добавьте дополнительные уведомления (Slack, email)
4. Проведите нагрузочное тестирование
5. Создайте процедуры для команды поддержки

**Поддержка:**
При возникновении вопросов обращайтесь к документации в `docs/` или к команде разработки.
