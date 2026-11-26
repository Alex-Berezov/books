import type { WorldWriteLanguage } from '../world-write.constants';
import { EXAMPLE_WORLD_EN } from './en';
import { EXAMPLE_WORLD_ES } from './es';
import { EXAMPLE_WORLD_FR } from './fr';
import { EXAMPLE_WORLD_PAIR_EN } from './pair-en';
import { EXAMPLE_WORLD_PAIR_ES } from './pair-es';
import { EXAMPLE_WORLD_PAIR_FR } from './pair-fr';
import { EXAMPLE_WORLD_PAIR_PT } from './pair-pt';
import { EXAMPLE_WORLD_PAIR_RU } from './pair-ru';
import { EXAMPLE_WORLD_PLACE_EN } from './place-en';
import { EXAMPLE_WORLD_PLACE_ES } from './place-es';
import { EXAMPLE_WORLD_PLACE_FR } from './place-fr';
import { EXAMPLE_WORLD_PLACE_PT } from './place-pt';
import { EXAMPLE_WORLD_PLACE_RU } from './place-ru';
import { EXAMPLE_WORLD_PT } from './pt';
import { EXAMPLE_WORLD_RU } from './ru';

/**
 * Эталоны страницы героя по языку хода мира (`F08-4a`, es/fr/pt - `F08-9`): ключи - ровно
 * `WORLD_WRITE_LANGUAGES`, новый язык хода без своего эталона не собирается.
 */
export const EXAMPLE_WORLDS: Record<WorldWriteLanguage, Record<string, unknown>> = {
  en: EXAMPLE_WORLD_EN,
  es: EXAMPLE_WORLD_ES,
  fr: EXAMPLE_WORLD_FR,
  pt: EXAMPLE_WORLD_PT,
  ru: EXAMPLE_WORLD_RU,
};

/**
 * Эталоны страницы пары (`F08-8c-1`, в коде хода - `F08-8e`). Ключи - языки, на которых ход пишет пары
 * (решения арбитра `F08 | F08-8c-1` R3, `F08 | F08-8e-1` Q6): язык хода без эталона пары пар не
 * получает: список пар держится ключами эталонов, а не языками хода. Эталоны es/fr/pt - `F08-9`.
 */
export const EXAMPLE_WORLD_PAIRS: Partial<Record<WorldWriteLanguage, Record<string, unknown>>> = {
  en: EXAMPLE_WORLD_PAIR_EN,
  es: EXAMPLE_WORLD_PAIR_ES,
  fr: EXAMPLE_WORLD_PAIR_FR,
  pt: EXAMPLE_WORLD_PAIR_PT,
  ru: EXAMPLE_WORLD_PAIR_RU,
};

/** Пишет ли ход пары на этом языке: только при эталоне пары (Q6). */
export const hasWorldPairExample = (language: string): boolean =>
  Object.keys(EXAMPLE_WORLD_PAIRS).includes(language);

/**
 * Эталоны страницы места (`F08-12b`, канон `features/F08-book-wiki/prompts/example-world-place.<lang>.json`):
 * как у пар, язык хода без эталона места мест не получает (`placesOff`), список держится ключами эталонов.
 */
export const EXAMPLE_WORLD_PLACES: Partial<Record<WorldWriteLanguage, Record<string, unknown>>> = {
  en: EXAMPLE_WORLD_PLACE_EN,
  es: EXAMPLE_WORLD_PLACE_ES,
  fr: EXAMPLE_WORLD_PLACE_FR,
  pt: EXAMPLE_WORLD_PLACE_PT,
  ru: EXAMPLE_WORLD_PLACE_RU,
};

/** Пишет ли ход места на этом языке: только при эталоне места (`F08-12b`). */
export const hasWorldPlaceExample = (language: string): boolean =>
  Object.keys(EXAMPLE_WORLD_PLACES).includes(language);
