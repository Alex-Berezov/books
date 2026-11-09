import { BadRequestException, ConflictException } from '@nestjs/common';

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
  if (changed) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: RECORD_CHANGED,
      message,
    });
  }
}
