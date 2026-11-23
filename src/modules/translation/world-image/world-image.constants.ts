import { Prisma } from '@prisma/client';
import { LlmImageLimits } from '../../llm/llm-image';
import { LlmStageDefinition, LlmStageRegistry } from '../../llm/llm-stages.registry';

/**
 * Иллюстрация героя мира книги (`F08-11a`, `features/F08-book-wiki/tech.md` §10; решения арбитра
 * `F08 | F08-11`). Этап - свой, вне этапов хода «Write World»: задачу картинки ставит кнопка
 * администратора, а не ход (Р4).
 */
export const WORLD_IMAGE_STAGE = 'world_image';

/** Вид задачи исполнителя: один вызов модели и запись ожидающей картинки. */
export const WORLD_IMAGE_TASK_KIND = 'world_image';

/**
 * Модель по умолчанию - пример документации OpenRouter `POST /images` (23.11.2026) с `resolution: 2K`,
 * вживую не проверена (решение арбитра `F08 | F08-11a` Q3; живая проверка размера - `F08-11c`);
 * меняется на экране «LLM settings» без выката. `maxTokens` у картинки не читается: резерв -
 * `WORLD_IMAGE_RESERVE_USD`.
 */
export const WORLD_IMAGE_STAGE_DEFINITION: LlmStageDefinition = {
  stage: WORLD_IMAGE_STAGE,
  model: 'bytedance-seed/seedream-4.5',
  fallbacks: [],
  temperature: null,
  maxTokens: 1,
  enabled: true,
  callTimeoutMs: 180_000,
};

/**
 * Резерв одной попытки - потолок цены картинки: у моделей картинок цена за картинку, а не за токен.
 * Пример документации - $0.13 за картинку высокого качества `openai/gpt-image-2`; факт пишет
 * `usage.cost`. Оценка кнопки и лимит операции считаются от него (Р4).
 */
export const WORLD_IMAGE_RESERVE_USD = new Prisma.Decimal('0.25');

/**
 * Предел **портрета** (решение арбитра Р1): файл до 12 МБ, ширина и высота от 1200 px (`product.md` §8;
 * портрет 1:1 - полоса 2048×300 портретом не считается; место 16:9 в `F08-12` заводит свой предел),
 * не больше 40 млн пикселей - заголовок с огромными размерами отбивается до записи.
 */
export const WORLD_IMAGE_LIMITS: LlmImageLimits = {
  maxBytes: 12 * 1024 * 1024,
  minWidth: 1200,
  minHeight: 1200,
  maxPixels: 40_000_000,
};

/** Портрет героя - квадрат (`tech.md` §10: 1200×1200). */
export const WORLD_IMAGE_ASPECT_RATIO = '1:1';

/** 409: генерация этой картинки уже идёт. */
export const WORLD_IMAGE_IN_PROGRESS = 'WORLD_IMAGE_IN_PROGRESS';
/** 409: сущность не герой `main`/`secondary` (Р5). */
export const WORLD_IMAGE_NOT_ALLOWED = 'WORLD_IMAGE_NOT_ALLOWED';
/** 409: у героя нет описания внешности - портрет рисуется только по тексту книги (`product.md` §8). */
export const WORLD_IMAGE_NO_APPEARANCE = 'WORLD_IMAGE_NO_APPEARANCE';
/** 409: принимать нечего - ожидающей картинки нет (Р3). */
export const WORLD_IMAGE_NONE = 'WORLD_IMAGE_NONE';
/** 409: ожидающая картинка не та, которую видел администратор (её перегенерировали). */
export const WORLD_IMAGE_CHANGED = 'WORLD_IMAGE_CHANGED';
/** Отказ шага: героя или его внешности не стало, пока задача ждала. */
export const WORLD_IMAGE_INPUT_MISSING = 'WORLD_IMAGE_INPUT_MISSING';

export function registerWorldImageStages(stages: LlmStageRegistry): void {
  stages.register(WORLD_IMAGE_STAGE_DEFINITION);
  stages.registerTaskStages(WORLD_IMAGE_TASK_KIND, [WORLD_IMAGE_STAGE]);
}
