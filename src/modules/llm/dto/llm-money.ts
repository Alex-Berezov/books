import { Prisma } from '@prisma/client';

/**
 * Сумма в долларах: строка или число, не отрицательная, до восьми знаков после точки и не
 * больше колонки `Decimal(14,8)` (решение арбитра `F05 | F05-1`, В2). Число приводится
 * к строке сразу, дальше арифметика только в Decimal.
 */
export const MONEY_PATTERN = /^\d{1,6}(\.\d{1,8})?$/;
// `toFixed()` без аргумента у Decimal - без экспоненты: число 0.00000001 не станет '1e-8'.
export const toMoneyString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' && Number.isFinite(value) ? new Prisma.Decimal(value).toFixed() : value;
// `@IsOptional` пропускает и null: деньги null не принимают - 400, а не 500 на `new Decimal(null)`.
export const notUndefined = (_: object, value: unknown) => value !== undefined;

/** В документации - строка; число тоже принимается и приводится к строке. */
export const MONEY_DOC = { type: String, format: 'decimal', example: '100' } as const;

/** Деньги в ответе - строка с восемью знаками (В2): одна функция на все ответы конвейера. */
export function moneyUsd(value: Prisma.Decimal): string {
  return value.toFixed(8);
}
