import type { WorldWriteLanguage } from '../world-write.constants';
import { EXAMPLE_WORLD_EN } from './en';
import { EXAMPLE_WORLD_RU } from './ru';

/**
 * Эталоны страницы героя по языку хода мира (`F08-4a`; другие языки - `F08-9`): ключи - ровно
 * `WORLD_WRITE_LANGUAGES`, новый язык хода без своего эталона не собирается.
 */
export const EXAMPLE_WORLDS: Record<WorldWriteLanguage, Record<string, unknown>> = {
  en: EXAMPLE_WORLD_EN,
  ru: EXAMPLE_WORLD_RU,
};
