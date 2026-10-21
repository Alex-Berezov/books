import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/** Окружение исполнителя (`F05-1w`); неверное значение - умолчание, а не падение старта. */
@Injectable()
export class LlmWorkerConfig {
  constructor(private readonly config: ConfigService) {}

  enabled(): boolean {
    return (this.config.get<string>('TRANSLATION_WORKER_ENABLED') ?? '1').trim() !== '0';
  }

  // Имя ключа - литералом в каждом чтении: `yarn check:env` сверяет имена с `.env.example`
  // и не разрешает имя, пришедшее переменной.
  concurrency(): number {
    return positiveInt(
      this.config.get<string>('TRANSLATION_WORKER_CONCURRENCY'),
      DEFAULT_CONCURRENCY,
    );
  }

  pollMs(): number {
    return positiveInt(this.config.get<string>('TRANSLATION_WORKER_POLL_MS'), DEFAULT_POLL_MS);
  }

  waitMs(): number {
    return positiveInt(this.config.get<string>('TRANSLATION_WORKER_WAIT_MS'), DEFAULT_WAIT_MS);
  }

  maxAttempts(): number {
    return positiveInt(
      this.config.get<string>('TRANSLATION_TASK_MAX_ATTEMPTS'),
      DEFAULT_MAX_ATTEMPTS,
    );
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const raw = Number(value);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}
