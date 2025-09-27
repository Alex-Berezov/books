# Handoff: Deployment Debug Session (Backend / Docker) – Current State & Next Steps

Дата: 2025-09-27
Контекст: Настраиваем прод-развёртывание NestJS (Node 22, Prisma, PostgreSQL) через Docker Compose на VPS. База и миграции работают, приложение не стартует из-за проблемы с путём к `main.js`.

## 1. Что уже сделано

- VPS подготовлен (пользователь `deploy`, Docker установлен, группы настроены).
- Репозиторий склонирован в `/opt/books/app/src`.
- Создан `.env` (DATABASE_URL, JWT, др.). Postgres контейнер успешно поднимается.
- Миграции Prisma применяются в контейнере (`23 migrations ... No pending migrations`).
- Dockerfile упрощён (двухстадийная сборка: builder + runner) и временно убрана жёсткая проверка `--frozen-lockfile`.
- Добавлен `bash` в образ (entrypoint требовал).
- Добавлен/обновлён `.dockerignore` (уменьшен контекст).
- Обновили (ЛОКАЛЬНО в репозитории разработки) `scripts/docker-entrypoint.sh`, чтобы он:
  - Ждал базу
  - Выполнял `prisma migrate deploy`
  - ИСКАЛ `dist/main.js` или `dist/src/main.js` (fallback) – НО эта версия, судя по логам, на сервер НЕ попала.

## 2. Текущая проблема

Контейнер `app` циклически перезапускается с ошибкой:

```
Error: Cannot find module '/app/dist/main.js'
```

При этом реальный скомпилированный файл существует как: `dist/src/main.js` (проверено через однократный запуск образа с `--entrypoint sh`).

## 3. Почему так происходит

### 3.1 Несоответствие путей

Nest build положил результат в `dist/src/main.js`, а entrypoint (который реально исполняется в контейнере) по‑прежнему пытается запускать `dist/main.js` (старая версия скрипта без fallback).

### 3.2 Версия entrypoint не обновилась в образе

Несмотря на локальное изменение файла (в рабочей среде ассистента), на сервере в каталоге `/opt/books/app/src/scripts/docker-entrypoint.sh` вероятно осталась старая версия. При сборке образа копируется именно она.

### 3.3 Причина размещения `main.js` в `dist/src/`

TypeScript компиляция сохраняет вложенность каталогов, т.к. не задан `rootDir`. В типичной Nest конфигурации `dist/main.js` получается, если `rootDir` = `src`.

## 4. Что уже пробовали исправить

- Пересборка образа с `--no-cache` – не помогло, т.к. внутрь попадает старый entrypoint.
- Добавлен fallback в entrypoint (но изменение не донесено до сервера).
- Подтверждено наличие `dist/src/main.js` внутри образа.

## 5. Подтверждения (артефакты)

- Логи запуска: миграции успешны, сразу после этого ошибка `Cannot find module '/app/dist/main.js'` без строки о старте через fallback.
- Список файлов в образе показал `dist/src/main.js`.

## 6. Гипотезы

| Гипотеза                                | Статус | Комментарий                                                                                          |
| --------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| Образ использует старый entrypoint      | HIGH   | Нет ожидаемого лога "Starting app using dist/src/main.js".                                           |
| Сборка кешировала старый файл           | LOW    | Была сборка с `--no-cache`, но если в исходниках на сервере файл не обновлён, поведение закономерно. |
| Nest CLI конфигурация требует `rootDir` | HIGH   | Добавление `rootDir: "src"` в `tsconfig.json` даст `dist/main.js`.                                   |
| Ошибка копирования dist                 | LOW    | Файл присутствует (в подкаталоге).                                                                   |
| Проблема с правами/exec                 | LOW    | Ошибка именно module not found.                                                                      |

## 7. Варианты решения

### Вариант A (минимальный быстрый фикс)

Обновить entrypoint на сервере, чтобы запускал `dist/src/main.js` (или fallback).

### Вариант B (привести структуру к стандартной)

Добавить в `tsconfig.json`:

```json
"rootDir": "src"
```

Затем пересобрать. Это создаст `dist/main.js` и можно вернуть простой entrypoint.

### Вариант C (жёстко указать CMD)

Во временных целях изменить `Dockerfile`:

```
CMD ["node", "dist/src/main.js"]
```

(Но лучше починить entrypoint или структуру.)

Рекомендуемый порядок: A → (опционально) B для унификации.

## 8. Что сделать СЛЕДУЮЩЕМУ агенту (чек‑лист)

1. Проверить содержимое скрипта внутри работающего контейнера/образа:
   ```bash
   docker run --rm --entrypoint sh books-app:prod -c 'sed -n "1,120p" /usr/local/bin/docker-entrypoint.sh'
   ```
2. Сравнить с ожидаемой обновлённой версией (должны быть строки с поиском `dist/src/main.js`).
3. Если в репозитории на сервере файл старый – обновить:
   - Открыть `/opt/books/app/src/scripts/docker-entrypoint.sh`
   - Внести блок:
     ```bash
     if [ -f dist/main.js ]; then APP_MAIN=dist/main.js; elif [ -f dist/src/main.js ]; then APP_MAIN=dist/src/main.js; else ... fi
     exec node "$APP_MAIN"
     ```
4. Пересобрать образ без кеша:
   ```bash
   cd /opt/books/app/src
   docker compose -f docker-compose.prod.yml build --no-cache app
   docker compose -f docker-compose.prod.yml up -d app
   docker compose -f docker-compose.prod.yml logs -f app | head -n 60
   ```
5. Убедиться в логе: `[entrypoint] Starting app using dist/src/main.js`.
6. Проверить доступность приложения (порт, healthcheck `/metrics`).
7. (Опционально) Добавить `rootDir` в `tsconfig.json`, затем повторить сборку и упростить entrypoint до `node dist/main.js`.
8. После стабилизации:
   - Вернуть оптимизацию прод-зависимостей (прод стадия: `yarn install --production=true` + prune).
   - Восстановить `--frozen-lockfile` после синхронизации `yarn.lock`.
   - Настроить reverse proxy (Caddy/Nginx), HTTPS, мониторинг.

## 9. Риски / Замечания

- Текущее отсутствие `rootDir` может влиять на пути sourcemap'ов.
- DevDependencies включены в рантайм образ → лишний размер.
- Нет автоматической проверки успешности запуска приложения до публикации (CI gap).
- Повторяющиеся рестарты увеличивают шум в логах и время миграций (они каждый раз прогоняются).

## 10. Предлагаемая будущая оптимизация (после фикса старта)

- Многостадийный Dockerfile: builder → prune dev deps → tiny runtime (distroless или node:slim + dumb-init).
- Healthcheck script (проверка HTTP 200 на `/metrics` или `/health`).
- Добавить `rootDir` и пересобрать для единообразия с типичными Nest проектами.
- Включить Sentry/прометеевские метрики в проверку.

## 11. Быстрая проверка успешного старта (ожидаемые признаки)

- Лог содержит: `[entrypoint] Starting app using dist/src/main.js`.
- `docker compose ps` показывает `app` в состоянии `Up` (без перезапусков).
- `curl -I http://localhost:5000/` возвращает 200/3xx.
- `curl -I http://localhost:5000/metrics` возвращает 200 (Prometheus endpoint).

## 12. Минимальный патч для entrypoint (если вдруг потерян)

```bash
#!/usr/bin/env bash
set -euo pipefail
# ... ожидание БД и prisma migrate deploy ...
APP_MAIN=""
if [ -f dist/main.js ]; then
  APP_MAIN="dist/main.js"
elif [ -f dist/src/main.js ]; then
  APP_MAIN="dist/src/main.js"
else
  echo "[entrypoint] ERROR: main.js not found" >&2
  ls -R dist || true
  exit 1
fi
echo "[entrypoint] Starting app using $APP_MAIN"
exec node "$APP_MAIN"
```

## 13. Коротко (TL;DR)

Артефакт сборки лежит в `dist/src/main.js`, но контейнер запускает старый скрипт, который ищет `dist/main.js`. Нужно либо обновить entrypoint в репо на сервере, либо изменить структуру сборки (добавить `rootDir: src`), либо временно задать CMD на `node dist/src/main.js`. После фикса — оптимизация образа и инфраструктуры.

---

Конец handoff. Следующий агент начинает с пункта 1 чек-листа.
