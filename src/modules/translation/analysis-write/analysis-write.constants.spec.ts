import {
  ANALYSIS_CAST_WRITE_STAGE,
  ANALYSIS_EXTERNAL_WRITE_STAGE,
  ANALYSIS_MEANING_WRITE_STAGE,
  ANALYSIS_QUOTES_WRITE_STAGE,
  ANALYSIS_READER_WRITE_STAGE,
  ANALYSIS_REVIEW_STAGE,
  ANALYSIS_WRITE_STAGE_DEFINITIONS,
} from './analysis-write.constants';

/** Сравнение моделей `F07-6` умолчания анализа не сменило (решение арбитра `F07 | F07-6`). */
describe('analysis write stage models', () => {
  const of = (stage: string) => ANALYSIS_WRITE_STAGE_DEFINITIONS.find((d) => d.stage === stage);

  it.each([
    ANALYSIS_CAST_WRITE_STAGE,
    ANALYSIS_QUOTES_WRITE_STAGE,
    ANALYSIS_MEANING_WRITE_STAGE,
    ANALYSIS_READER_WRITE_STAGE,
    ANALYSIS_EXTERNAL_WRITE_STAGE,
  ])('%s stays on GLM-5.3 with Qwen and Terra as fallbacks', (stage) => {
    expect(of(stage)).toMatchObject({
      model: 'z-ai/glm-5.3',
      fallbacks: ['qwen/qwen3.7-plus', 'openai/gpt-5.6-terra'],
    });
  });

  it('the blocks are reviewed by GPT-6 Luna with DeepSeek as the fallback', () => {
    expect(of(ANALYSIS_REVIEW_STAGE)).toMatchObject({
      model: 'openai/gpt-6-luna',
      fallbacks: ['deepseek/deepseek-v4-pro'],
    });
  });
});
