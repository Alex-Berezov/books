import { LlmStageDefinition, LlmStageRegistry } from '../../llm/llm-stages.registry';
import { CHECK_CALL_TIMEOUT_MS, CHECK_REASONING_ANSWER_RESERVE } from '../check/check.constants';
import { GPT_TERRA_MODEL } from '../translate/translate.constants';
import { BLOCK_KEY_MAX } from '../../../shared/validators/block-fields.decorator';

/**
 * Этапы хода «Write World» (`F08-4a`; `books-app-docs/features/F08-book-wiki/tech.md` §5): выбор героев
 * и форм имени, страница героя, внешние блоки с проверкой источников, страница пары (`F08-8e`)
 * и проверяющая другого семейства.
 * Свои этапы, а не этапы анализа: этап закреплён за одним видом задачи (`registerTaskStages`), аренда
 * задачи считается от таймаутов своих этапов (урок аренды `F06-1`/`F07-1`). Умолчания - как у этапов
 * анализа, на которые указывает `tech.md` §5; замер цены - `F08-6`.
 */
export const WORLD_SELECT_STAGE = 'world_select';
export const WORLD_PAGE_WRITE_STAGE = 'world_page_write';
export const WORLD_EXTERNAL_WRITE_STAGE = 'world_external_write';
/** Страница пары героев (`F08-8e`, решение арбитра `F08 | F08-8e-1` Q2): умолчания страницы героя. */
export const WORLD_PAIR_WRITE_STAGE = 'world_pair_write';
export const WORLD_REVIEW_STAGE = 'world_review';

/** Вид задачи исполнителя хода мира (`ContentDraft` вида `world_write`). */
export const WORLD_WRITE_TASK_KIND = 'world_write';

/**
 * Языки хода (`F08-9`; решения арбитра `F08 | F08-4` Q5, `F08 | F08-9` Q2): у каждого есть эталон в
 * `examples/`. Список - страж нового языка enum `Language`: язык без эталона и правил промпта ход не берёт.
 */
export const WORLD_WRITE_LANGUAGES = ['ru', 'en', 'es', 'fr', 'pt'] as const;
export type WorldWriteLanguage = (typeof WORLD_WRITE_LANGUAGES)[number];

export const isWorldWriteLanguage = (language: string): language is WorldWriteLanguage =>
  (WORLD_WRITE_LANGUAGES as readonly string[]).includes(language);

/**
 * Потолок пар на ход (решение арбитра `F08 | F08-8e-1` Q3): сначала связанные в анализе, затем по
 * убыванию общих глав, при равенстве - по ключу; остальные - отсеянные с `PAIRS_MAX`.
 */
export const WORLD_PAIRS_MAX = 10;

/**
 * Места хода (`F08-12b`, решение арбитра `F08 | F08-12b` Q1): место досье остаётся кандидатом, если
 * стоит не меньше чем в `WORLD_PLACE_MIN_CHAPTERS` главах (ядро места - две сцены; порог героев
 * `WORLD_MIN_CHAPTERS` - своя константа), не больше `WORLD_PLACES_MAX` по убыванию глав, затем по ключу.
 */
export const WORLD_PLACE_MIN_CHAPTERS = 2;
export const WORLD_PLACES_MAX = 10;

/**
 * Шаг пары не платит за вызов (решение арбитра `F08 | F08-8e-1` Q1, Q4): героя пары нет в мире версии
 * (`WORLD_PAIR_MEMBER_MISSING`), ключ пары занят сущностью другого типа (`WORLD_PAIR_KEY_TAKEN`),
 * несвязанная в анализе пара без общих глав (новая и заведённая) или новая пара, не прошедшая условие
 * заведения по сохранённому присутствию (`WORLD_PAIR_NOT_FOUNDED`),
 * пересчёт присутствия перед новой парой (до первого успешного) не сошёлся - текст сдвинулся (`WORLD_MENTIONS_MOVED`).
 */
export const WORLD_PAIR_MEMBER_MISSING = 'WORLD_PAIR_MEMBER_MISSING';
export const WORLD_PAIR_KEY_TAKEN = 'WORLD_PAIR_KEY_TAKEN';
export const WORLD_PAIR_NOT_FOUNDED = 'WORLD_PAIR_NOT_FOUNDED';
export const WORLD_MENTIONS_MOVED = 'WORLD_MENTIONS_MOVED';
/** Шаг места не платит за вызов (`F08-12b`, Q1): ключ места заняли сущностью другого типа после выбора. */
export const WORLD_PLACE_KEY_TAKEN = 'WORLD_PLACE_KEY_TAKEN';
/** Шаг места: формы названия не нашли место ни в одной главе (`F08-12b`, у героя - `WORLD_CHARACTER_NOT_FOUND`). */
export const WORLD_PLACE_NOT_FOUND = 'WORLD_PLACE_NOT_FOUND';

/**
 * Предметы и понятия хода (`F08-13b`, решение арбитра `F08 | F08-13b` Q1): сущность досье остаётся
 * кандидатом, если формы названия нашли её хотя бы в одной главе (ядро без сцен), не больше 10 на тип
 * по убыванию глав, затем по ключу.
 */
export const WORLD_OBJECT_MIN_CHAPTERS = 1;
export const WORLD_OBJECTS_MAX = 10;
export const WORLD_TERM_MIN_CHAPTERS = 1;
export const WORLD_TERMS_MAX = 10;
/**
 * Шаг предмета (понятия) не платит за вызов (`F08-13b`, Q1): ключ заняли сущностью другого типа после
 * выбора (`*_KEY_TAKEN`) или формы названия не нашли сущность ни в одной главе (`*_NOT_FOUND`).
 */
export const WORLD_OBJECT_KEY_TAKEN = 'WORLD_OBJECT_KEY_TAKEN';
export const WORLD_OBJECT_NOT_FOUND = 'WORLD_OBJECT_NOT_FOUND';
export const WORLD_TERM_KEY_TAKEN = 'WORLD_TERM_KEY_TAKEN';
export const WORLD_TERM_NOT_FOUND = 'WORLD_TERM_NOT_FOUND';

/**
 * События хода (`F08-13b-2`, решения арбитра `F08 | F08-13b` Q2-Q4): кандидаты предлагает шаг выбора -
 * отдельные эпизоды, не больше 10 на ход по убыванию глав, затем по ключу; событие без известной
 * главы версии отсекается до платного шага.
 */
export const WORLD_EVENTS_MAX = 10;
/** Предел длины ключа события из латиницы по названию (`F08 | F08-13b` Q3) - предел ключа мира. */
export const WORLD_EVENT_KEY_MAX = BLOCK_KEY_MAX;
/**
 * Шаг события не платит за вызов (`F08-13b-2`): ключ заняли сущностью другого типа после выбора
 * (`WORLD_EVENT_KEY_TAKEN`) или нет главы, где формы названия или выбор нашли событие (`WORLD_EVENT_NOT_FOUND`).
 */
export const WORLD_EVENT_KEY_TAKEN = 'WORLD_EVENT_KEY_TAKEN';
export const WORLD_EVENT_NOT_FOUND = 'WORLD_EVENT_NOT_FOUND';

/**
 * Номер шага вне всех списков хода (`F08-13b`): данные хода не те - шага с таким номером нет
 * (`stepAt` - `null`); отказ записывается видом последнего в порядке шагов (`event`), но своим кодом,
 * а не как шаг события.
 */
export const WORLD_STEP_OUT_OF_RUN = 'WORLD_STEP_OUT_OF_RUN';

/** Таймаут вызова страницы героя: 32 000 токенов ответа, как у шага толкований анализа. */
const PAGE_CALL_TIMEOUT_MS = 840_000;

const AUTHOR = 'z-ai/glm-5.3';
const AUTHOR_FALLBACKS = ['qwen/qwen3.7-plus', GPT_TERRA_MODEL];

export const WORLD_WRITE_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: WORLD_SELECT_STAGE,
    model: AUTHOR,
    fallbacks: AUTHOR_FALLBACKS,
    temperature: 0.2,
    maxTokens: 8_000,
    enabled: true,
    reasoningAnswerReserve: 3_000,
    callTimeoutMs: CHECK_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
  {
    stage: WORLD_PAGE_WRITE_STAGE,
    model: AUTHOR,
    fallbacks: AUTHOR_FALLBACKS,
    temperature: 0.4,
    maxTokens: 32_000,
    enabled: true,
    reasoningAnswerReserve: 12_000,
    callTimeoutMs: PAGE_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
  {
    stage: WORLD_PAIR_WRITE_STAGE,
    model: AUTHOR,
    fallbacks: AUTHOR_FALLBACKS,
    temperature: 0.4,
    maxTokens: 32_000,
    enabled: true,
    reasoningAnswerReserve: 12_000,
    callTimeoutMs: PAGE_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
  {
    stage: WORLD_EXTERNAL_WRITE_STAGE,
    model: AUTHOR,
    fallbacks: AUTHOR_FALLBACKS,
    temperature: 0.4,
    maxTokens: 16_000,
    enabled: true,
    reasoningAnswerReserve: 6_000,
    callTimeoutMs: CHECK_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
  {
    stage: WORLD_REVIEW_STAGE,
    model: 'openai/gpt-6-luna',
    fallbacks: ['deepseek/deepseek-v4-pro'],
    temperature: 0,
    maxTokens: 16_000,
    enabled: true,
    reasoningAnswerReserve: CHECK_REASONING_ANSWER_RESERVE,
    callTimeoutMs: CHECK_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
];

/** Регистрация этапов хода мира: видны на «LLM settings» и закреплены за задачей хода (аренда). */
export function registerWorldWriteStages(stages: LlmStageRegistry): void {
  for (const definition of WORLD_WRITE_STAGE_DEFINITIONS) stages.register(definition);
  stages.registerTaskStages(
    WORLD_WRITE_TASK_KIND,
    WORLD_WRITE_STAGE_DEFINITIONS.map((d) => d.stage),
  );
}

/**
 * Отказы старта и оценки (409, решение арбитра `F08 | F08-4`, Q4, Q5): у версии нет анализа или
 * в нём нет героя `main` - кандидатов нет, из досье они не берутся; язык версии вне `WORLD_WRITE_LANGUAGES` -
 * страж нового языка enum без эталона (`F08 | F08-9` Q2).
 */
export const WORLD_ANALYSIS_MISSING = 'WORLD_ANALYSIS_MISSING';
export const WORLD_LANGUAGE_UNSUPPORTED = 'WORLD_LANGUAGE_UNSUPPORTED';

/** Запуск перевода с «Write World» без «Write Analysis» - 400 (решение арбитра `F08 | F08-9b`, Q2). */
export const WORLD_NEEDS_ANALYSIS = 'WORLD_NEEDS_ANALYSIS';

/**
 * Отказы ручек `content-drafts/:id/*` хода мира - как у хода анализа (`F07 | F07-1`, В6):
 * `WORLD_WRITE_NOT_READY` - ход строится, упал или отброшен; `WORLD_ITEM_UNKNOWN` (400) - нет пункта
 * с таким номером; `WORLD_ITEM_NOT_PROPOSED` - пункт не предложение; `WORLD_BLOCK_CHANGED` - блок
 * сущности изменили после предложения (в теле `current`); `WORLD_PROPOSAL_CHANGED` - предложение
 * перегенерировали после того, как его прочитали; `WORLD_WRITE_REFUSED` - импорт мира отказал
 * в записи (ссылка, глава, цитата на слитой записи); `WORLD_REGEN_IN_PROGRESS` - блок перегенерируется;
 * `WORLD_ITEM_NOT_REGENERABLE` - формы имени не перегенерируются (их пишет выбор героев).
 */
export const WORLD_WRITE_NOT_READY = 'WORLD_WRITE_NOT_READY';
export const WORLD_ITEM_UNKNOWN = 'WORLD_ITEM_UNKNOWN';
export const WORLD_ITEM_NOT_PROPOSED = 'WORLD_ITEM_NOT_PROPOSED';
export const WORLD_BLOCK_CHANGED = 'WORLD_BLOCK_CHANGED';
export const WORLD_PROPOSAL_CHANGED = 'WORLD_PROPOSAL_CHANGED';
export const WORLD_WRITE_REFUSED = 'WORLD_WRITE_REFUSED';
export const WORLD_REGEN_IN_PROGRESS = 'WORLD_REGEN_IN_PROGRESS';
export const WORLD_ITEM_NOT_REGENERABLE = 'WORLD_ITEM_NOT_REGENERABLE';

/** Почему «Accept all» оставил пункт предложением (как у хода анализа, `F07 | F07-3`, п.7). */
export const WORLD_ACCEPT_ALL_SKIP_CODES = [
  WORLD_WRITE_REFUSED,
  WORLD_BLOCK_CHANGED,
  WORLD_REGEN_IN_PROGRESS,
] as const;
export type WorldAcceptAllSkipCode = (typeof WORLD_ACCEPT_ALL_SKIP_CODES)[number];
