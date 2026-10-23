import { Language } from '@prisma/client';

/**
 * Отношение длины перевода к исходнику (`F05-5`, шаг 2): знаки текста без разметки, пробелы
 * свёрнуты. Замер - 16 параллельных глав Евангелия от Марка на пяти языках (корпус
 * `test/fixtures/language-corpus/mark`, замер 23.10.2026, дело F05-5): наименьшее и наибольшее
 * отношение по главам. Перевод художественного текста гуляет шире библейского, поэтому коридор -
 * замер с запасом: снизу `× LENGTH_LOW_MARGIN`, сверху `× LENGTH_HIGH_MARGIN`.
 */
const MEASURED: Record<string, readonly [number, number]> = {
  'en->es': [0.921, 0.984],
  'en->fr': [0.986, 1.086],
  'en->pt': [0.936, 1.017],
  'en->ru': [0.793, 0.854],
  'es->en': [1.016, 1.086],
  'es->fr': [1.048, 1.126],
  'es->pt': [0.991, 1.056],
  'es->ru': [0.842, 0.898],
  'fr->en': [0.921, 1.014],
  'fr->es': [0.888, 0.954],
  'fr->pt': [0.909, 0.978],
  'fr->ru': [0.761, 0.84],
  'pt->en': [0.983, 1.068],
  'pt->es': [0.947, 1.009],
  'pt->fr': [1.022, 1.101],
  'pt->ru': [0.811, 0.878],
  'ru->en': [1.171, 1.26],
  'ru->es': [1.114, 1.188],
  'ru->fr': [1.19, 1.313],
  'ru->pt': [1.138, 1.233],
};

const LENGTH_LOW_MARGIN = 0.7;
const LENGTH_HIGH_MARGIN = 1.4;
/** Короче - отношение длины не проверяется: на десятке слов оно ничего не говорит. */
export const LENGTH_CHECK_MIN_CHARS = 500;

/** Коридор пары `[низ, верх]`; пара одного языка - `null` (перевода нет). */
export function lengthCorridor(from: Language, to: Language): readonly [number, number] | null {
  const measured = MEASURED[`${from}->${to}`];
  if (!measured) return null;
  return [measured[0] * LENGTH_LOW_MARGIN, measured[1] * LENGTH_HIGH_MARGIN];
}

/** Длина текста для отношения: пробелы свёрнуты. */
export const textLength = (text: string): number => text.replace(/\s+/g, ' ').trim().length;
