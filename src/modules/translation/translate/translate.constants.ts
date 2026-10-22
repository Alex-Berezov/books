import { LlmStageDefinition } from '../../llm/llm-stages.registry';

export const SPLIT_STAGE = 'split';
export const TRANSLATE_STAGE = 'translate';

/**
 * Умолчания этапов (`tech.md` §3). `split` - бесплатные модели, последний запасной - код
 * (`fallbackBoundary`, Р7); `translate` - Claude, запасных в коде нет: модель перевода и запасные
 * выбирает `F05-R` по сравнению (U7), до тех пор их ставит редактор на экране «LLM settings»
 * (решение арбитра `F05 | F05-2` о запасных без точных id).
 */
export const TRANSLATE_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: SPLIT_STAGE,
    model: 'google/gemma-4-31b-it:free',
    fallbacks: ['minimax/minimax-m3.1-flash:free'],
    temperature: 0,
    maxTokens: 200,
    enabled: true,
  },
  {
    stage: TRANSLATE_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [],
    temperature: 0.2,
    maxTokens: 16_000,
    enabled: true,
  },
];

/** Повторов с замечанием у ответа перевода не по форме (карточка `F05-3`, шаг 2). */
export const TRANSLATE_REMARKS = 2;

/** Хвост предыдущего переведённого куска той же модели: последние блоки до этого числа символов. */
export const TRANSLATE_TAIL_MAX_CHARS = 1_500;
