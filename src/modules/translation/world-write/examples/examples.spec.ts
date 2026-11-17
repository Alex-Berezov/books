import { readFileSync } from 'fs';
import { join } from 'path';
import { EXAMPLE_WORLDS } from './index';

/** Эталоны в коде - копии `test/fixtures/example-world.<lang>.json`: правка одной без другой краснеет здесь. */
describe('world examples', () => {
  it.each(['en', 'ru'] as const)('%s equals its JSON fixture', (language) => {
    const path = join(__dirname, '../../../../../test/fixtures', `example-world.${language}.json`);
    const fixture = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    expect(EXAMPLE_WORLDS[language]).toEqual(fixture);
  });
});
