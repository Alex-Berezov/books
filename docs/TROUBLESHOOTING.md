# Troubleshooting Guide

Руководство по решению распространённых проблем в проекте.

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

## Другие проблемы

_(Добавляйте сюда решения новых проблем по мере необходимости)_
