import {
  checkWikidataEntity,
  geoFingerprint,
  geoInputOf,
  geoNeedsCheck,
  publicPoint,
  readGeo,
  WIKIDATA_EARTH,
  type StoredWorldGeo,
  type WorldGeoInput,
} from './world-geo';

/**
 * Точка места из Wikidata (`F08-12a`, решение арбитра `F08 | F08-12` Q2): числа — только из P625
 * на Земле, в границах и при совпадении подписи на языке версии с названием места; иначе точки нет.
 */
const input: WorldGeoInput = { wikidataId: 'Q656', language: 'ru', names: ['Петербург', 'Питер'] };

const entityBody = (
  over: Record<string, unknown> = {},
  coordinate: Record<string, unknown> = {},
) => ({
  entities: {
    Q656: {
      id: 'Q656',
      labels: {
        ru: { language: 'ru', value: 'Санкт-Петербург' },
        en: { value: 'Saint Petersburg' },
      },
      aliases: { ru: [{ language: 'ru', value: 'Петербург' }] },
      claims: {
        P625: [
          {
            rank: 'normal',
            mainsnak: {
              datavalue: {
                value: {
                  latitude: 59.9375,
                  longitude: 30.308611,
                  globe: WIKIDATA_EARTH,
                  ...coordinate,
                },
              },
            },
          },
        ],
      },
      ...over,
    },
  },
});

describe('checkWikidataEntity (F08-12a, Q2)', () => {
  it('P625 на Земле, синоним на языке версии совпал с формой имени — точка', () => {
    expect(checkWikidataEntity(entityBody(), input)).toEqual({
      point: { lat: 59.9375, lng: 30.308611 },
      reason: null,
    });
  });

  it('нет P625 — точки нет', () => {
    expect(checkWikidataEntity(entityBody({ claims: {} }), input)).toEqual({
      point: null,
      reason: 'no_coordinates',
    });
  });

  it('координаты не на Земле — точки нет', () => {
    const moon = entityBody({}, { globe: 'http://www.wikidata.org/entity/Q405' });
    expect(checkWikidataEntity(moon, input).reason).toBe('not_earth');
  });

  it('широта или долгота вне границ — точки нет', () => {
    expect(checkWikidataEntity(entityBody({}, { latitude: 91 }), input).reason).toBe(
      'out_of_range',
    );
    expect(checkWikidataEntity(entityBody({}, { longitude: -180.5 }), input).reason).toBe(
      'out_of_range',
    );
  });

  it('подпись и синонимы не совпали с названием на языке версии — точки нет (подпись другого языка не в счёт)', () => {
    const other = { ...input, names: ['Saint Petersburg'] };
    expect(checkWikidataEntity(entityBody(), other).reason).toBe('name_mismatch');
    expect(checkWikidataEntity(entityBody(), { ...other, language: 'en' }).reason).toBeNull();
  });

  it('ё и е — одно название (то же правило, что поиск форм в тексте, foldMention; решение R3)', () => {
    const orel = entityBody({ labels: { ru: { value: 'Орел' } }, aliases: {} });
    expect(checkWikidataEntity(orel, { ...input, names: ['Орёл'] }).reason).toBeNull();
    const orelYo = entityBody({ labels: { ru: { value: 'Орёл' } }, aliases: {} });
    expect(checkWikidataEntity(orelYo, { ...input, names: ['Орел'] }).reason).toBeNull();
    expect(geoFingerprint({ ...input, names: ['Орёл'] })).toBe(
      geoFingerprint({ ...input, names: ['Орел'] }),
    );
  });

  it('подпись только в mul засчитывается; подпись чужого языка — нет (решение R2)', () => {
    const mulOnly = entityBody({ labels: { mul: { value: 'Петербург' } }, aliases: {} });
    expect(checkWikidataEntity(mulOnly, input).reason).toBeNull();
    const deOnly = entityBody({ labels: { de: { value: 'Петербург' } }, aliases: {} });
    expect(checkWikidataEntity(deOnly, input).reason).toBe('name_mismatch');
  });

  it('сравнение без регистра и лишних пробелов', () => {
    expect(
      checkWikidataEntity(entityBody(), { ...input, names: ['  санкт-петербург '] }).reason,
    ).toBeNull();
  });

  it('deprecated-ранг не берётся; preferred важнее normal', () => {
    const claims = (rank: string, latitude: number) => ({
      rank,
      mainsnak: { datavalue: { value: { latitude, longitude: 1, globe: WIKIDATA_EARTH } } },
    });
    const body = entityBody({
      claims: { P625: [claims('deprecated', 10), claims('normal', 20), claims('preferred', 30)] },
    });
    expect(checkWikidataEntity(body, input).point?.lat).toBe(30);
    const onlyDeprecated = entityBody({ claims: { P625: [claims('deprecated', 10)] } });
    expect(checkWikidataEntity(onlyDeprecated, input).reason).toBe('no_coordinates');
  });

  it('сущности нет или ответ не той формы — not_found', () => {
    expect(
      checkWikidataEntity({ entities: { Q656: { id: 'Q656', missing: '' } } }, input).reason,
    ).toBe('not_found');
    expect(checkWikidataEntity({}, input).reason).toBe('not_found');
    expect(checkWikidataEntity(null, input).reason).toBe('not_found');
  });
});

describe('вход и повтор проверки (F08-12a, Q2: повтор только при смене номера и названий)', () => {
  const placeOf = (over: Record<string, unknown> = {}) => ({
    type: 'place',
    kind: 'real',
    wikidataId: 'Q656',
    name: 'Петербург',
    aliases: ['Питер'],
    ...over,
  });

  it('вход только у реального места с номером', () => {
    expect(geoInputOf(placeOf(), 'ru')).toEqual(input);
    expect(geoInputOf(placeOf({ kind: 'fictional' }), 'ru')).toBeNull();
    expect(geoInputOf(placeOf({ wikidataId: null }), 'ru')).toBeNull();
    expect(geoInputOf(placeOf({ type: 'character' }), 'ru')).toBeNull();
  });

  it('тот же вход — повтора нет; порядок форм не в счёт; смена номера или названия — повтор', () => {
    const stored: StoredWorldGeo = {
      wikidataId: 'Q656',
      checkedFor: geoFingerprint(input),
      language: 'ru',
      checkedAt: 'now',
      point: { lat: 1, lng: 2 },
      reason: null,
    };
    expect(geoNeedsCheck(stored, input)).toBe(false);
    expect(geoNeedsCheck(stored, { ...input, names: ['Питер', 'Петербург'] })).toBe(false);
    expect(geoNeedsCheck(stored, { ...input, wikidataId: 'Q1' })).toBe(true);
    expect(geoNeedsCheck(stored, { ...input, names: ['Петроград'] })).toBe(true);
    expect(geoNeedsCheck(null, input)).toBe(true);
    expect(geoNeedsCheck(stored, null)).toBe(false);
  });

  it('отказ Wikidata итог не пишет: прежний итог для другого входа — проверяется снова; тот же — нет', () => {
    const old: StoredWorldGeo = {
      wikidataId: 'Q656',
      checkedFor: geoFingerprint({ ...input, names: ['Петроград'] }),
      language: 'ru',
      checkedAt: 'now',
      point: { lat: 1, lng: 2 },
      reason: null,
    };
    expect(geoNeedsCheck(old, input)).toBe(true);
    const same: StoredWorldGeo = {
      ...old,
      checkedFor: geoFingerprint(input),
      point: null,
      reason: 'name_mismatch',
    };
    expect(geoNeedsCheck(same, input)).toBe(false);
  });

  it('readGeo: только запись нашей формы', () => {
    expect(readGeo({ lat: 1, lng: 2 })).toBeNull();
    expect(readGeo(null)).toBeNull();
    expect(
      readGeo({
        wikidataId: 'Q1',
        checkedFor: 'f',
        language: 'ru',
        checkedAt: 't',
        point: { lat: 1, lng: 2 },
        reason: 'x',
      }),
    ).toEqual({
      wikidataId: 'Q1',
      checkedFor: 'f',
      language: 'ru',
      checkedAt: 't',
      point: { lat: 1, lng: 2 },
      reason: null,
    });
    expect(
      readGeo({ wikidataId: 'Q1', checkedFor: 'f', checkedAt: 't', point: { lat: 1, lng: 2 } }),
    ).toBeNull();
  });
});

describe('publicPoint: точка только для текущего входа (F08-12a, ревью круга 2)', () => {
  const placeOf = (over: Record<string, unknown> = {}) => ({
    type: 'place',
    kind: 'real',
    wikidataId: 'Q656',
    name: 'Петербург',
    aliases: ['Питер'],
    ...over,
  });
  const stored: StoredWorldGeo = {
    wikidataId: 'Q656',
    checkedFor: geoFingerprint(input),
    language: 'ru',
    checkedAt: 't',
    point: { lat: 59.9, lng: 30.3 },
    reason: null,
  };

  it('тот же номер и те же названия — точка с источником', () => {
    expect(publicPoint(stored, placeOf())).toEqual({
      lat: 59.9,
      lng: 30.3,
      sourceUrl: 'https://www.wikidata.org/wiki/Q656',
    });
    expect(publicPoint(stored, placeOf({ aliases: ['Питер', 'Петербург'] }))).not.toBeNull();
  });

  it('названия сменили, а проверка не прошла — точки нет', () => {
    expect(publicPoint(stored, placeOf({ name: 'Петроград' }))).toBeNull();
    expect(publicPoint(stored, placeOf({ wikidataId: 'Q1' }))).toBeNull();
    expect(publicPoint(stored, placeOf({ kind: 'fictional' }))).toBeNull();
    expect(publicPoint(stored, placeOf({ type: 'character' }))).toBeNull();
    expect(publicPoint(null, placeOf())).toBeNull();
  });
});

describe('P625 без значения (F08-12a, code-review)', () => {
  it('заявление novalue не заслоняет следующее с координатами', () => {
    const body = entityBody({
      claims: {
        P625: [
          { rank: 'normal', mainsnak: { snaktype: 'novalue' } },
          {
            rank: 'normal',
            mainsnak: {
              datavalue: { value: { latitude: 10, longitude: 20, globe: WIKIDATA_EARTH } },
            },
          },
        ],
      },
    });
    expect(checkWikidataEntity(body, input).point).toEqual({ lat: 10, lng: 20 });
  });
});
