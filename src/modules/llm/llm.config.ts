import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_CALL_TIMEOUT_MS = 180_000;

/**
 * Окружение модуля LLM. Ключ читается **на каждый вызов**, а не в конструкторе: e2e включает
 * и выключает его между приложениями, а пустая строка значит «ключа нет» так же, как его
 * отсутствие (Р25).
 *
 * 🔴 Сам ключ из этого класса наружу уходит только в заголовок запроса к OpenRouter - ни
 * в журнал вызовов, ни в логи, ни в ответы ручек.
 */
@Injectable()
export class LlmConfig {
  constructor(private readonly config: ConfigService) {}

  apiKey(): string | null {
    const key = this.config.get<string>('OPENROUTER_API_KEY')?.trim();
    return key ? key : null;
  }

  enabled(): boolean {
    return this.apiKey() !== null;
  }

  baseUrl(): string {
    const url = this.config.get<string>('OPENROUTER_BASE_URL')?.trim();
    return (url || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  callTimeoutMs(): number {
    const raw = Number(this.config.get<string>('LLM_CALL_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CALL_TIMEOUT_MS;
  }
}
