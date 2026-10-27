import { LlmStageDefinition } from '../../llm/llm-stages.registry';
import { GPT_TERRA_MODEL } from '../translate/translate.constants';

export const DOSSIER_STAGE = 'dossier';
export const GLOSSARY_STAGE = 'glossary';

/** Виды задач исполнителя: досье (куски глав по одному, затем сводка) и глоссарий пары. */
export const DOSSIER_TASK_KIND = 'dossier';
export const GLOSSARY_TASK_KIND = 'glossary';

/** Лимит операции досье - оценка × 1,5 (`F05-2`, шаг 7), если редактор не задал свой. */
export const DOSSIER_LIMIT_FACTOR = '1.5';

/** Глав в исходнике досье: больше - 409 `SOURCE_TOO_MANY_CHAPTERS`, выборка без потолка не пишется. */
export const DOSSIER_MAX_CHAPTERS = 2_000;

/**
 * Умолчания этапов (`tech.md` §3: Claude, длинный контекст), запасная - `GPT_TERRA_MODEL`.
 */
export const DOSSIER_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: DOSSIER_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [GPT_TERRA_MODEL],
    temperature: 0.2,
    maxTokens: 16_000,
    enabled: true,
  },
  {
    stage: GLOSSARY_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [GPT_TERRA_MODEL],
    temperature: 0.2,
    maxTokens: 16_000,
    enabled: true,
  },
];

/** Отказ шага по ответу модели не по форме (после повтора с замечанием). */
export const DOSSIER_INVALID_RESPONSE = 'DOSSIER_INVALID_RESPONSE';
/**
 * Вход сводки с ответом не влезает в контекст модели этапа: строка `failed` без вызова и без
 * перехвата (решение арбитра `F05 | F05-2`); ту же строку автоматически не перестраивают.
 */
export const DOSSIER_TOO_LONG = 'DOSSIER_TOO_LONG';

/** Текст исходника поменялся посреди построения: куски уже не те, что в отпечатке. */
export const DOSSIER_SOURCE_CHANGED = 'DOSSIER_SOURCE_CHANGED';
