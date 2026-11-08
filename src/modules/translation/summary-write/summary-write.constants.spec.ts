import { familyOf } from '../check/semantic-check';
import {
  SUMMARY_BRIEF_WRITE_STAGE,
  SUMMARY_FULL_WRITE_STAGE,
  SUMMARY_REVIEW_STAGE,
  SUMMARY_SECTION_WRITE_STAGE,
  SUMMARY_WRITE_STAGE_DEFINITIONS,
} from './summary-write.constants';

/** Умолчания этапов по сравнению моделей `F07-6` (решение арбитра `F07 | F07-6`). */
describe('summary write stage models', () => {
  const of = (stage: string) => SUMMARY_WRITE_STAGE_DEFINITIONS.find((d) => d.stage === stage);

  it.each([SUMMARY_SECTION_WRITE_STAGE, SUMMARY_FULL_WRITE_STAGE, SUMMARY_BRIEF_WRITE_STAGE])(
    '%s is written by GPT-6 Luna with GLM-5.3 and Qwen as fallbacks',
    (stage) => {
      expect(of(stage)).toMatchObject({
        model: 'openai/gpt-6-luna',
        fallbacks: ['z-ai/glm-5.3', 'qwen/qwen3.7-plus'],
      });
    },
  );

  it('the text is reviewed by Haiku 5.5 with DeepSeek as the fallback', () => {
    expect(of(SUMMARY_REVIEW_STAGE)).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      fallbacks: ['deepseek/deepseek-v4-pro'],
    });
  });

  it('no reviewer shares a family with any author of the chain (U4)', () => {
    const chain = (stage: string) => {
      const definition = of(stage);
      return [definition?.model ?? '', ...(definition?.fallbacks ?? [])].map(familyOf);
    };
    const authors = [
      SUMMARY_SECTION_WRITE_STAGE,
      SUMMARY_FULL_WRITE_STAGE,
      SUMMARY_BRIEF_WRITE_STAGE,
    ].flatMap(chain);
    expect(authors).not.toContain('');
    for (const family of chain(SUMMARY_REVIEW_STAGE)) {
      expect(authors).not.toContain(family);
    }
  });
});
