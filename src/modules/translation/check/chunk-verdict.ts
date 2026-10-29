import { Prisma } from '@prisma/client';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { REVIEWER_REMARK_MAX_CHARS, REVIEWER_REMARKS_MAX } from './check.constants';
import { MechanicalResult } from './mechanical-check';
import { SemanticAnswer, seedOf } from './semantic-check';

/**
 * Вердикт проверок куска - `TranslationChunk.verdict` (`F05-5`; решение арбитра `F05 | F05-5`:
 * без миграции, одной формой с проверкой при чтении). Пусто - кусок не проверялся.
 *
 * Попытка - один перевод куска и его проверка. Текущая (последняя) копит шаги до решения:
 * перевод пишет `translateCostUsd`, Jev - `jev`, сверка смысла - `semantic` вместе с исходом.
 */

export type JevOutcome =
  | { kind: 'answered'; language: string; model: string; costUsd: string }
  /** Этап выключен - не звался. */
  | { kind: 'disabled' }
  /**
   * Вызов отказал не по деньгам и не по остановке: этап пропущен с пометкой (карточка, шаг 5).
   * `costUsd` - оплаченные ответы не по форме (В7), у отказа без ответа его нет.
   */
  | { kind: 'skipped'; code: string; costUsd?: string };

export type AttemptOutcome =
  | 'pass'
  | 'fail'
  | 'not_independent'
  | 'unavailable'
  | 'too_long'
  | 'invalid';

export interface CheckAttempt {
  /**
   * Модель, фактически переведшая кусок в этой попытке (после перехода по 429 тоже); пусто -
   * ответ не по форме, модель неизвестна.
   */
  translatedBy: string;
  translateCostUsd: string;
  mechanical?: MechanicalResult;
  jev?: JevOutcome;
  semantic?: { model: string; costUsd: string; answer: SemanticAnswer | null };
  outcome?: AttemptOutcome;
}

export interface ChunkVerdict {
  /** Сид выбора предложений сверки смысла: повтор шага выбирает те же (карточка, шаг 4). */
  seed: number;
  /** Неудач проверки; на `CHECK_FAILURES_MAX` - флаг. */
  failures: number;
  /** Замечания последней неудачи - в промпт перевода заново (`reviewerRemarks`). */
  remarks: string[];
  attempts: CheckAttempt[];
}

/**
 * Вердикт из строки куска. Не той формы (кусок `F05-4` с пустым вердиктом, ручная правка) -
 * `null`: проверка начинается с чистого.
 */
export function verdictOf(value: Prisma.JsonValue | null | undefined): ChunkVerdict | null {
  if (!isRecord(value)) return null;
  const { seed, failures, remarks, attempts } = value;
  if (typeof seed !== 'number' || typeof failures !== 'number') return null;
  if (!Array.isArray(remarks) || !remarks.every((r) => typeof r === 'string')) return null;
  if (!Array.isArray(attempts) || !attempts.every(isRecord)) return null;
  return value as unknown as ChunkVerdict;
}

export const verdictJson = (verdict: ChunkVerdict): Prisma.InputJsonValue =>
  verdict as unknown as Prisma.InputJsonValue;

/** Вердикт куска до первой проверки: сид - от id куска, повтор шага выбирает те же предложения. */
export function emptyVerdict(chunkId: string): ChunkVerdict {
  return { seed: seedOf(chunkId), failures: 0, remarks: [], attempts: [] };
}

/**
 * Сид выборки предложений текущей попытки: повтор шага той же попытки берёт те же предложения
 * (карточка, шаг 4), перевод заново - другие (проверяющий не смотрит дважды в одно место).
 */
export function attemptSeed(verdict: ChunkVerdict): number {
  return verdict.seed + Math.max(verdict.attempts.length - 1, 0);
}

/** Текущая попытка - последняя; перевод без попытки (кусок до `F05-5`) - пустой. */
export function currentAttempt(verdict: ChunkVerdict): CheckAttempt | undefined {
  return verdict.attempts.at(-1);
}

/**
 * Замечания на повтор перевода с пределом: текст чужой модели идёт в промпт (`fenced`) - не
 * больше `REVIEWER_REMARKS_MAX`, каждое не длиннее `REVIEWER_REMARK_MAX_CHARS`.
 */
export function cappedRemarks(remarks: readonly string[]): string[] {
  return remarks
    .slice(0, REVIEWER_REMARKS_MAX)
    .map((r) => (r.length > REVIEWER_REMARK_MAX_CHARS ? r.slice(0, REVIEWER_REMARK_MAX_CHARS) : r));
}
