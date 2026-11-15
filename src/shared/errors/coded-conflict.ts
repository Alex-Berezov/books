import { ConflictException } from '@nestjs/common';

/**
 * 409 с кодом в теле: `{statusCode, error, message, code}` плюс поля `extra` (например, `current`
 * или `referencedBy`). Объект, а не строка: иначе кода в ответе не видно. Та же форма, что у
 * `llmTaskConflict` хода модели; без зависимости модулей данных от исполнителя LLM.
 */
export function codedConflict(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ConflictException {
  return new ConflictException({ ...extra, statusCode: 409, error: 'Conflict', message, code });
}
