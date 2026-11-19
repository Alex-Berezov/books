import type { StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
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
  readWorldData,
  stepAt,
  stepsTotalOf,
  valuePrint,
  worldDataJson,
} from './world-write.data';
import { mainCharacters, worldCharacters } from './world-write.steps';

describe('world run steps', () => {
  it('step 0 chooses the characters, then each candidate gets a page and its external blocks', () => {
    expect([0, 1, 2, 3, 4].map(stepAt)).toEqual([
      { kind: 'select', candidate: null },
      { kind: 'page', candidate: 0 },
      { kind: 'external', candidate: 0 },
      { kind: 'page', candidate: 1 },
      { kind: 'external', candidate: 1 },
    ]);
    expect(stepsTotalOf({ candidates: null })).toBeNull();
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
      }),
    ).toBe(3);
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

// Q5: ход мира - только ru и en до `F08-9`; эталоны промпта есть только у них.
describe('world run languages', () => {
  it('ru and en are taken, es, fr and pt are not', () => {
    expect(['ru', 'en', 'es', 'fr', 'pt'].map(isWorldWriteLanguage)).toEqual([
      true,
      true,
      false,
      false,
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
});

describe('world run candidates: who goes into the run (F08-8b)', () => {
  it('main heroes first, then secondary ones; minor heroes are never candidates', () => {
    const analysis = {
      characters: [
        { key: 'boris', name: 'Boris', role: 'secondary' },
        { key: 'vera', name: 'Vera', role: 'minor' },
        { key: 'anna', name: 'Anna', role: 'main' },
      ],
    } as unknown as StoredBookAnalysis;
    expect(worldCharacters(analysis)).toEqual([
      { key: 'anna', name: 'Anna', role: 'main' },
      { key: 'boris', name: 'Boris', role: 'secondary' },
    ]);
    expect(mainCharacters(analysis).map((c) => c.key)).toEqual(['anna']);
  });
});
