import { BookType, Language } from '@prisma/client';

/**
 * Описание и обложка не обязательны, и послабление сделано через `@ValidateIf`. Ложное условие
 * снимает **все** валидаторы поля разом, поэтому слишком широкое условие тихо снимает и проверку
 * типа: нестроковое значение доезжает до Prisma и отвечает пятисоткой вместо 400. Спеки на этом
 * теле сторожат ровно границу послабления через `dtoFieldErrors` (`src/common/testing`).
 */
export const versionPayload = (overrides: Record<string, unknown>) => ({
  language: Language.en,
  title: 'Title',
  author: 'Author',
  type: BookType.text,
  isFree: true,
  ...overrides,
});
