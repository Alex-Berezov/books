import { AssemblyFlagReason } from '../assemble/chapter-assembly';

/**
 * Причины флага главы черновика (`F05-6`, 6b) - сверх причин сборки (`ASSEMBLY_FLAG_REASONS`):
 * их ставит запись главы, а не сборка.
 */
export const DRAFT_FLAG_REASONS = {
  /** Глава исходника изменилась после перевода: перед записью отпечаток не сошёлся с кусками. */
  SOURCE_CHANGED: 'SOURCE_CHANGED',
} as const;

export type DraftFlagReason = (typeof DRAFT_FLAG_REASONS)[keyof typeof DRAFT_FLAG_REASONS];

/** Код флага и находки главы перевода: сборки (6a) или записи черновика (6b). */
export type ChapterFlagCode = AssemblyFlagReason | DraftFlagReason;

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
