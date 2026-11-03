import { ConflictException, HttpException } from '@nestjs/common';
import { isRecord } from '../../shared/prisma/json-record.util';

/**
 * Код отказа ручки или сервиса (409/503 с `code` в теле, как у `llmTaskConflict` и `llmDisabled`);
 * без кода - `HTTP_<статус>`. Одна функция на модули, которые решают по коду отказа: ожидание досье
 * (`dossier/context-demand.ts`), автозапуск раздела (`F06-5`).
 */
export function httpCode(error: HttpException): string {
  const body = error.getResponse();
  const code = isRecord(body) ? body.code : null;
  return typeof code === 'string' && code ? code : `HTTP_${error.getStatus()}`;
}

/** 409 с кодом в теле: объект, а не строка - иначе кода не видно (как `llmDisabled`). */
export function llmTaskConflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, code });
}

/** Аренда задачи ушла другому владельцу: попытка не делается, результат не пишется. */
export class LlmTaskLeaseLostError extends Error {
  constructor(readonly taskId: string) {
    super(`LLM task ${taskId} lease lost`);
    this.name = 'LlmTaskLeaseLostError';
  }
}
