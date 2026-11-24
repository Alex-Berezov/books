import { LlmImageLimits } from '../../llm/llm-image';

/**
 * Иллюстрация героя мира книги (`F08-11a`, `features/F08-book-wiki/tech.md` §10; решения арбитра
 * `F08 | F08-11`). Генерация картинки моделью снята (`F08-11d-1`, решение владельца: сайт картинки
 * не генерирует); вкладка World показывает принятую и ожидающую ячейки, «Accept» - у администратора.
 */

/**
 * Вид задачи прежней генерации. Задачи этого вида, поставленные до снятия, разбирает сливной
 * обработчик (`WorldImageHandler`, решение арбитра `F08 | F08-11d` Q7): без обработчика они
 * висели бы `pending` у активной операции.
 */
export const WORLD_IMAGE_TASK_KIND = 'world_image';

/** Причина отказа задачи прежней генерации: генерация снята, модель не зовётся. */
export const WORLD_IMAGE_GENERATION_REMOVED = 'WORLD_IMAGE_GENERATION_REMOVED';

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

/** 409: сущность не герой `main`/`secondary` (Р5). */
export const WORLD_IMAGE_NOT_ALLOWED = 'WORLD_IMAGE_NOT_ALLOWED';
/** 409: принимать нечего - ожидающей картинки нет (Р3). */
export const WORLD_IMAGE_NONE = 'WORLD_IMAGE_NONE';
/** 409: ожидающая картинка не та, которую видел администратор (её заменили). */
export const WORLD_IMAGE_CHANGED = 'WORLD_IMAGE_CHANGED';
