import { readFileSync } from 'fs';
import { join } from 'path';
import { EXAMPLE_ANALYSES } from './index';

/**
 * Эталоны в коде - побайтовые по смыслу копии `test/fixtures/example-analysis.<lang>.json`
 * (решение арбитра `F07 | F07-1a`, К3): правка одной без другой краснеет здесь.
 */
describe('analysis examples', () => {
  it.each(['en', 'es', 'fr', 'pt', 'ru'] as const)('%s equals its JSON fixture', (language) => {
    const path = join(
      __dirname,
      '../../../../../test/fixtures',
      `example-analysis.${language}.json`,
    );
    const fixture = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    expect(EXAMPLE_ANALYSES[language]).toEqual(fixture);
  });
});
