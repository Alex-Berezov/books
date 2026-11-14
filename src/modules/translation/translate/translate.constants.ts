import { LlmStageDefinition } from '../../llm/llm-stages.registry';

export const SPLIT_STAGE = 'split';

/**
 * GPT-5.6 Terra - умолчание перевода (Р2 `F05 | F05-R`) и запасная этапов на Claude: досье,
 * глоссарий, поля версии, заготовки (Р7). Сверена с каталогом в `F05-R`: есть цена, строгие схемы
 * всех этапов прошли живую пробу, контекст не меньше, чем у Claude. Этапы проверок её не берут.
 */
export const GPT_TERRA_MODEL = 'openai/gpt-5.6-terra';
export const TRANSLATE_STAGE = 'translate';

/**
 * Умолчания этапов (`tech.md` §3). `split` - бесплатная модель, запасной - сразу код
 * (`fallbackBoundary`, Р7): бесплатные запасные пропадают из каталога (`minimax/minimax-m3.1-flash:free`
 * 27.10.2026, `xingchen-agi/xing4.0-29b-a4b:free` к 14.11.2026 - экран не сохранял этап), а
 * оставшиеся бесплатные запрет хранения не принимают (живая проба 14.11.2026: `nvidia/nemotron-3.5-super-vl:free`
 * - 404 «data policy»; решение арбитра 14.11.2026, 3а);
 * `translate` - GPT-5.6 Terra, запасная Claude Sonnet 5.5: выбор по сравнению на одной главе
 * (U7, решение арбитра `F05 | F05-R`, Р2); оба другого семейства, чем проверяющие.
 */
export const TRANSLATE_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: SPLIT_STAGE,
    model: 'google/gemma-4-31b-it:free',
    fallbacks: [],
    temperature: 0,
    maxTokens: 200,
    enabled: true,
  },
  {
    stage: TRANSLATE_STAGE,
    model: GPT_TERRA_MODEL,
    fallbacks: ['anthropic/claude-sonnet-5.5'],
    temperature: 0.2,
    maxTokens: 16_000,
    enabled: true,
  },
];

/** Повторов с замечанием у ответа перевода не по форме (карточка `F05-3`, шаг 2). */
export const TRANSLATE_REMARKS = 2;

/** Хвост предыдущего переведённого куска той же модели: последние блоки до этого числа символов. */
export const TRANSLATE_TAIL_MAX_CHARS = 1_500;
