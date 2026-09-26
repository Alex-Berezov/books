import { Prisma } from '@prisma/client';

/**
 * Разбор `Json?`-колонки, задуманной как `string[]` (комментарий рядом с полем
 * в `schema.prisma`), на чтении. Без него ответ типизируется `unknown`, и
 * `check:response-schema` держит маршрут в ратчете «непроверяемых» (`LEGACY-417`):
 * начни сервис класть туда объект вместо массива строк — сторож это не заметит.
 *
 * `null`/`undefined` — поле не заполнено, отдаём `null`: колонка не заполнялась
 * вовсе, и это отличается от «заполнена, но пуста». Не массив — тоже `null`,
 * тем же поводом. Элементы внутри массива фильтруются, а не роняют результат
 * целиком: тот же приём, каким эта же колонка уже читается в двух других
 * местах (`book.service.ts` `toSlugArray`, `rights-license-interface.ts`
 * `toStringArray`) — одна испорченная запись не должна прятать остальные
 * валидные слаги списка.
 */
export const parseJsonStringArray = (
  value: Prisma.JsonValue | null | undefined,
): string[] | null => {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
};
