import { runStageModels } from './run-models';

describe('stage models of a translation run (F05-4a, В1)', () => {
  const SNAPSHOT = {
    takenAt: '2026-10-22T00:00:00.000Z',
    stages: [
      { stage: 'translate', model: 'a/main', fallbacks: ['b/fallback'] },
      { stage: 'split', model: 'c/split', fallbacks: [] },
    ],
    prices: null,
  };

  it('takes the model and the fallbacks of the stage from the snapshot', () => {
    expect(runStageModels(SNAPSHOT, {}, 'translate')).toEqual({
      model: 'a/main',
      fallbacks: ['b/fallback'],
    });
  });

  it('a stage model of the run is one model without fallbacks', () => {
    expect(runStageModels(SNAPSHOT, { translate: 'z/other' }, 'translate')).toEqual({
      model: 'z/other',
      fallbacks: [],
    });
    expect(runStageModels(SNAPSHOT, { translate: 'z/other' }, 'split')).toEqual({
      model: 'c/split',
      fallbacks: [],
    });
  });

  it('a stage missing in the snapshot goes on the live setting', () => {
    expect(runStageModels(SNAPSHOT, {}, 'metadata')).toEqual({});
    expect(runStageModels(null, {}, 'translate')).toEqual({});
    expect(runStageModels({ stages: 'junk' }, {}, 'translate')).toEqual({});
  });
});
