import type { WorldWriteLanguage } from '../world-write.constants';
import type { WorldRunObjectType } from '../world-write.data';
import { EXAMPLE_WORLD_EN } from './en';
import { EXAMPLE_WORLD_EVENT_EN } from './event-en';
import { EXAMPLE_WORLD_EVENT_ES } from './event-es';
import { EXAMPLE_WORLD_EVENT_FR } from './event-fr';
import { EXAMPLE_WORLD_EVENT_PT } from './event-pt';
import { EXAMPLE_WORLD_EVENT_RU } from './event-ru';
import { EXAMPLE_WORLD_ES } from './es';
import { EXAMPLE_WORLD_FR } from './fr';
import { EXAMPLE_WORLD_OBJECT_EN } from './object-en';
import { EXAMPLE_WORLD_OBJECT_ES } from './object-es';
import { EXAMPLE_WORLD_OBJECT_FR } from './object-fr';
import { EXAMPLE_WORLD_OBJECT_PT } from './object-pt';
import { EXAMPLE_WORLD_OBJECT_RU } from './object-ru';
import { EXAMPLE_WORLD_TERM_EN } from './term-en';
import { EXAMPLE_WORLD_TERM_ES } from './term-es';
import { EXAMPLE_WORLD_TERM_FR } from './term-fr';
import { EXAMPLE_WORLD_TERM_PT } from './term-pt';
import { EXAMPLE_WORLD_TERM_RU } from './term-ru';
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

/**
 * Эталоны страницы предмета и понятия (`F08-13b`, решение арбитра `F08 | F08-13b` Q7; канон
 * `features/F08-book-wiki/prompts/example-world-{object,term}.<lang>.json`): как у мест, язык хода без
 * эталона типа сущностей этого типа не получает (`objectsOff`, `termsOff`).
 */
export const EXAMPLE_WORLD_OBJECTS: Partial<Record<WorldWriteLanguage, Record<string, unknown>>> = {
  en: EXAMPLE_WORLD_OBJECT_EN,
  es: EXAMPLE_WORLD_OBJECT_ES,
  fr: EXAMPLE_WORLD_OBJECT_FR,
  pt: EXAMPLE_WORLD_OBJECT_PT,
  ru: EXAMPLE_WORLD_OBJECT_RU,
};
export const EXAMPLE_WORLD_TERMS: Partial<Record<WorldWriteLanguage, Record<string, unknown>>> = {
  en: EXAMPLE_WORLD_TERM_EN,
  es: EXAMPLE_WORLD_TERM_ES,
  fr: EXAMPLE_WORLD_TERM_FR,
  pt: EXAMPLE_WORLD_TERM_PT,
  ru: EXAMPLE_WORLD_TERM_RU,
};

/**
 * Эталоны страницы события (`F08-13b-2`, `F08 | F08-13b` Q7; канон
 * `features/F08-book-wiki/prompts/example-world-event.<lang>.json`): как у предмета и понятия, язык хода
 * без эталона события событий не получает (`eventsOff`).
 */
export const EXAMPLE_WORLD_EVENTS: Partial<Record<WorldWriteLanguage, Record<string, unknown>>> = {
  en: EXAMPLE_WORLD_EVENT_EN,
  es: EXAMPLE_WORLD_EVENT_ES,
  fr: EXAMPLE_WORLD_EVENT_FR,
  pt: EXAMPLE_WORLD_EVENT_PT,
  ru: EXAMPLE_WORLD_EVENT_RU,
};

const EXAMPLES_OF_TYPE: Record<
  WorldRunObjectType,
  Partial<Record<WorldWriteLanguage, Record<string, unknown>>>
> = { object: EXAMPLE_WORLD_OBJECTS, term: EXAMPLE_WORLD_TERMS, event: EXAMPLE_WORLD_EVENTS };

/** Эталон предмета, понятия или события языка; языка без эталона типа нет - `undefined`. */
export const worldObjectExample = (
  language: string,
  type: WorldRunObjectType,
): Record<string, unknown> | undefined => EXAMPLES_OF_TYPE[type][language as WorldWriteLanguage];

/** Пишет ли ход сущности типа на этом языке: только при эталоне типа (`F08-13b`). */
export const hasWorldObjectExample = (language: string, type: WorldRunObjectType): boolean =>
  worldObjectExample(language, type) !== undefined;
