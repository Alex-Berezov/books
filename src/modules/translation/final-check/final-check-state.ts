import { Prisma } from '@prisma/client';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { metadataStateOf } from '../metadata/metadata-state';

/**
 * Состояние итоговой проверки языка (`TranslationRunLanguage.finalCheck`, `F05-6`, шаг 5; решение
 * арбитра `F05 | F05-6` о хранении): проверка кодом - один раз (`code`), модель - глава за шаг,
 * оплаченный ответ главы - в `chapters` вместе с находкой главы. Повтор шага после падения
 * читает их отсюда и модель не зовёт (`tech.md` §5). `null` в колонке - проверка не проводилась.
 */
export interface FinalCheckChapter {
  number: number;
  /** `empty` - перевод главы пуст (находка кода `CHAPTER_EMPTY`): читать модели нечего, вызова нет. */
  outcome: 'pass' | 'fail' | 'not_independent' | 'unavailable' | 'too_long' | 'invalid' | 'empty';
  /** Модель ответа; пусто - вызова не было или ответа по форме нет. */
  model: string;
  costUsd: string;
}

export interface FinalCheckState {
  /** Итог проверки кодом: главы исходника с текстом, которых нет среди глав перевода. */
  code: { missing: number[] } | null;
  chapters: FinalCheckChapter[];
  done: boolean;
}

/** Состояние из строки языка. Не той формы - `null`: проверка начинается с чистого. */
export function finalCheckStateOf(
  value: Prisma.JsonValue | null | undefined,
): FinalCheckState | null {
  if (!isRecord(value)) return null;
  const { code, chapters, done } = value;
  if (code !== null && !(isRecord(code) && Array.isArray(code.missing))) return null;
  if (!Array.isArray(chapters) || !chapters.every(isRecord) || typeof done !== 'boolean') {
    return null;
  }
  return value as unknown as FinalCheckState;
}

export const finalCheckStateJson = (state: FinalCheckState): Prisma.InputJsonValue =>
  state as unknown as Prisma.InputJsonValue;

/**
 * Итоговую проверку язык обходит: её нет, а этап `metadata` начат до неё (запуск шёл во время
 * выката, решение арбитра `F05 | F05-6`, 6c В6). Одно правило на шаг и отчёт.
 */
export function finalCheckBypassed(
  state: FinalCheckState | null,
  metadata: Prisma.JsonValue | null | undefined,
): boolean {
  return state === null && metadataStateOf(metadata) !== null;
}
