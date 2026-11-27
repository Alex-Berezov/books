import { LlmStageRegistry } from '../../llm/llm-stages.registry';
import {
  ANALYSIS_WRITE_TASK_KIND,
  registerAnalysisWriteStages,
} from '../analysis-write/analysis-write.constants';
import {
  isWorldWriteLanguage,
  registerWorldWriteStages,
  WORLD_PAGE_WRITE_STAGE,
  WORLD_WRITE_STAGE_DEFINITIONS,
  WORLD_WRITE_TASK_KIND,
} from './world-write.constants';
import {
  blockIsEmpty,
  emptyWorldData,
  type WorldStepCounts,
  entityKindOf,
  readWorldData,
  stepAt,
  stepsTotalOf,
  valuePrint,
  worldDataJson,
} from './world-write.data';

/** Число сущностей хода для `stepAt`: не названные виды - 0. */
const counts = (c: Partial<WorldStepCounts>): WorldStepCounts => ({
  heroes: 0,
  pairs: 0,
  places: 0,
  objects: 0,
  terms: 0,
  events: 0,
  ...c,
});

describe('world run steps', () => {
  it('step 0 chooses the characters, then each candidate gets a page and its external blocks', () => {
    expect([0, 1, 2, 3, 4].map((step) => stepAt(step, counts({ heroes: 2 })))).toEqual([
      { kind: 'select', candidate: null },
      { kind: 'page', candidate: 0 },
      { kind: 'external', candidate: 0 },
      { kind: 'page', candidate: 1 },
      { kind: 'external', candidate: 1 },
    ]);
    expect(stepsTotalOf({ candidates: null, pairs: null, places: null })).toBeNull();
    expect(
      stepsTotalOf({
        candidates: [
          {
            key: 'a',
            role: 'main',
            name: 'A',
            aliases: [],
            mentions: { chapters: [], perChapter: {} },
          },
        ],
        pairs: [],
        places: [],
      }),
    ).toBe(3);
  });

  it('pair steps go after all hero steps, one per pair; hero steps keep their numbers (F08-8e)', () => {
    expect([4, 5, 6].map((step) => stepAt(step, counts({ heroes: 2, pairs: 2 })))).toEqual([
      { kind: 'external', candidate: 1 },
      { kind: 'pair', candidate: 0 },
      { kind: 'pair', candidate: 1 },
    ]);
    const hero = (key: string) => ({
      key,
      role: 'main' as const,
      name: key,
      aliases: [],
      mentions: { chapters: [1], perChapter: {} },
    });
    const pair = { key: 'anna--boris', a: 'anna', b: 'boris', linked: true, chapters: [1] };
    expect(
      stepsTotalOf({ candidates: [hero('anna'), hero('boris')], pairs: [pair], places: [] }),
    ).toBe(6);
  });

  // F08-12b: шаги мест - после шагов пар; у хода без мест номера и число шагов прежние.
  it('place steps go after the pair steps; heroes and pairs keep their numbers (F08-12b)', () => {
    expect(
      [4, 5, 6, 7, 8].map((step) => stepAt(step, counts({ heroes: 2, pairs: 2, places: 2 }))),
    ).toEqual([
      { kind: 'external', candidate: 1 },
      { kind: 'pair', candidate: 0 },
      { kind: 'pair', candidate: 1 },
      { kind: 'place', candidate: 0 },
      { kind: 'place', candidate: 1 },
    ]);
    // Ход без пар: место сразу после героев.
    expect(stepAt(5, counts({ heroes: 2, places: 1 }))).toEqual({ kind: 'place', candidate: 0 });
    const hero = (key: string) => ({
      key,
      role: 'main' as const,
      name: key,
      aliases: [],
      mentions: { chapters: [1], perChapter: {} },
    });
    const place = {
      key: 'garret',
      name: 'Garret',
      aliases: [],
      mentions: { chapters: [1, 2], perChapter: {} },
    };
    const pair = { key: 'anna--boris', a: 'anna', b: 'boris', linked: true, chapters: [1] };
    const heroes = [hero('anna'), hero('boris')];
    expect(stepsTotalOf({ candidates: heroes, pairs: [pair], places: [place] })).toBe(7);
    expect(stepsTotalOf({ candidates: heroes, pairs: [pair], places: [] })).toBe(6);
    expect(stepsTotalOf({ candidates: heroes, pairs: [pair], places: null })).toBe(6);
  });
});

describe('world run places (F08-12b)', () => {
  const hero = {
    key: 'anna',
    name: 'Anna',
    aliases: [],
    mentions: { chapters: [1] },
    role: 'main',
  };
  const place = {
    key: 'garret',
    name: 'Garret',
    aliases: ['garret'],
    mentions: { chapters: [1, 2] },
  };

  it('a run started before F08-12b (no places field) reads with no places: it ends on the pairs', () => {
    const data = readWorldData({ candidates: [hero], pairs: [] });
    expect(data.places).toEqual([]);
    expect(data.placesOff).toBeNull();
    expect(data.stepsBroken).toBe(false);
    expect(stepsTotalOf(data)).toBe(3);
  });

  it('a new run writes places: null and reads it back as not chosen; chosen places survive the round trip', () => {
    expect(readWorldData(worldDataJson(emptyWorldData())).places).toBeNull();
    const chosen = readWorldData({
      ...(worldDataJson(emptyWorldData()) as object),
      candidates: [hero],
      pairs: [],
      places: [place],
      placesOff: null,
    });
    expect(chosen.places).toEqual([
      {
        key: 'garret',
        name: 'Garret',
        aliases: ['garret'],
        mentions: { chapters: [1, 2], perChapter: {} },
      },
    ]);
    expect(readWorldData(worldDataJson(chosen)).places).toEqual(chosen.places);
    expect(
      readWorldData({
        candidates: [hero],
        pairs: [],
        places: [],
        placesOff: 'WORLD_PLACE_LANGUAGE',
      }).placesOff,
    ).toBe('WORLD_PLACE_LANGUAGE');
  });

  it('a broken place entry breaks the steps: a place step takes its place by index', () => {
    expect(
      readWorldData({ candidates: [hero], pairs: [], places: [place, { key: 1 }] }).stepsBroken,
    ).toBe(true);
    expect(readWorldData({ candidates: [hero], pairs: [], places: 'x' }).stepsBroken).toBe(true);
  });

  it('a key of a run place is a place entity; a hero candidate stays a character', () => {
    const data = readWorldData({ candidates: [hero], pairs: [], places: [place] });
    expect(entityKindOf(data, 'garret')).toEqual({ type: 'place' });
    expect(entityKindOf(data, 'anna')).toEqual({ type: 'character', role: 'main' });
  });
});

describe('world run pairs (F08-8e)', () => {
  const hero = {
    key: 'anna',
    name: 'Anna',
    aliases: [],
    mentions: { chapters: [1] },
    role: 'main',
  };
  const pair = { key: 'anna--boris', a: 'anna', b: 'boris', linked: false, chapters: [1, 2] };

  it('a run started before F08-8e (candidates, no pairs field) reads with no pairs: it ends on the heroes', () => {
    const data = readWorldData({ candidates: [hero, { ...hero, key: 'boris' }] });
    expect(data.pairs).toEqual([]);
    expect(stepsTotalOf(data)).toBe(5);
    expect(data.stepsBroken).toBe(false);
  });

  it('a run started before F08-8e and not past the choice (no pairs field) reads with no pairs too (F08-8e-4 Q2)', () => {
    expect(readWorldData({}).pairs).toEqual([]);
    expect(readWorldData({ candidates: null, steps: [] }).pairs).toEqual([]);
    // Новый ход пишет `pairs: null` явно - выбор пар ещё впереди.
    expect(readWorldData(worldDataJson(emptyWorldData())).pairs).toBeNull();
  });

  it('a left-out entry saved before names reads with empty names; non-string names are dropped', () => {
    const saved = {
      ...(worldDataJson({
        ...emptyWorldData(),
        candidates: [],
        pairs: [],
        pairsOff: null,
      }) as Record<string, unknown>),
      leftOut: [
        { key: 'vera', reason: 'BELOW_MIN_CHAPTERS', chapters: 2 },
        { key: 'a--b', reason: 'PAIRS_MAX', names: [null, 'B', 3], chapters: 1 },
        { key: 'c', reason: 'KEY_PAIR_FORM', names: 'C', chapters: null },
      ],
    };
    expect(readWorldData(saved).leftOut).toEqual([
      { key: 'vera', reason: 'BELOW_MIN_CHAPTERS', names: [], chapters: 2 },
      { key: 'a--b', reason: 'PAIRS_MAX', names: ['B'], chapters: 1 },
      { key: 'c', reason: 'KEY_PAIR_FORM', names: [], chapters: null },
    ]);
  });

  it('pairs, left out and pairs off survive the round trip', () => {
    const data = {
      ...emptyWorldData(),
      candidates: [],
      pairs: [pair],
      leftOut: [
        { key: 'vera', reason: 'BELOW_MIN_CHAPTERS' as const, names: ['Vera'], chapters: 2 },
      ],
      pairsOff: null,
    };
    const read = readWorldData(worldDataJson(data));
    expect(read.pairs).toEqual([pair]);
    expect(read.leftOut).toEqual(data.leftOut);
    // Отметка пересчёта присутствия (уточнение Q1) переживает запись; хода без неё - нет.
    expect(
      readWorldData(worldDataJson({ ...data, mentionsRecounted: true })).mentionsRecounted,
    ).toBe(true);
    expect(read.mentionsRecounted).toBe(false);
    expect(readWorldData({ ...data, pairsOff: 'WORLD_PAIR_LANGUAGE' }).pairsOff).toBe(
      'WORLD_PAIR_LANGUAGE',
    );
  });

  it('a dropped pair or pairs of a wrong form - stepsBroken: a pair step never takes the next pair', () => {
    const base = { candidates: [hero] };
    expect(readWorldData({ ...base, pairs: [pair, { key: 'x' }] }).stepsBroken).toBe(true);
    expect(readWorldData({ ...base, pairs: 'x' }).stepsBroken).toBe(true);
    expect(readWorldData({ ...base, pairs: [pair] }).stepsBroken).toBe(false);
  });

  it('the entity of a pair item is a pair, of a hero item - a character with the role of the candidate', () => {
    const data = readWorldData({ candidates: [hero], pairs: [pair] });
    expect(entityKindOf(data, 'anna--boris')).toEqual({ type: 'pair' });
    expect(entityKindOf(data, 'anna')).toEqual({ type: 'character', role: 'main' });
    expect(entityKindOf(data, 'tom')).toEqual({ type: 'character', role: null });
  });
});

describe('world run data', () => {
  const step = {
    step: 0,
    kind: 'select',
    key: null,
    verdict: 'ok',
    remarks: [],
    attempt: 1,
    outcome: 'done',
    failedReason: null,
    authorModel: 'm',
    review: { kind: 'answered', model: 'r' },
    source: 'text',
    dropped: [],
  };
  const item = {
    key: 'anna',
    block: 'short',
    step: 1,
    verdict: 'ok',
    remarks: [],
    review: null,
    outcome: 'proposed',
    value: 'Short.',
    sources: null,
    name: 'Anna',
    base: 'abc',
    failedReason: null,
    regen: null,
    regenFailedReason: null,
  };

  it('reads back what it writes', () => {
    const data = readWorldData({
      ...(worldDataJson(emptyWorldData()) as object),
      steps: [step],
      items: [item],
    });
    expect(data.stepsBroken).toBe(false);
    expect(readWorldData(worldDataJson(data))).toEqual(data);
  });

  it('a step out of order or an item of a wrong form - stepsBroken: the run does not go on over broken data', () => {
    expect(readWorldData({ steps: [{ ...step, step: 1 }] }).stepsBroken).toBe(true);
    expect(readWorldData({ steps: [step], items: [{ ...item, block: 'nope' }] }).stepsBroken).toBe(
      true,
    );
    expect(readWorldData({ steps: 'x' }).stepsBroken).toBe(true);
    expect(readWorldData(null).stepsBroken).toBe(false);
  });
});

describe('block prints', () => {
  it('the value of the run and the block it was written into give one print (compactBlock)', () => {
    expect(valuePrint({ from: ' a ', to: 'b', stages: [] })).toBe(
      valuePrint({ from: 'a', to: 'b' }),
    );
    expect(valuePrint('')).toBe(valuePrint(null));
    expect(valuePrint('a')).not.toBe(valuePrint('b'));
  });

  it('an empty block: no value, blank text, empty list, an object of empty fields', () => {
    for (const v of [null, undefined, '  ', [], { position: '' }])
      expect(blockIsEmpty(v)).toBe(true);
    for (const v of ['x', [1], { position: 'p' }]) expect(blockIsEmpty(v)).toBe(false);
  });
});

describe('world run stages', () => {
  it('the stages are bound to the world task: its lease follows the longest page call, other tasks do not grow', () => {
    const stages = new LlmStageRegistry();
    registerAnalysisWriteStages(stages);
    registerWorldWriteStages(stages);
    const page = WORLD_WRITE_STAGE_DEFINITIONS.find((d) => d.stage === WORLD_PAGE_WRITE_STAGE);
    expect(stages.taskCallTimeoutMs(60_000, WORLD_WRITE_TASK_KIND)).toBe(page?.callTimeoutMs);
    expect(stages.taskCallTimeoutMs(60_000, 'other_task')).toBe(60_000);
    expect(stages.taskCallTimeoutMs(60_000, ANALYSIS_WRITE_TASK_KIND)).toBe(840_000);
  });

  it('a stage of the analysis cannot be bound to the world task too', () => {
    const stages = new LlmStageRegistry();
    registerAnalysisWriteStages(stages);
    expect(() => stages.registerTaskStages(WORLD_WRITE_TASK_KIND, ['analysis_review'])).toThrow();
  });
});

// Q5, `F08 | F08-9` Q2: ход мира берёт все пять языков enum; язык без эталона - нет (страж нового языка).
describe('world run languages', () => {
  it('ru, en, es, fr and pt are taken, a language without a sample is not', () => {
    expect(['ru', 'en', 'es', 'fr', 'pt', 'de'].map(isWorldWriteLanguage)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('world run candidates: the role (F08-8b)', () => {
  const candidate = { key: 'anna', name: 'Anna', aliases: [], mentions: { chapters: [1] } };

  it('keeps the role secondary through the stored run data', () => {
    const data = readWorldData(
      worldDataJson({
        ...emptyWorldData(),
        candidates: [
          { ...candidate, role: 'secondary', mentions: { chapters: [1], perChapter: {} } },
        ],
      }),
    );
    expect(data.candidates?.map((c) => c.role)).toEqual(['secondary']);
  });

  it('a run stored before F08-8b (no role) took only main heroes: its candidate reads as main', () => {
    const data = readWorldData({
      ...(worldDataJson(emptyWorldData()) as object),
      candidates: [candidate],
    });
    expect(data.candidates?.map((c) => c.role)).toEqual(['main']);
  });
});

describe('world run candidates: an unknown role (F08-8b)', () => {
  it('a candidate with a role other than main or secondary is not read: it never becomes main', () => {
    const raw = {
      key: 'vera',
      name: 'Vera',
      aliases: [],
      mentions: { chapters: [1] },
      role: 'minor',
    };
    const data = readWorldData({
      ...(worldDataJson(emptyWorldData()) as object),
      candidates: [raw],
    });
    expect(data.candidates).toEqual([]);
  });

  it('a dropped candidate between two good ones - stepsBroken: a hero step never takes the next hero by index', () => {
    const good = (key: string) => ({
      key,
      name: key,
      aliases: [],
      mentions: { chapters: [1] },
      role: 'main',
    });
    const data = readWorldData({
      ...(worldDataJson(emptyWorldData()) as object),
      candidates: [good('anna'), { ...good('vera'), role: 'minor' }, good('boris')],
    });
    expect(data.candidates?.map((c) => c.key)).toEqual(['anna', 'boris']);
    expect(data.stepsBroken).toBe(true);
    expect(
      readWorldData({
        ...(worldDataJson(emptyWorldData()) as object),
        candidates: [good('anna'), good('boris')],
      }).stepsBroken,
    ).toBe(false);
  });
});
