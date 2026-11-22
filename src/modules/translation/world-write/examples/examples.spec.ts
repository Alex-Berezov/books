import { readFileSync } from 'fs';
import { join } from 'path';
import { WORLD_WRITE_LANGUAGES } from '../world-write.constants';
import { EXAMPLE_WORLD_PAIRS, EXAMPLE_WORLDS, hasWorldPairExample } from './index';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(__dirname, '../../../../../test/fixtures', name), 'utf-8'),
  ) as unknown;

/** Эталоны в коде - копии `test/fixtures/example-world*.<lang>.json`: правка одной без другой краснеет здесь. */
describe('world examples', () => {
  it.each(['en', 'ru', 'es', 'fr', 'pt'] as const)('%s equals its JSON fixture', (language) => {
    expect(EXAMPLE_WORLDS[language]).toEqual(fixture(`example-world.${language}.json`));
  });

  it.each(['en', 'ru', 'es', 'fr', 'pt'] as const)(
    'the %s pair example equals its JSON fixture (F08-8e)',
    (language) => {
      expect(EXAMPLE_WORLD_PAIRS[language]).toEqual(fixture(`example-world-pair.${language}.json`));
    },
  );

  it('pairs are written on every language of the run, not on a language without a pair example (F08-8e-1 Q6, F08-9)', () => {
    expect(['en', 'ru', 'es', 'fr', 'pt', 'de'].filter(hasWorldPairExample)).toEqual([
      'en',
      'ru',
      'es',
      'fr',
      'pt',
    ]);
  });

  it('every language of the run has its page example (F08-9)', () => {
    expect(Object.keys(EXAMPLE_WORLDS).sort()).toEqual([...WORLD_WRITE_LANGUAGES].sort());
  });
});
