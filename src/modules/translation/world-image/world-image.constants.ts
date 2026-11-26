import {
  IMAGE_NOT_IMAGE,
  IMAGE_TOO_LARGE,
  IMAGE_TOO_SMALL,
  ImageLimits,
  ImageRefusal,
} from '../../../shared/image/image-check';

/**
 * Иллюстрация героя и места мира книги (`F08-11a`, `F08-12c-2`, `features/F08-book-wiki/tech.md` §10; решения арбитра
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
 * портрет 1:1 - полоса 2048×300 портретом не считается; у места свой предел - `WORLD_PLACE_IMAGE_LIMITS`),
 * не больше 40 млн пикселей - заголовок с огромными размерами отбивается до записи.
 * Копия чисел на фронте - `WORLD_IMAGE_FILE_LIMITS` (`books-front/lib/admin/book-world-blocks.ts`):
 * подсказка у поля загрузки, проверка размера до отправки и тексты отказов; менять вместе.
 */
export const WORLD_IMAGE_LIMITS: ImageLimits = {
  maxBytes: 12 * 1024 * 1024,
  minWidth: 1200,
  minHeight: 1200,
  maxPixels: 40_000_000,
};

/**
 * Предел **картинки места** (`F08-12c-2`, решения `F08 | F08-12b` R1, `F08 | F08-12c-2`): кадр -
 * ширина от 1200 px, высота от 675 px; файл и пиксели - как у портрета. Копия чисел на фронте -
 * `WORLD_PLACE_IMAGE_FILE_LIMITS` (`books-front/lib/admin/book-world-blocks.ts`); менять вместе.
 */
export const WORLD_PLACE_IMAGE_LIMITS: ImageLimits = {
  ...WORLD_IMAGE_LIMITS,
  minHeight: 675,
};

/** Предел файла по типу сущности: место - от 1200×675, герой - портрет от 1200×1200. */
export function worldImageLimitsOf(type: string): ImageLimits {
  return type === 'place' ? WORLD_PLACE_IMAGE_LIMITS : WORLD_IMAGE_LIMITS;
}

/**
 * 409: строка картинки ключа занята сущностью другого типа другой версии книги (герой в одной версии,
 * место в другой; решение арбитра `F08 | F08-12c-2`).
 */
export const WORLD_IMAGE_KEY_CONFLICT = 'WORLD_IMAGE_KEY_CONFLICT';
/**
 * 409: тип своей сущности сменился между чтением и замком строки (импорт мира шёл параллельно,
 * `F08-12c-2` круг 2): предел и занятость решены по устаревшему типу - перечитать. Роль, сменившаяся
 * с потерей права, - `WORLD_IMAGE_NOT_ALLOWED`; с сохранением права - не отказ.
 */
export const WORLD_IMAGE_ENTITY_CHANGED = 'WORLD_IMAGE_ENTITY_CHANGED';
/** 409: сущность не герой `main`/`secondary` и не место (Р5, `F08-12c-2`). */
export const WORLD_IMAGE_NOT_ALLOWED = 'WORLD_IMAGE_NOT_ALLOWED';
/** 409: принимать нечего - ожидающей картинки нет (Р3). */
export const WORLD_IMAGE_NONE = 'WORLD_IMAGE_NONE';
/** 409: ожидающая картинка не та, которую видел администратор (её заменили). */
export const WORLD_IMAGE_CHANGED = 'WORLD_IMAGE_CHANGED';

/** Поле формы загрузки: один файл `file`, текстовых полей нет (`F08-11d-3`, `FormFileInterceptor`). */
export const WORLD_IMAGE_UPLOAD_FIELD = 'file';
/** 400/413: отказ файла иллюстрации - коды ответа ручки загрузки (`F08-11d-3`). */
export const WORLD_IMAGE_TOO_LARGE = 'WORLD_IMAGE_TOO_LARGE';
export const WORLD_IMAGE_REFUSAL_CODES: Record<ImageRefusal, string> = {
  [IMAGE_NOT_IMAGE]: 'WORLD_IMAGE_NOT_IMAGE',
  [IMAGE_TOO_LARGE]: WORLD_IMAGE_TOO_LARGE,
  [IMAGE_TOO_SMALL]: 'WORLD_IMAGE_TOO_SMALL',
};
