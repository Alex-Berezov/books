import { Prisma } from '@prisma/client';

/**
 * Условия на JSON-список, где пустое или отсутствующее значение значит «без ограничения»:
 * строка подходит, если списка нет, он пуст или содержит `value`. Сравнение точное -
 * регистр `value` приводит вызывающий под нормализацию при записи.
 */
export const jsonListAbsentOrContains = (value: string): Prisma.JsonNullableFilter[] => [
  { equals: Prisma.AnyNull },
  { equals: [] },
  { array_contains: [value] },
];
