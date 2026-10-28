import { CONTENT_DRAFT_STAGE_DEFINITIONS } from '../content-draft/content-draft.constants';
import { DOSSIER_STAGE_DEFINITIONS } from '../dossier/dossier.constants';
import {
  FINAL_CHECK_STAGE,
  FINAL_CHECK_STAGE_DEFINITIONS,
} from '../final-check/final-check.constants';
import { METADATA_STAGE_DEFINITIONS } from '../metadata/metadata.constants';
import { TRANSLATE_STAGE_DEFINITIONS } from '../translate/translate.constants';
import { CHECK_SEMANTIC_STAGE, CHECK_STAGE_DEFINITIONS } from './check.constants';

/**
 * Потолок рассуждений - только у проверяющих этапов (`LEGACY-478`, решение арбитра `F05 | F05-13`):
 * у перевода, досье, полей версии и заготовок рассуждения без потолка, как раньше. Сам потолок
 * (`maxTokens` минус резерв) в тело запроса кладут `LlmService.callStage` и клиент - их спеки.
 */
describe('reasoning answer reserve of the translation stages', () => {
  const all = [
    ...DOSSIER_STAGE_DEFINITIONS,
    ...TRANSLATE_STAGE_DEFINITIONS,
    ...CHECK_STAGE_DEFINITIONS,
    ...METADATA_STAGE_DEFINITIONS,
    ...FINAL_CHECK_STAGE_DEFINITIONS,
    ...CONTENT_DRAFT_STAGE_DEFINITIONS,
  ];

  it('only the meaning check and the final check carry a reserve', () => {
    const withReserve = all
      .filter((d) => d.reasoningAnswerReserve !== undefined)
      .map((d) => d.stage)
      .sort();
    expect(withReserve).toEqual([CHECK_SEMANTIC_STAGE, FINAL_CHECK_STAGE].sort());
  });

  it('both carry the reserve 4000 at the default maxTokens 16000', () => {
    for (const stage of [CHECK_SEMANTIC_STAGE, FINAL_CHECK_STAGE]) {
      const definition = all.find((d) => d.stage === stage);
      expect(definition?.maxTokens).toBe(16_000);
      expect(definition?.reasoningAnswerReserve).toBe(4_000);
    }
  });
});
