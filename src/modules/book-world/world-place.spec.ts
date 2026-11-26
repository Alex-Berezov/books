import type { StoredWorldEntity } from './book-world-data';
import {
  entityEditorOf,
  toPlaceCard,
  WORLD_CHARACTER_BLOCK_KEYS,
  type WorldEditorRow,
  type WorldPlaceCardRow,
} from './book-world-data';
import { computeWorldCore, WORLD_PLACE_CORE } from './world-core';
import { computeWorldListed, WORLD_PLACES, worldPlaceShown } from './world-public';
import { worldItemKey } from './world-quote-check';
import { geoFingerprint } from './world-geo';
import { checkWorldRefs, checkWorldTypeFields } from './world-refs';

/**
 * Место мира книги (`F08-12a`, решения арбитра `F08 | F08-12` Q1, Q4): ядро на границах, поля чужого
 * типа, публичность за рубильником и карточка общей страницы.
 */
const place = (over: Partial<StoredWorldEntity> = {}): StoredWorldEntity => ({
  key: 'oblomovka',
  type: 'place',
  name: 'Oblomovka',
  role: null,
  aliases: null,
  sources: null,
  short: 'The estate.',
  profile: null,
  appearance: null,
  character: null,
  arc: null,
  scenes: [
    { chapter: 1, title: 'Dream', text: 'The dream of Oblomovka.' },
    { chapter: 2, title: 'Childhood', text: 'Days of childhood.' },
  ],
  relations: null,
  quotes: null,
  critique: null,
  prototypes: null,
  adaptations: null,
  compare: null,
  bonds: null,
  differences: null,
  conclusion: null,
  kind: 'fictional',
  location: 'Volga region',
  significance: 'The idyll he never leaves.',
  description: 'A sleepy village.',
  wikidataId: null,
  imageBrief: null,
  imageBriefFor: null,
  faq: null,
  ...over,
});
const noExclusions = { aliasExclusions: null, aliasChapterExclusions: null };
const counted = { chapters: [1, 2] };

describe('ядро места (F08-12a, Q1)', () => {
  it('порог сцен — ровно 2 с главой: 2 — ядро, 1 — нет', () => {
    expect(WORLD_PLACE_CORE.scenes).toBe(2);
    expect(computeWorldCore({ ...place(), mentions: counted }).hasCore).toBe(true);
    const one = computeWorldCore({ ...place({ scenes: [place().scenes![0]] }), mentions: counted });
    expect(one.hasCore).toBe(false);
    expect(one.missing).toEqual([{ part: 'scenes', have: 1, need: 2 }]);
  });

  it('цитата в ядро не входит; нужны «Коротко», вид места, значение и присутствие', () => {
    expect(computeWorldCore({ ...place({ quotes: null }), mentions: counted }).hasCore).toBe(true);
    const empty = computeWorldCore({
      ...place({ short: null, kind: null, significance: '  ' }),
      mentions: null,
    });
    expect(empty.missing.map((m) => m.part)).toEqual(['short', 'kind', 'significance', 'mentions']);
  });

  it('несошедшаяся сцена (mentions.stale) в ядро не идёт', () => {
    const stale = worldItemKey('scenes', place().scenes![1]);
    const core = computeWorldCore({ ...place(), mentions: { ...counted, stale: [stale] } });
    expect(core.missing).toEqual([{ part: 'scenes', have: 1, need: 2 }]);
  });

  it('у места не требуются поля героя (характер, путь, три цитаты)', () => {
    const core = computeWorldCore({ ...place(), mentions: counted });
    expect(core.missing.map((m) => m.part)).not.toContain('character');
    expect(core.missing.map((m) => m.part)).not.toContain('arc');
  });
});

describe('поля чужого типа (F08-12a, Q1): 400 явной веткой', () => {
  it('поле героя у места — отказ с путём', () => {
    const errors = checkWorldTypeFields(
      place({ character: 'Kind.', arc: { from: 'a', to: 'b' } }),
      noExclusions,
    );
    expect(errors.map((e) => e.path)).toEqual(['character', 'arc']);
  });

  it('роль и источники у места — отказ; формы имени — можно (поиск в тексте)', () => {
    const errors = checkWorldTypeFields(
      place({
        role: 'main',
        sources: [{ title: 'x', url: 'https://example.org' }],
        aliases: ['O.'],
      }),
      noExclusions,
    );
    expect(errors.map((e) => e.path)).toEqual(['role', 'sources']);
  });

  it('wikidataId — только у реального места', () => {
    expect(checkWorldTypeFields(place({ wikidataId: 'Q90' }), noExclusions)).toEqual([
      { path: 'wikidataId', message: 'wikidataId is only for a real place (kind: real)' },
    ]);
    expect(checkWorldTypeFields(place({ kind: 'real', wikidataId: 'Q90' }), noExclusions)).toEqual(
      [],
    );
  });

  it('поле места у героя и у пары — отказ', () => {
    const hero = place({
      type: 'character',
      role: 'main',
      kind: null,
      location: null,
      significance: 'S',
    });
    expect(
      checkWorldTypeFields({ ...hero, scenes: null, description: null }, noExclusions).map(
        (e) => e.path,
      ),
    ).toEqual(['significance']);
    const pair = place({
      key: 'anna--tom',
      type: 'pair',
      scenes: null,
      kind: null,
      location: 'L',
      significance: null,
      description: null,
    });
    expect(checkWorldTypeFields(pair, noExclusions).map((e) => e.path)).toEqual(['location']);
  });

  it('поля места не числятся полями героя (перечень WORLD_CHARACTER_BLOCK_KEYS)', () => {
    for (const k of ['kind', 'location', 'significance', 'description', 'wikidataId']) {
      expect(WORLD_CHARACTER_BLOCK_KEYS).not.toContain(k);
    }
  });

  it('цитата места говорит голосом героя: speakerKey на место — отказ', () => {
    const ctx = {
      entityKeys: new Set(['oblomovka', 'oblomov']),
      characterKeys: new Set(['oblomov']),
      analysisKeys: new Set<string>(),
    };
    const quotes = [{ text: 'Q', chapter: 1, interpretation: 'I', speakerKey: 'oblomovka' }];
    expect(checkWorldRefs(place({ quotes }), ctx).map((e) => e.path)).toEqual([
      'quotes.0.speakerKey',
    ]);
    const ok = [{ ...quotes[0], speakerKey: 'oblomov' }];
    expect(checkWorldRefs(place({ quotes: ok }), ctx)).toEqual([]);
  });
});

describe('публичность места (F08-12a, Q0: рубильник WORLD_PLACES)', () => {
  const listed = {
    type: 'place',
    role: null,
    hasCore: true,
    isVisible: true,
    readAt: null,
    autoTextAt: null,
    mentions: counted,
  };
  // С `F08-12c` рубильник включён по умолчанию; выключенное положение проверяется отдельным
  // тестом и возвращается.
  afterEach(() => {
    WORLD_PLACES.public = true;
  });

  it('рубильник включён по умолчанию', () => {
    expect(WORLD_PLACES.public).toBe(true);
  });

  it('выключенный рубильник — место не на сайте никогда', () => {
    WORLD_PLACES.public = false;
    expect(computeWorldListed(listed)).toBe(false);
  });

  it('включённый — страница по ядру без порога ролей; без ядра, «показывать» или «прочитано» — нет', () => {
    expect(computeWorldListed(listed)).toBe(true);
    expect(computeWorldListed({ ...listed, hasCore: false })).toBe(false);
    expect(computeWorldListed({ ...listed, isVisible: false })).toBe(false);
    expect(computeWorldListed({ ...listed, autoTextAt: new Date(2), readAt: new Date(1) })).toBe(
      false,
    );
  });

  it('карточка общей страницы — без ядра, но только «показывать» и «прочитано» при включённом рубильнике', () => {
    const card = { type: 'place', isVisible: true, readAt: null, autoTextAt: null };
    WORLD_PLACES.public = false;
    expect(worldPlaceShown(card)).toBe(false);
    WORLD_PLACES.public = true;
    expect(worldPlaceShown(card)).toBe(true);
    expect(worldPlaceShown({ ...card, isVisible: false })).toBe(false);
    expect(worldPlaceShown({ ...card, autoTextAt: new Date(2), readAt: new Date(1) })).toBe(false);
    expect(worldPlaceShown({ ...card, autoTextAt: new Date(2), readAt: new Date(2) })).toBe(true);
    expect(worldPlaceShown({ ...card, type: 'character' })).toBe(false);
  });
});

describe('карточка места на общей странице (F08-12a, Q4)', () => {
  const geo = {
    wikidataId: 'Q656',
    checkedFor: geoFingerprint({ wikidataId: 'Q656', language: 'en', names: ['Petersburg'] }),
    language: 'en',
    checkedAt: '2026-11-24T00:00:00.000Z',
    point: { lat: 59.94, lng: 30.31 },
    reason: null,
  };
  const row = (over: Partial<WorldPlaceCardRow> = {}): WorldPlaceCardRow => ({
    key: 'petersburg',
    type: 'place',
    name: 'Petersburg',
    short: 'The capital.',
    aliases: null,
    isListed: false,
    isVisible: true,
    readAt: null,
    autoTextAt: null,
    blocks: {
      kind: 'real',
      location: 'Neva',
      significance: 'S',
      wikidataId: 'Q656',
      scenes: [
        { chapter: 1, title: 'Kept', text: 'secret text' },
        { chapter: 9, title: 'Gone', text: 'g' },
      ],
    },
    mentions: {
      chapters: [1],
      paragraphs: { '1': [4] },
      stale: [worldItemKey('scenes', { chapter: 9, title: 'Gone', text: 'g' })],
    },
    geo,
    ...over,
  });

  it('сцены белым списком title/chapter/paragraph, без текста и без несошедшихся', () => {
    const card = toPlaceCard(row());
    expect(card.scenes).toEqual([{ title: 'Kept', chapter: 1, paragraph: 5 }]);
    // Белый список карточки (решение R6): ничего сверх этих полей из blocks, mentions и geo.
    expect(Object.keys(card).sort()).toEqual(
      ['hasPage', 'key', 'kind', 'location', 'name', 'point', 'scenes', 'short'].sort(),
    );
    expect(JSON.stringify(card)).not.toContain('secret text');
    expect(card).toMatchObject({ kind: 'real', location: 'Neva', hasPage: false });
  });

  it('точка — только проверенная и только для текущего номера реального места', () => {
    expect(toPlaceCard(row()).point).toEqual({
      lat: 59.94,
      lng: 30.31,
      sourceUrl: 'https://www.wikidata.org/wiki/Q656',
    });
    const fictional = row({ blocks: { ...(row().blocks as object), kind: 'fictional' } });
    expect(toPlaceCard(fictional).point).toBeNull();
    const renumbered = row({ blocks: { ...(row().blocks as object), wikidataId: 'Q1' } });
    expect(toPlaceCard(renumbered).point).toBeNull();
    expect(
      toPlaceCard(row({ geo: { ...geo, point: null, reason: 'name_mismatch' } })).point,
    ).toBeNull();
    expect(toPlaceCard(row({ geo: null })).point).toBeNull();
  });
});

describe('итог проверки точки редактору (F08-12a, ревью круга 3): то же правило, что точка читателю', () => {
  const fp = geoFingerprint({ wikidataId: 'Q656', language: 'en', names: ['Petersburg'] });
  const editorRow = (over: Record<string, unknown> = {}) =>
    ({
      key: 'petersburg',
      type: 'place',
      name: 'Petersburg',
      aliases: null,
      blocks: { kind: 'real', wikidataId: 'Q656' },
      mentions: null,
      geo: {
        wikidataId: 'Q656',
        checkedFor: fp,
        language: 'en',
        checkedAt: 't',
        point: { lat: 1, lng: 2 },
        reason: null,
      },
      isListed: false,
      isVisible: true,
      readAt: null,
      autoTextAt: null,
      firstPublishedAt: null,
      coreMissing: [],
      mentionChapters: null,
      aliasExclusions: null,
      aliasChapterExclusions: null,
      mentionsAt: null,
      ...over,
    }) as unknown as WorldEditorRow;

  it('проверка для текущего входа — как есть', () => {
    expect(entityEditorOf(editorRow(), false).geo).toEqual({
      wikidataId: 'Q656',
      checkedAt: 't',
      reason: null,
    });
  });

  it('номер или названия сменили, проверки для них нет — unavailable без даты', () => {
    const renamed = editorRow({ name: 'Petrograd' });
    expect(entityEditorOf(renamed, false).geo).toEqual({
      wikidataId: 'Q656',
      checkedAt: null,
      reason: 'unavailable',
    });
    const renumbered = editorRow({ blocks: { kind: 'real', wikidataId: 'Q1' } });
    expect(entityEditorOf(renumbered, false).geo).toMatchObject({
      wikidataId: 'Q1',
      reason: 'unavailable',
    });
    expect(entityEditorOf(editorRow({ geo: null }), false).geo).toMatchObject({
      reason: 'unavailable',
    });
  });

  it('вымышленное место, без номера или не место — null', () => {
    expect(entityEditorOf(editorRow({ blocks: { kind: 'fictional' } }), false).geo).toBeNull();
    // Номер не по форме Q-номера: писатель такое место не проверит — редактору не «проверится позже».
    expect(
      entityEditorOf(editorRow({ blocks: { kind: 'real', wikidataId: 'X1' } }), false).geo,
    ).toBeNull();
    expect(entityEditorOf(editorRow({ type: 'character', blocks: {} }), false).geo).toBeNull();
  });
});
