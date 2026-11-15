import { BadRequestException, ConflictException } from '@nestjs/common';
import { codedConflict } from '../errors/coded-conflict';

/** Код 409 ручной записи: запись изменили после того, как её видела вкладка. */
const RECORD_CHANGED = 'RECORD_CHANGED';

/** Что видела вкладка; поля те же, что у query, контроллер отдаёт его как есть. */
export interface ExpectedRow {
  expectedUpdatedAt?: string;
  expectedAbsent?: 'true';
}

export function assertExpectedRowShape(expected: ExpectedRow): void {
  if (expected.expectedAbsent && expected.expectedUpdatedAt) {
    throw new BadRequestException('expectedAbsent and expectedUpdatedAt are mutually exclusive');
  }
}

/** Вызывается под замком записи, после чтения строки и до записи; `existing` — текущая строка. */
export function assertRowAsExpected(
  existing: { updatedAt: Date } | null,
  expected: ExpectedRow,
  message: string,
): void {
  const changed = expected.expectedAbsent
    ? existing !== null
    : existing !== null &&
      expected.expectedUpdatedAt !== undefined &&
      existing.updatedAt.getTime() !== new Date(expected.expectedUpdatedAt).getTime();
  if (changed) throw recordChanged(message);
}

/** 409 `RECORD_CHANGED` — тот же ответ, что у `assertRowAsExpected`, для своих правил сверки. */
export function recordChanged(message: string): ConflictException {
  return codedConflict(RECORD_CHANGED, message);
}
