import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { isRecord } from '../../../shared/prisma/json-record.util';
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
  /**
   * Снимок названия, описания и автора исходника на момент принятия ответа (`metadataSourceHash`):
   * под замком создания черновика он сверяется с текущими полями (решения арбитра `F05 | F05-6`,
   * 6c В1 и /fix круг 2, В3).
   * Нет - ответ принят до `6c`, сверка полей пропускается.
   */
  sourceHash?: string;
}

/**
 * Отпечаток полей версии исходника, которые переводит этап сверх глав (название, описание,
 * автор): отпечаток исходника
 * (`sourceFingerprint`) считает только главы, а правка названия или описания уехала бы в черновик.
 */
export function metadataSourceHash(fields: {
  title: string;
  description: string;
  author: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([fields.title, fields.description, fields.author]))
    .digest('hex');
}

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
