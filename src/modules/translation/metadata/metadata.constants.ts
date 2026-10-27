import { LlmStageDefinition } from '../../llm/llm-stages.registry';
import { GPT_TERRA_MODEL } from '../translate/translate.constants';

export const METADATA_STAGE = 'metadata';

/**
 * Умолчание этапа `metadata` (`tech.md` §3: «как `dossier`, `glossary`» - Claude, длинный контекст
 * и качество чтения). Описание книги идёт блоками и бывает длинным (до `RICH_HTML_MAX_LENGTH.text`),
 * поэтому выход - как у перевода куска. Запасная - `GPT_TERRA_MODEL`.
 */
export const METADATA_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: METADATA_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [GPT_TERRA_MODEL],
    temperature: 0.2,
    maxTokens: 16_000,
    enabled: true,
  },
];

/** Повторов с замечанием у ответа не по форме - как у досье. */
export const METADATA_REMARKS = 1;

/**
 * Попыток этапа до `failed` языка (карточка `F05-6`, шаг 4: «повтор этапа с замечанием, затем
 * `failed` языка»): ответ, повтор с замечаниями проверки.
 */
export const METADATA_ATTEMPTS_MAX = 2;

/**
 * Коды отказа языка на этапе `metadata`: ответ не прошёл проверки после повтора; вход не влезает
 * в контекст модели этапа.
 */
export const METADATA_INVALID = 'METADATA_INVALID';
export const METADATA_TOO_LONG = 'METADATA_TOO_LONG';

/**
 * Причина языка на паузе `NO_COMPLIANT_PROVIDER` этапа `metadata` - своя, как у сверки смысла:
 * выход - `stageModels.metadata`, а не `translate`.
 */
export const METADATA_NO_COMPLIANT_PROVIDER = 'METADATA_NO_COMPLIANT_PROVIDER';
