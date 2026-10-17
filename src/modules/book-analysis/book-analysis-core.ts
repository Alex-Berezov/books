import type { StoredBookAnalysis } from './book-analysis-data';

/**
 * Ядро анализа (`books-app-docs/features/F03-book-analysis/product.md` §2, `tech.md` T7): без него
 * страницы нет, кнопки нет, адреса в карте сайта нет. Считает только бэкенд, одной функцией;
 * фронт верит `hasCore` из ответа.
 */
export const BOOK_ANALYSIS_CORE = { themes: 2, characters: 2, keyQuotes: 3 } as const;

/**
 * «Заполнено» — после обрезки пробелов остался текст. Порога по длине нет (§2). Тот же предикат
 * стоит на обязательных полях DTO (`RequiredText`: обрезка + `IsNotEmpty`), решение А9.
 */
export const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

export type BookAnalysisCorePart = 'mainIdea' | 'themes' | 'characters' | 'keyQuotes';

export interface BookAnalysisCoreResult {
  hasCore: boolean;
  /** Чего не хватает до ядра — в `warnings` ответа записи. */
  missing: { part: BookAnalysisCorePart; have: number; need: number }[];
}

type CoreInput = Pick<StoredBookAnalysis, 'mainIdea' | 'themes' | 'characters' | 'keyQuotes'>;

export function computeAnalysisCore(blocks: CoreInput): BookAnalysisCoreResult {
  const themes = (blocks.themes ?? []).filter(
    (t) => isFilled(t.title) && isFilled(t.interpretation),
  ).length;
  const characters = (blocks.characters ?? []).filter(
    (c) => isFilled(c.name) && isFilled(c.description),
  ).length;
  const keyQuotes = (blocks.keyQuotes ?? []).filter(
    (q) => isFilled(q.text) && isFilled(q.interpretation),
  ).length;

  const missing: BookAnalysisCoreResult['missing'] = [];
  if (!isFilled(blocks.mainIdea)) missing.push({ part: 'mainIdea', have: 0, need: 1 });
  if (themes < BOOK_ANALYSIS_CORE.themes) {
    missing.push({ part: 'themes', have: themes, need: BOOK_ANALYSIS_CORE.themes });
  }
  if (characters < BOOK_ANALYSIS_CORE.characters) {
    missing.push({ part: 'characters', have: characters, need: BOOK_ANALYSIS_CORE.characters });
  }
  if (keyQuotes < BOOK_ANALYSIS_CORE.keyQuotes) {
    missing.push({ part: 'keyQuotes', have: keyQuotes, need: BOOK_ANALYSIS_CORE.keyQuotes });
  }
  return { hasCore: missing.length === 0, missing };
}
