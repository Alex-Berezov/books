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

## Другие проблемы

_(Добавляйте сюда решения новых проблем по мере необходимости)_
