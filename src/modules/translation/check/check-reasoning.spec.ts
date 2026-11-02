import { CONTENT_DRAFT_STAGE_DEFINITIONS } from '../content-draft/content-draft.constants';
import { DOSSIER_STAGE_DEFINITIONS } from '../dossier/dossier.constants';
import {
  FINAL_CHECK_STAGE,
  FINAL_CHECK_STAGE_DEFINITIONS,
} from '../final-check/final-check.constants';
import { METADATA_STAGE_DEFINITIONS } from '../metadata/metadata.constants';
import {
  SUMMARY_BRIEF_WRITE_STAGE,
  SUMMARY_FULL_WRITE_STAGE,
  SUMMARY_REVIEW_STAGE,
  SUMMARY_SECTION_WRITE_STAGE,
  SUMMARY_WRITE_STAGE_DEFINITIONS,
} from '../summary-write/summary-write.constants';
import { TRANSLATE_STAGE_DEFINITIONS } from '../translate/translate.constants';
import { CHECK_SEMANTIC_STAGE, CHECK_STAGE_DEFINITIONS } from './check.constants';

/**
 * Потолок рассуждений - только у проверяющих этапов (`LEGACY-478`, решение арбитра `F05 | F05-13`)
 * и у этапов чистовика `F06` (решение `F06 | F06-1`, В1):
 * у перевода, досье, полей версии и заготовок рассуждения без потолка, как раньше. Сам потолок
 * (`maxTokens` минус резерв) в тело запроса кладут `LlmService.callStage` и клиент - их спеки.
 */
const all = [
  ...DOSSIER_STAGE_DEFINITIONS,
  ...TRANSLATE_STAGE_DEFINITIONS,
  ...CHECK_STAGE_DEFINITIONS,
  ...METADATA_STAGE_DEFINITIONS,
  ...FINAL_CHECK_STAGE_DEFINITIONS,
  ...CONTENT_DRAFT_STAGE_DEFINITIONS,
  ...SUMMARY_WRITE_STAGE_DEFINITIONS,
];

/** Этапы чистовика `F06` - с резервом, своим таймаутом и обрывом (решение арбитра `F06 | F06-1`, В1). */
const SUMMARY_WRITE = [
  SUMMARY_BRIEF_WRITE_STAGE,
  SUMMARY_FULL_WRITE_STAGE,
  SUMMARY_REVIEW_STAGE,
  SUMMARY_SECTION_WRITE_STAGE,
];

describe('reasoning answer reserve of the translation stages', () => {
  it('only the meaning check, the final check and the F06 write stages carry a reserve', () => {
    const withReserve = all
      .filter((d) => d.reasoningAnswerReserve !== undefined)
      .map((d) => d.stage)
      .sort();
    expect(withReserve).toEqual([CHECK_SEMANTIC_STAGE, FINAL_CHECK_STAGE, ...SUMMARY_WRITE].sort());
  });

  it('the F06 stages carry the reserve and maxTokens of tech.md §3', () => {
    const of = (stage: string) => all.find((d) => d.stage === stage);
    expect(of(SUMMARY_SECTION_WRITE_STAGE)).toMatchObject({
      maxTokens: 16_000,
      reasoningAnswerReserve: 6_000,
    });
    expect(of(SUMMARY_FULL_WRITE_STAGE)).toMatchObject({
      maxTokens: 24_000,
      reasoningAnswerReserve: 10_000,
    });
    expect(of(SUMMARY_BRIEF_WRITE_STAGE)).toMatchObject({
      maxTokens: 16_000,
      reasoningAnswerReserve: 5_000,
    });
    expect(of(SUMMARY_REVIEW_STAGE)).toMatchObject({
      maxTokens: 16_000,
      reasoningAnswerReserve: 4_000,
    });
  });

  it('both carry the reserve 4000 at the default maxTokens 16000', () => {
    for (const stage of [CHECK_SEMANTIC_STAGE, FINAL_CHECK_STAGE]) {
      const definition = all.find((d) => d.stage === stage);
      expect(definition?.maxTokens).toBe(16_000);
      expect(definition?.reasoningAnswerReserve).toBe(4_000);
    }
  });
});

// Таймаут вызова 420 с - только у проверяющих (`LEGACY-479`, решение арбитра `F05 | F05-13c`) и у этапов
// чистовика `F06` (600 с у полного, решение `F06 | F06-1`, В1): остальные этапы - общий таймаут.
describe('call timeout of the translation stages', () => {
  it('only the meaning check, the final check and the F06 stages carry their own call timeout', () => {
    const withTimeout = all.filter((d) => d.callTimeoutMs !== undefined);
    expect(Object.fromEntries(withTimeout.map((d) => [d.stage, d.callTimeoutMs]))).toEqual({
      [CHECK_SEMANTIC_STAGE]: 420_000,
      [FINAL_CHECK_STAGE]: 420_000,
      [SUMMARY_SECTION_WRITE_STAGE]: 420_000,
      [SUMMARY_FULL_WRITE_STAGE]: 600_000,
      [SUMMARY_BRIEF_WRITE_STAGE]: 420_000,
      [SUMMARY_REVIEW_STAGE]: 420_000,
    });
  });
});

// Оборванный лимитом ответ без вердикта не повторяется - только у проверяющих (`LEGACY-480`,
// решение арбитра `F05 | F05-13d`) и у этапов чистовика `F06` (решение `F06 | F06-1`, В1): перевод,
// досье и глоссарий по-прежнему повторяют с замечанием.
describe('truncation without a remark retry', () => {
  it('only the meaning check, the final check and the F06 stages end the model on a cut-off answer', () => {
    const flagged = all.filter((d) => d.truncationEndsModel === true);
    expect(flagged.map((d) => d.stage).sort()).toEqual(
      [CHECK_SEMANTIC_STAGE, FINAL_CHECK_STAGE, ...SUMMARY_WRITE].sort(),
    );
  });
});
