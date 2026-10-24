import { AssemblyFlagReason } from '../assemble/chapter-assembly';
import { SeamFindingCode } from '../check/seam-check';
import { FinalFindingCode } from '../final-check/final-check.constants';

/**
 * Причины флага главы черновика (`F05-6`, 6b) - сверх причин сборки (`ASSEMBLY_FLAG_REASONS`):
 * их ставит запись главы, а не сборка.
 */
export const DRAFT_FLAG_REASONS = {
  /** Глава исходника изменилась после перевода: перед записью отпечаток не сошёлся с кусками. */
  SOURCE_CHANGED: 'SOURCE_CHANGED',
  /** Названия главы нет в ответе `metadata`: записано пустым (решение арбитра `F05 | F05-6`, 6c В2). */
  TITLE_MISSING: 'TITLE_MISSING',
} as const;

export type DraftFlagReason = (typeof DRAFT_FLAG_REASONS)[keyof typeof DRAFT_FLAG_REASONS];

/** Код флага и находки главы перевода: сборки (6a), записи черновика (6b), стыков и итоговой проверки (6c). */
export type ChapterFlagCode =
  | AssemblyFlagReason
  | DraftFlagReason
  | SeamFindingCode
  | FinalFindingCode;

/**
 * Черновик языка удалили посреди записи глав (решение арбитра `F05 | F05-6`): язык `failed`,
 * второй черновик не создаётся - удаление редактора не отменяется молча.
 */
export const DRAFT_DELETED = 'DRAFT_DELETED';

/**
 * Ни одной главы к записи (все не собрались: Р8, кусок без перевода): черновик не создаётся -
 * пустая версия держала бы язык через `VERSION_EXISTS` (решение арбитра `F05 | F05-6`, круг 5).
 */
export const NO_CHAPTERS_WRITTEN = 'NO_CHAPTERS_WRITTEN';
