export const msgExactlyOne = (a: string, b: string) =>
  `Exactly one of ${a} or ${b} must be provided`;

export const msgExactlyOneOf = (list: string[]) =>
  `Exactly one of [${list.join(', ')}] must be provided`;

// Короткое описание — простой текст из поля ввода: чистки HTML нет, только предел (LEGACY-414).
export const SHORT_TEXT_MAX_LENGTH = 10_000;

// Пары FAQ - простой текст, уходит в JSON-LD публичных страниц (LEGACY-419). Предел, а не чистка.
export const FAQ_QUESTION_MAX_LENGTH = 1_000;
export const FAQ_ANSWER_MAX_LENGTH = 10_000;

// Потолки простого ввода пользователя (LEGACY-462). Формы фронта строже (отзыв 2000, ответ 1000,
// имя 50) — здесь запас на клиентов мимо формы, а не второй источник правды для формы.
export const COMMENT_TEXT_MAX_LENGTH = 5_000;
export const USER_NAME_MAX_LENGTH = 100;
// Название и автор версии книги: правила ручного создания и правки версии, их же проверяет
// конвейер перевода, где DTO не работает (`F05-6`, этап `metadata`).
export const VERSION_TITLE_MIN_LENGTH = 2;
export const VERSION_AUTHOR_MAX_LENGTH = 500;
// Строка поиска: дольше её не набирают, а `ILIKE '%…%'` по длинной строке — лишняя работа базы.
export const SEARCH_QUERY_MAX_LENGTH = 200;
