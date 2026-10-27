import { CONTENT_DRAFT_STAGE_DEFINITIONS } from '../content-draft/content-draft.constants';
import { DOSSIER_STAGE_DEFINITIONS } from '../dossier/dossier.constants';
import { METADATA_STAGE_DEFINITIONS } from '../metadata/metadata.constants';
import { GPT_TERRA_MODEL } from '../translate/translate.constants';
import { runModelsOf, runStageModels } from './run-models';
import { RUN_HISTORY_STAGES } from './translation-run.constants';

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

  describe('models of the run in its history (F05-8, В4)', () => {
    const STAGES = ['dossier', 'split', 'translate', 'check_language_jev', 'metadata'];
    const WITH_MORE = {
      ...SNAPSHOT,
      stages: [
        ...SNAPSHOT.stages,
        { stage: 'dossier', model: 'd/dossier', fallbacks: ['d/spare'] },
        // Выключенный в снимке этап - тоже выбранная модель: включённость шаг читает живой.
        { stage: 'check_language_jev', model: 'j/jev', fallbacks: [], enabled: false },
        { stage: 'metadata', model: '', fallbacks: [] },
      ],
    };

    it('lists the stages in the pipeline order with the model and fallbacks the step takes', () => {
      expect(runModelsOf(WITH_MORE, {}, STAGES)).toEqual([
        { stage: 'dossier', model: 'd/dossier', fallbacks: ['d/spare'] },
        { stage: 'split', model: 'c/split', fallbacks: [] },
        { stage: 'translate', model: 'a/main', fallbacks: ['b/fallback'] },
        { stage: 'check_language_jev', model: 'j/jev', fallbacks: [] },
      ]);
    });

    it('the run override wins over the snapshot; an override that is not a string is ignored', () => {
      expect(
        runModelsOf(WITH_MORE, { translate: 'z/other', split: null, dossier: 7 }, STAGES),
      ).toEqual([
        { stage: 'dossier', model: 'd/dossier', fallbacks: ['d/spare'] },
        { stage: 'split', model: 'c/split', fallbacks: [] },
        { stage: 'translate', model: 'z/other', fallbacks: [] },
        { stage: 'check_language_jev', model: 'j/jev', fallbacks: [] },
      ]);
      expect(runModelsOf(null, {}, STAGES)).toEqual([]);
    });
  });

  it('the history lists the run stages in the pipeline order (F05-8, В4)', () => {
    expect(RUN_HISTORY_STAGES).toEqual([
      'split',
      'translate',
      'check_semantic',
      'check_language_jev',
      'metadata',
      'final_check',
    ]);
  });
});

describe('stage defaults on Claude (Р7 F05-R)', () => {
  it('dossier, glossary, version fields and drafts fall back to the model checked in the catalog', () => {
    const stages = [
      ...DOSSIER_STAGE_DEFINITIONS,
      ...METADATA_STAGE_DEFINITIONS,
      ...CONTENT_DRAFT_STAGE_DEFINITIONS,
    ];
    expect(stages.map((d) => d.stage).sort()).toEqual(
      [
        'analysis_draft',
        'dossier',
        'glossary',
        'metadata',
        'summary_brief',
        'summary_full',
        'summary_sections',
      ].sort(),
    );
    for (const d of stages) {
      expect(d).toMatchObject({
        model: 'anthropic/claude-sonnet-5.5',
        fallbacks: [GPT_TERRA_MODEL],
      });
    }
    expect(GPT_TERRA_MODEL).toBe('openai/gpt-5.6-terra');
  });
});
