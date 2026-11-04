import { Language } from '@prisma/client';
import { EXAMPLE_ANALYSIS_EN } from './en';
import { EXAMPLE_ANALYSIS_ES } from './es';
import { EXAMPLE_ANALYSIS_FR } from './fr';
import { EXAMPLE_ANALYSIS_PT } from './pt';
import { EXAMPLE_ANALYSIS_RU } from './ru';

/** Эталоны анализа по языку версии (решение арбитра `F07 | F07-1a`, К3). */
export const EXAMPLE_ANALYSES: Record<Language, Record<string, unknown>> = {
  en: EXAMPLE_ANALYSIS_EN,
  es: EXAMPLE_ANALYSIS_ES,
  fr: EXAMPLE_ANALYSIS_FR,
  pt: EXAMPLE_ANALYSIS_PT,
  ru: EXAMPLE_ANALYSIS_RU,
};
