import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BookType, Language } from '@prisma/client';

/**
 * Описание и обложка не обязательны, и послабление сделано через `@ValidateIf`. Ложное условие
 * снимает **все** валидаторы поля разом, поэтому слишком широкое условие тихо снимает и проверку
 * типа: нестроковое значение доезжает до Prisma и отвечает пятисоткой вместо 400. Проверки ниже
 * сторожат ровно границу послабления и повторяют настройки боевого `ValidationPipe` (`main.ts`).
 */
export const contentFieldErrors = <T extends object>(
  dto: new () => T,
  payload: Record<string, unknown>,
): string[] => {
  const instance = plainToInstance(dto, payload, { enableImplicitConversion: false });
  return validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((error) => error.property);
};

export const versionPayload = (overrides: Record<string, unknown>) => ({
  language: Language.en,
  title: 'Title',
  author: 'Author',
  type: BookType.text,
  isFree: true,
  ...overrides,
});
