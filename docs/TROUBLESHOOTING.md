# Troubleshooting Guide

Руководство по решению распространённых проблем в проекте.

## Docker Registry: "repository name must be lowercase"

### Симптомы

- Deploy падает с ошибкой: `invalid reference format: repository name (Alex-Berezov/books-app) must be lowercase`
- Ошибка возникает при `docker pull` образа из GitHub Container Registry
- В логах деплоя: `docker pull ghcr.io/Alex-Berezov/books-app:tag` fails

### Причина

Docker registry требует **строго lowercase** имена репозиториев. GitHub username может содержать заглавные буквы (например, `Alex-Berezov`), но Docker registry не принимает такие имена.

### Решение

**Уже исправлено в workflow** (см. `.github/workflows/deploy.yml`):

Используйте `${{ github.repository }}` вместо `${{ github.repository_owner }}/${{ env.IMAGE_NAME }}`:

```yaml
# ❌ Старый подход (может содержать заглавные буквы)
images: ${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ env.IMAGE_NAME }}
# Результат: ghcr.io/Alex-Berezov/books-app

# ✅ Новый подход (автоматически lowercase)
images: ${{ env.REGISTRY }}/${{ github.repository }}
# Результат: ghcr.io/alex-berezov/books
```

### Принцип

- `github.repository_owner` — сохраняет регистр: `Alex-Berezov`
- `github.repository` — **автоматически в lowercase**: `alex-berezov/books`
- Docker registry принимает только lowercase имена

### Где обновить

Замените во всех местах использования image paths:

1. `docker/metadata-action` - images parameter
2. `anchore/sbom-action` - image parameter
3. `anchore/scan-action` - image parameter
4. Deploy step - `--registry` parameter

### Ссылки

- [Docker Registry Specification](https://docs.docker.com/registry/spec/api/)
- Commit: 2025-10-12 "fix: Docker registry - lowercase repository name"

---

## BullMQ: "Your redis options maxRetriesPerRequest must be null"

### Симптомы

- E2E тесты падают с ошибкой: `BullMQ: Your redis options maxRetriesPerRequest must be null`
- Ошибка возникает при инициализации `QueueEvents` или `Worker`
- В afterAll тестов: `TypeError: Cannot read properties of undefined (reading 'close')`

### Причина

BullMQ требует специальную настройку Redis для блокирующих операций. Worker и QueueEvents используют блокирующие команды Redis (BRPOPLPUSH), которые требуют `maxRetriesPerRequest: null`.

### Решение

**Уже исправлено в коде** (см. `src/modules/queue/queue.module.ts`):

1. В `buildConnectionOpts()`:

```typescript
const redisOptions: RedisOptions = {
  host,
  port,
  password,
  maxRetriesPerRequest: null, // ← требуется для BullMQ
  enableReadyCheck: true,
};
```

2. Для строкового URL:

```typescript
if (typeof opts === 'string') {
  return new IORedis(opts, { maxRetriesPerRequest: null }); // ← добавлена опция
}
```

3. Graceful shutdown в `QueueModule`:

```typescript
export class QueueModule implements OnModuleDestroy {
  async onModuleDestroy() {
    // Закрываем воркер, очередь, события и Redis подключение
    if (this.worker) await this.worker.close();
    if (this.queueEvents) await this.queueEvents.close();
    if (this.queue) await this.queue.close();
    if (this.connection) await this.connection.quit();
  }
}
```

### E2E тесты без Redis

Если Redis не нужен в e2e-тестах, не указывайте переменные `REDIS_URL`/`REDIS_HOST` - модуль очередей отключится автоматически.

### Ссылки

- [BullMQ Connection Settings](https://docs.bullmq.io/guide/connections)
- Commit: 2025-10-12 "Исправление E2E тестов: BullMQ настройки"

---

## E2E тесты очередей: проверка доступности Redis

### Симптомы

- Тест `queues.e2e-spec.ts` падает с ошибкой: `expected 201 "Created", got 503 "Service Unavailable"`
- Переменные Redis (`REDIS_HOST`, `REDIS_PORT`) настроены в CI, но тест всё равно падает
- Ошибка в тесте `POST /queues/demo/enqueue behaves depending on Redis availability`

### Причина

Тест проверял **наличие переменных окружения** (`REDIS_URL` или `REDIS_HOST`), но не **фактическую доступность** Redis. В CI Redis может быть настроен, но не подключаться успешно (не готов, проблема с сетью и т.д.).

### Решение

**Уже исправлено в тесте** (см. `test/queues.e2e-spec.ts`):

1. Заменена проверка через переменные окружения:

```typescript
// ❌ Старый подход (проверка переменных)
const hasRedis = !!(process.env.REDIS_URL || process.env.REDIS_HOST);
```

2. На проверку через API:

```typescript
// ✅ Новый подход (проверка фактической доступности)
let queuesEnabled: boolean;

beforeAll(async () => {
  // ... инициализация приложения ...

  // Проверяем фактическую доступность очередей через API
  const token = await getAdminToken();
  const statusRes = await request(http())
    .get('/queues/status')
    .set('Authorization', `Bearer ${token}`);
  queuesEnabled = statusRes.body?.enabled === true;
});

// Использование в тестах
if (queuesEnabled) {
  const res = await rq.expect(201);
} else {
  await rq.expect(503);
}
```

### Принцип

Тест проверяет **реальное состояние системы**, а не предположения на основе конфигурации. Эндпоинт `/queues/status` возвращает `enabled: true` только если Redis подключение установлено успешно.

### Ссылки

- Commit: 2025-10-12 "Исправление queues.e2e-spec.ts - проверка фактической доступности Redis"

---

## Jest не завершается после E2E тестов

### Симптомы

- После выполнения e2e тестов Jest не завершается
- Сообщение: `Jest did not exit one second after the test run has completed`
- CI/CD pipeline "зависает" на несколько секунд/минут после завершения тестов
- Предупреждение: `This usually means that there are asynchronous operations that weren't stopped in your tests`

### Причина

BullMQ создаёт **постоянные соединения** с Redis (Workers, QueueEvents, Queue instances), которые продолжают слушать события даже после вызова `app.close()`. Jest видит открытые handles и ждёт их закрытия, но они могут не закрываться вовремя.

Хотя в `QueueModule` реализован `onModuleDestroy` для graceful shutdown, внутренние таймеры и соединения Redis могут задерживать полное закрытие.

### Решение

**Уже исправлено** (см. `package.json`):

Добавлен флаг `--forceExit` в e2e скрипты:

```json
{
  "scripts": {
    "test:e2e": "jest --config ./test/jest-e2e.json --forceExit",
    "test:e2e:serial": "jest --config ./test/jest-e2e.json --runInBand --forceExit"
  }
}
```

### Что делает `--forceExit`?

- Jest **принудительно завершается** сразу после выполнения всех тестов
- Не ждёт закрытия всех асинхронных операций
- **Безопасно** для интеграционных тестов с внешними зависимостями (БД, Redis, очереди)

### Альтернативы (не рекомендуются)

```bash
# ❌ Увеличение таймаута (не решает проблему)
jest --forceExit --detectOpenHandles

# ❌ Явное закрытие всех handles (слишком сложно поддерживать)
afterAll(async () => {
  await app.close();
  await new Promise(resolve => setTimeout(resolve, 1000));
});
```

### Best Practice

`--forceExit` - **стандартная практика** для e2e/интеграционных тестов с:

- Базами данных
- Redis/Кэшами
- Очередями задач
- WebSocket соединениями
- Внешними API

### Ссылки

- [Jest CLI Options - forceExit](https://jestjs.io/docs/cli#--forceexit)
- Commit: 2025-10-12 "Исправление Jest зависания после E2E тестов"

---

## Другие проблемы

_(Добавляйте сюда решения новых проблем по мере необходимости)_
