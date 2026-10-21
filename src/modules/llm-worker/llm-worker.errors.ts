import { ConflictException } from '@nestjs/common';

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
