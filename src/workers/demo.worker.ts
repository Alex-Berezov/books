/*
 Standalone BullMQ demo worker process.
 Usage (dev): yarn worker:demo
 Configure Redis via REDIS_URL or REDIS_HOST/REDIS_PORT/REDIS_PASSWORD.
*/
import { config as dotenv } from 'dotenv';
import { Worker, WorkerOptions } from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';

dotenv({ path: '.env' });

function buildRedisOptions(): RedisOptions | string {
  const url = process.env.REDIS_URL;
  if (url && url.trim().length > 0) return url;
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = Number(process.env.REDIS_PORT || '6379');
  const password = process.env.REDIS_PASSWORD || undefined;
  return { host, port, password, maxRetriesPerRequest: 2, enableReadyCheck: true };
}

function main(): void {
  const queueName = process.env.BULLMQ_DEMO_QUEUE || 'demo';
  const concurrency = Number(process.env.BULLMQ_DEMO_CONCURRENCY || '2');
  const logLevel = (process.env.BULLMQ_WORKER_LOG_LEVEL || 'info').toLowerCase();
  const shutdownTimeoutMs = Number(process.env.BULLMQ_WORKER_SHUTDOWN_TIMEOUT_MS || '5000');
  const redisOpts = buildRedisOptions();
  const connection =
    typeof redisOpts === 'string' ? new IORedis(redisOpts) : new IORedis(redisOpts);
  const opts: WorkerOptions = { connection, concurrency };

  // Simple processor mirrors in-process demo worker
  const worker = new Worker<{ delayMs?: number }>(
    queueName,
    async (job) => {
      const ms = Number(job.data?.delayMs ?? 10);
      await new Promise((r) => setTimeout(r, ms));
      return { ok: true, at: new Date().toISOString() };
    },
    opts,
  );

  const shouldLog = (level: 'debug' | 'info' | 'warn' | 'error'): boolean => {
    const order: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
    const cur = order[logLevel] ?? 20;
    return order[level] >= cur;
  };

  worker.on('ready', () => {
    if (shouldLog('info')) console.log(`[worker] ${queueName} ready (concurrency=${concurrency})`);
  });
  worker.on('completed', (job) => {
    if (shouldLog('debug')) console.debug(`[worker] completed job ${job.id}`);
  });
  worker.on('failed', (job, err) => {
    if (shouldLog('error')) console.error(`[worker] failed job ${job?.id}:`, err);
  });

  const shutdown = async () => {
    if (shouldLog('info')) console.log('[worker] shutting down...');
    const timer = setTimeout(() => {
      // Forced exit if shutdown takes too long
      console.error(`[worker] forced exit after ${shutdownTimeoutMs}ms`);
      process.exit(1);
    }, shutdownTimeoutMs);
    try {
      await worker.close();
      await connection.quit();
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main();
