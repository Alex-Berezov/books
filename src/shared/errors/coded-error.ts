import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/**
 * 400 и 413 с кодом в теле (`F08-11d-3`): форма `{statusCode, error, message, code}` - та же, что
 * у 409 `codedConflict` (`./coded-conflict.ts`). Отказ файла ручки загрузки называется кодом
 * одинаково, разобрал его перехватчик формы (413) или проверка байтов (400).
 */
export function codedBadRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', message, code });
}

export function codedPayloadTooLarge(code: string, message: string): PayloadTooLargeException {
  return new PayloadTooLargeException({
    statusCode: 413,
    error: 'Payload Too Large',
    message,
    code,
  });
}
