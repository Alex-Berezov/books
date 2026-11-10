import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { mergeAnalysis, StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import { checkAnalysisRefs } from '../../book-analysis/book-analysis-refs';
import { BOOK_ANALYSIS_LIMITS } from '../../book-analysis/dto/book-analysis-blocks.dto';
import { UpdateBookAnalysisDto } from '../../book-analysis/dto/update-book-analysis.dto';
import { ChapterIndex, quoteInChapter } from '../draft-quality/quote-check';

/**
 * Общие проверки анализа для хода анализа `F07`: подполя `facts` из текста книги, дословность
 * цитаты по главе и ошибки сохранения анализа. Заготовка Analysis `F05-11`, для которой они
 * заводились, снята в `F07-3a` (решение арбитра `F07 | F07-3`).
 */

/**
 * Подполя `facts`, которые есть в тексте книги; жанр, направление и годы - внешние (§5.1 п.4).
 * Те же подполя пишет шаг 1 хода анализа `F07` (владение, запись и предложение - по подполю).
 */
export const FILLABLE_FACTS = ['settingPlace', 'settingTime', 'narrator', 'structure'] as const;
export type FillableFact = (typeof FILLABLE_FACTS)[number];

/** Проверка цитаты анализа по главе (Р5, Р6, Р21, Р25) - с пределом импорта цитаты анализа. */
export function quoteCheck(
  text: string,
  chapter: number,
  chapters: ChapterIndex,
): ReturnType<typeof quoteInChapter> {
  return quoteInChapter(text, chapter, chapters, BOOK_ANALYSIS_LIMITS.quote);
}

function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}).map((m) => `${prefix}${e.property}: ${m}`),
    ...flatten(e.children ?? [], `${prefix}${e.property}.`),
  ]);
}

/**
 * Ошибки, на которых сохранение анализа отказало бы (Р2): тело - через `UpdateBookAnalysisDto`
 * с опциями боевого `ValidationPipe` (`main.ts`), ссылки - `checkAnalysisRefs` по записи после
 * слияния, как у `PUT versions/:id/analysis`. Не копия схемы: те же классы и та же функция.
 * Тело - блоки шагов хода анализа `F07`.
 */
export function analysisImportErrors(stored: StoredBookAnalysis, analysis: object): string[] {
  const dto = plainToInstance(UpdateBookAnalysisDto, analysis);
  const errors = flatten(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }));
  if (errors.length > 0) return errors;
  return checkAnalysisRefs(mergeAnalysis(stored, dto)).map((e) => `${e.path}: ${e.message}`);
}
