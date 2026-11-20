import type { WorldWriteLanguage } from '../world-write.constants';
import { EXAMPLE_WORLD_EN } from './en';
import { EXAMPLE_WORLD_PAIR_EN } from './pair-en';
import { EXAMPLE_WORLD_PAIR_RU } from './pair-ru';
import { EXAMPLE_WORLD_RU } from './ru';

/**
 * Эталоны страницы героя по языку хода мира (`F08-4a`; другие языки - `F08-9`): ключи - ровно
 * `WORLD_WRITE_LANGUAGES`, новый язык хода без своего эталона не собирается.
 */
export const EXAMPLE_WORLDS: Record<WorldWriteLanguage, Record<string, unknown>> = {
  en: EXAMPLE_WORLD_EN,
  ru: EXAMPLE_WORLD_RU,
};

/**
 * Эталоны страницы пары (`F08-8c-1`, в коде хода - `F08-8e`). Ключи - языки, на которых ход пишет пары
 * (решения арбитра `F08 | F08-8c-1` R3, `F08 | F08-8e-1` Q6): язык хода без эталона пары пар не
 * получает, даже когда `F08-9` расширит языки хода. Эталоны es/fr/pt - `F08-9`.
 */
export const EXAMPLE_WORLD_PAIRS: Partial<Record<WorldWriteLanguage, Record<string, unknown>>> = {
  en: EXAMPLE_WORLD_PAIR_EN,
  ru: EXAMPLE_WORLD_PAIR_RU,
};

/** Пишет ли ход пары на этом языке: только при эталоне пары (Q6). */
export const hasWorldPairExample = (language: string): boolean =>
  Object.keys(EXAMPLE_WORLD_PAIRS).includes(language);
