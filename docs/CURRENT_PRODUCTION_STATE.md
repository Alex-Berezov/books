## 📊 Current Production State - bibliaris.com

> Документация текущего состояния production сервера bibliaris.com
>
> **Дата создания:** 2025-09-28  
> **Последнее обновление:** 2025-09-28 11:45 UTC  
> **Статус:** ✅ ДИАГНОСТИКА ЗАВЕРШЕНА - Основные проблемы исправленыurrent Production State - bibliaris.com

> Документация текущего состояния production сервера bibliaris.com
>
> **Дата создания:** 2025-09-28  
> **Статус:** В процессе диагностики

## 🏗️ Текущая архитектура

### Сервер

- **IP:** 209.74.88.183
- **ОС:** Ubuntu 24.04.3 LTS
- **Пользователь деплоя:** deploy
- **SSH доступ:** `ssh deploy@209.74.88.183`

### Домен и DNS

- **Основной домен:** bibliaris.com
- **Текущая настройка DNS:** Namecheap URL Forward на www.bibliaris.com
- **Проблема:** Домен не направлен напрямую на сервер, используется redirect

### Сервисы (Docker)

#### Приложение Books App

- **Контейнер:** src-app-1 (books-app:prod)
- **Статус:** ✅ HEALTHY (исправлен healthcheck)
- **Порты:** 0.0.0.0:5000->5000/tcp
- **Доступность:**
  - ✅ Локально: `http://localhost:5000/api/health/liveness` (HTTP 200)
  - ✅ Метрики: `http://localhost:5000/api/metrics` (HTTP 200)
  - ❌ Внешне: нет доступа через домен (требует reverse proxy)

#### База данных PostgreSQL

- **Контейнер:** src-postgres-1 (postgres:14)
- **Статус:** Запущен 26+ часов, HEALTHY
- **Порты:** 0.0.0.0:5432->5432/tcp

### Файловая система

```
/opt/books/
├── app/          # Код приложения (нужно проверить содержимое)
├── backups/      # Каталог для бэкапов
├── logs/         # Логи приложения
├── postgres/     # Данные PostgreSQL
└── uploads/      # Загруженные файлы
```

### Сетевые порты (активные)

| Порт | Сервис     | Статус                 |
| ---- | ---------- | ---------------------- |
| 22   | SSH        | ✅ Работает            |
| 5000 | Books App  | ✅ Локально, ❌ Внешне |
| 5432 | PostgreSQL | ✅ Работает            |
| 80   | HTTP       | ❌ Не слушается        |
| 443  | HTTPS      | ❌ Не слушается        |

## ❌ Выявленные проблемы

### ✅ ПРОБЛЕМА РЕШЕНА: Docker Container Status

**Найдена и исправлена проблема с healthcheck:**

1. **Проблема была в конфигурации healthcheck**:
   - Healthcheck пытался обратиться к `/metrics` (404 Not Found)
   - Но приложение доступно по пути `/api/metrics` (200 OK)
   - В `docker-compose.prod.yml` была указана неправильная конфигурация

2. **Выполненное исправление**:

   ```bash
   # Создана резервная копия
   cp docker-compose.prod.yml docker-compose.prod.yml.backup

   # Исправлен путь в healthcheck
   sed -i 's|http://localhost:5000/metrics|http://localhost:5000/api/metrics|g' docker-compose.prod.yml

   # Пересоздан контейнер
   docker compose -f docker-compose.prod.yml up -d --force-recreate app
   ```

3. **Результат**:
   - Контейнер `src-app-1` теперь имеет статус `(healthy)` ✅
   - API полностью функциональный и доступный
   - Мониторинг работает корректно

### 2. Нет reverse proxy

- Приложение доступно только на localhost:5000
- Нет автоматического HTTPS (Let's Encrypt)
- Порты 80/443 не слушаются

### 3. DNS конфигурация

- Домен bibliaris.com использует Namecheap URL Forward
- Нет прямого A-record на IP сервера 209.74.88.183

### 4. Неправильная конфигурация портов

- Приложение настроено на PORT=3000 в `.env.prod`
- Но контейнер слушает порт 5000
- Healthcheck проверяет `/metrics` на localhost:5000

### 5. Устаревший код

- Код в `/opt/books/app/src/` - старая версия
- Нет новых скриптов деплоя и мониторинга

## 🎯 План исправления

### Этап 1: Диагностика приложения

- [ ] Найти docker-compose файлы
- [ ] Проверить логи приложения
- [ ] Выяснить причину unhealthy статуса
- [ ] Проверить конфигурацию healthcheck

### Этап 2: Настройка DNS

- [ ] Изменить DNS записи в Namecheap
- [ ] Создать A-record: bibliaris.com → 209.74.88.183
- [ ] Убрать URL Forward

### Этап 3: Настройка reverse proxy

- [ ] **Установить и настроить Caddy** - СЛЕДУЮЩИЙ ШАГ
- [ ] Настроить автоматический HTTPS
- [ ] Проксировать bibliaris.com → localhost:5000

### Этап 4: Исправление приложения

- [x] **Исправить healthcheck** - ✅ РЕШЕНО
- [x] **Обновить переменные окружения для домена bibliaris.com** - ✅ РЕШЕНО
- [ ] Перезапустить контейнеры

### Этап 5: Мониторинг и бэкапы

- [ ] Настроить систему мониторинга
- [ ] Настроить автоматические бэкапы
- [ ] Настроить алерты

## 📋 Команды для диагностики

### Проверить содержимое приложения

```bash
cd /opt/books/app && ls -la
```

### Найти docker-compose файлы

```bash
find /opt/books -name "docker-compose*" 2>/dev/null
```

### Проверить логи

```bash
docker logs src-app-1 --tail 50
docker logs src-postgres-1 --tail 20
```

### Проверить конфигурацию контейнеров

```bash
docker inspect src-app-1 | jq '.[0].Config.Healthcheck'
docker inspect src-app-1 | jq '.[0].Config.Env'
```

---

**Обновления документа:**

- 2025-09-28: Создан документ, проведена первичная диагностика
- TODO: Дополнить после получения логов и поиска docker-compose файлов
