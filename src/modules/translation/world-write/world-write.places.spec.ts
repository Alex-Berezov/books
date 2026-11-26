import type { WorldPlaceCandidate } from './world-write.data';
import {
  choosePlaces,
  dossierPlaces,
  placesAfterPairs,
  placesMode,
  placesToChoose,
  placeStepsUpperBound,
  runPlaces,
  selectWorldPlaces,
} from './world-write.places';

const place = (key: string, chapters: number[]): WorldPlaceCandidate => ({
  key,
  name: key.toUpperCase(),
  aliases: [],
  mentions: { chapters, perChapter: {} },
});

const DOSSIER = {
  entities: [
    { key: 'garret', name: 'The garret', kind: 'place', whatIs: 'a room', firstChapter: 1 },
    { key: 'axe', name: 'The axe', kind: 'object', whatIs: 'a tool', firstChapter: 6 },
    { key: 'haymarket', name: 'The Haymarket', kind: 'place', whatIs: 'a square', firstChapter: 1 },
    { key: 'Bad Key', name: 'Broken', kind: 'place', whatIs: '', firstChapter: 1 },
    { key: 'garret', name: 'Second garret', kind: 'place', whatIs: '', firstChapter: 2 },
    { key: 'nameless', name: '  ', kind: 'place', whatIs: '', firstChapter: 1 },
  ],
};

// F08-12b, решение арбитра `F08 | F08-12b` Q1: кандидаты-места - места досье, порог 2 главы, потолок 10.
describe('world run places (F08-12b)', () => {
  it('dossierPlaces: only kind place with a valid key and a name, each key once', () => {
    expect(dossierPlaces(DOSSIER)).toEqual([
      { key: 'garret', name: 'The garret' },
      { key: 'haymarket', name: 'The Haymarket' },
    ]);
    expect(dossierPlaces(null)).toEqual([]);
    expect(dossierPlaces({ entities: 'x' })).toEqual([]);
  });

  it('runPlaces: a key of an analysis hero, a pair or a stored non-place is taken; a stored place stays', () => {
    const entities = new Map([
      ['haymarket', { type: 'character' as const }],
      ['garret', { type: 'place' as const }],
    ]);
    expect(runPlaces(DOSSIER, entities, new Set())).toEqual({
      places: [{ key: 'garret', name: 'The garret' }],
      taken: [{ key: 'haymarket', name: 'The Haymarket' }],
    });
    expect(runPlaces(DOSSIER, new Map(), new Set(['garret']))).toEqual({
      places: [{ key: 'haymarket', name: 'The Haymarket' }],
      taken: [{ key: 'garret', name: 'The garret' }],
    });
  });

  it('selectWorldPlaces: below 2 chapters left out, then by chapters desc and key, at most 10', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      place(`p${String(i).padStart(2, '0')}`, [1, 2, 3]),
    );
    const { places, skipped } = selectWorldPlaces([
      place('one-chapter', [4]),
      place('wide', [1, 2, 3, 4, 5]),
      ...many,
    ]);
    expect(places).toHaveLength(10);
    expect(places[0].key).toBe('wide');
    expect(places.slice(1).map((p) => p.key)).toEqual(many.slice(0, 9).map((p) => p.key));
    expect(skipped).toEqual([
      {
        key: 'one-chapter',
        reason: 'PLACE_BELOW_MIN_CHAPTERS',
        names: ['ONE-CHAPTER'],
        chapters: 1,
      },
      { key: 'p09', reason: 'PLACES_MAX', names: ['P09'], chapters: 3 },
      { key: 'p10', reason: 'PLACES_MAX', names: ['P10'], chapters: 3 },
      { key: 'p11', reason: 'PLACES_MAX', names: ['P11'], chapters: 3 },
    ]);
    // Ровно две главы - проходит (порог 2, а не 3 героев).
    expect(selectWorldPlaces([place('two', [1, 2])]).places.map((p) => p.key)).toEqual(['two']);
  });

  it('choosePlaces: taken keys are left out with PLACE_KEY_TAKEN; an old run keeps its places; no sample - no places', () => {
    const taken = [{ key: 'anna', name: 'Anna street' }];
    expect(choosePlaces('en', [place('garret', [1, 2])], taken, null)).toEqual({
      places: [place('garret', [1, 2])],
      leftOut: [{ key: 'anna', reason: 'PLACE_KEY_TAKEN', names: ['Anna street'], chapters: null }],
      placesOff: null,
    });
    expect(choosePlaces('en', [place('garret', [1, 2])], taken, [])).toEqual({
      places: [],
      leftOut: [],
      placesOff: null,
    });
    expect(choosePlaces('de', [place('garret', [1, 2])], taken, null)).toEqual({
      places: [],
      leftOut: [],
      placesOff: 'WORLD_PLACE_LANGUAGE',
    });
  });

  it('placeStepsUpperBound: places of the dossier up to 10, no dossier - 10, no sample - 0', () => {
    expect(placeStepsUpperBound(DOSSIER, 'ru')).toBe(2);
    expect(placeStepsUpperBound(null, 'ru')).toBe(10);
    expect(placeStepsUpperBound(DOSSIER, 'de')).toBe(0);
  });
});

// /qa круг 2 F08-12b (architecture): условие «выбирать ли места» и отсев по ключу пары - в модуле мест.
describe('placesMode, placesToChoose, placesAfterPairs (F08-12b, /qa round 2)', () => {
  it('a run before F08-12b - old; a language without a sample - language; else on', () => {
    expect(placesMode('en', [])).toBe('old');
    expect(placesMode('de', null)).toBe('language');
    expect(placesMode('ru', null)).toBe('on');
  });

  it('places to choose only when on; a place on a pair key of the run is taken', () => {
    expect(placesToChoose('en', [], DOSSIER, new Map(), new Set())).toEqual({
      places: [],
      taken: [],
    });
    const chosen = placesToChoose('en', null, DOSSIER, new Map(), new Set());
    expect(chosen.places.map((p) => p.key)).toEqual(['garret', 'haymarket']);
    expect(placesAfterPairs(chosen, new Set(['haymarket']))).toEqual({
      free: [{ key: 'garret', name: 'The garret' }],
      taken: [{ key: 'haymarket', name: 'The Haymarket' }],
    });
  });
});

// /qa круг 3 F08-12b (code-review): вид места досье читается с обрезкой, как у форм названия.
describe('dossierPlaces: the kind is trimmed (F08-12b, /qa round 3)', () => {
  it('a kind with spaces around is a place', () => {
    expect(
      dossierPlaces({ entities: [{ key: 'moscow', name: 'Moscow', kind: ' place ' }] }),
    ).toEqual([{ key: 'moscow', name: 'Moscow' }]);
  });
});
