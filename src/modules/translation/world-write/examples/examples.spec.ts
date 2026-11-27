import { readFileSync } from 'fs';
import { join } from 'path';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateBookWorldDto } from '../../../book-world/dto/update-book-world.dto';
import { checkWorldTypeFields } from '../../../book-world/world-refs';
import { WORLD_WRITE_LANGUAGES } from '../world-write.constants';
import {
  EXAMPLE_WORLD_OBJECTS,
  EXAMPLE_WORLD_PAIRS,
  EXAMPLE_WORLD_PLACES,
  EXAMPLE_WORLD_TERMS,
  EXAMPLE_WORLDS,
  hasWorldObjectExample,
  hasWorldPairExample,
  hasWorldPlaceExample,
} from './index';

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

  it.each(['en', 'ru', 'es', 'fr', 'pt'] as const)(
    'the %s place example equals its JSON fixture (F08-12b)',
    (language) => {
      expect(EXAMPLE_WORLD_PLACES[language]).toEqual(
        fixture(`example-world-place.${language}.json`),
      );
    },
  );

  // /qa круг 1 F08-12b (project-manager, tech-lead): эталон места проходит правило импорта мира.
  it.each(['en', 'ru', 'es', 'fr', 'pt'] as const)(
    'the %s place example passes the world import rule: DTO and the fields of a place',
    (language) => {
      const example = EXAMPLE_WORLD_PLACES[language] as {
        entities: Array<Record<string, unknown>>;
      };
      const dto = plainToInstance(UpdateBookWorldDto, example);
      expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
      const none = { aliasExclusions: null, aliasChapterExclusions: null };
      for (const entity of example.entities) {
        expect(checkWorldTypeFields(entity as never, none)).toEqual([]);
      }
    },
  );

  it('places are written on every language of the run with a place example (F08-12b)', () => {
    expect(['en', 'ru', 'es', 'fr', 'pt', 'de'].filter(hasWorldPlaceExample)).toEqual([
      'en',
      'ru',
      'es',
      'fr',
      'pt',
    ]);
  });

  // F08-13b (решение арбитра `F08 | F08-13b` Q7): эталоны предмета и понятия на пять языков.
  it.each(
    (['object', 'term'] as const).flatMap((type) =>
      (['en', 'ru', 'es', 'fr', 'pt'] as const).map((language) => [type, language] as const),
    ),
  )(
    'the %s example of %s equals its JSON fixture and passes the world import rule (F08-13b)',
    (type, language) => {
      const example = (type === 'object' ? EXAMPLE_WORLD_OBJECTS : EXAMPLE_WORLD_TERMS)[language];
      expect(example).toEqual(fixture(`example-world-${type}.${language}.json`));
      const dto = plainToInstance(UpdateBookWorldDto, example);
      expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
      const none = { aliasExclusions: null, aliasChapterExclusions: null };
      const entities = (example as { entities: Array<Record<string, unknown>> }).entities;
      expect(entities.map((e) => e.type)).toEqual([type]);
      for (const entity of entities) {
        expect(checkWorldTypeFields(entity as never, none)).toEqual([]);
      }
    },
  );

  it('objects and terms are written on every language of the run with their example (F08-13b)', () => {
    for (const type of ['object', 'term'] as const) {
      expect(
        ['en', 'ru', 'es', 'fr', 'pt', 'de'].filter((l) => hasWorldObjectExample(l, type)),
      ).toEqual(['en', 'ru', 'es', 'fr', 'pt']);
    }
  });

  it('every language of the run has its page example (F08-9)', () => {
    expect(Object.keys(EXAMPLE_WORLDS).sort()).toEqual([...WORLD_WRITE_LANGUAGES].sort());
  });
});
