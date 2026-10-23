import { Prisma } from '@prisma/client';
import { MetadataResult } from './metadata-check';

/**
 * Состояние этапа `metadata` языка (`TranslationRunLanguage.metadata`, `F05-6`): каждый платный
 * ответ - попыткой со стоимостью до решения шага, принятый - в `result`. Повтор шага после падения
 * читает его отсюда и модель не зовёт (`tech.md` §5; решение арбитра `F05 | F05-6` о хранении).
 */
export interface MetadataAttempt {
  /** Модель, давшая ответ; пусто - ответа по форме не было. */
  model: string;
  costUsd: string;
  outcome: 'pass' | 'fail' | 'invalid';
  /** Замечания проверки - на повтор этапа. */
  remarks: string[];
}

export interface MetadataState {
  attempts: MetadataAttempt[];
  result: MetadataResult | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Состояние из строки языка. Не той формы - `null`: этап начинается с чистого. */
export function metadataStateOf(value: Prisma.JsonValue | null | undefined): MetadataState | null {
  if (!isRecord(value)) return null;
  const { attempts, result } = value;
  if (!Array.isArray(attempts) || !attempts.every(isRecord)) return null;
  if (result !== null && !isRecord(result)) return null;
  return value as unknown as MetadataState;
}

export const metadataStateJson = (state: MetadataState): Prisma.InputJsonValue =>
  state as unknown as Prisma.InputJsonValue;

/** Неудачных попыток этапа: принятый ответ закрывает этап раньше, чем их станет больше. */
export function metadataFailures(state: MetadataState): number {
  return state.attempts.filter((a) => a.outcome !== 'pass').length;
}

/** Замечания последней неудачной попытки - на повтор этапа. */
export function metadataRemarks(state: MetadataState): string[] {
  return state.attempts.at(-1)?.remarks ?? [];
}
