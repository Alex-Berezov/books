/**
 * Боты, краулеры и безголовые браузеры по User-Agent: счётчики посещений их не пишут (решение арбитра
 * `F08 | F08-3` Q5 для счётчика мира книги). Одно правило на все счётчики: второй список ботов
 * разошёлся бы с первым при первой же правке. Сырой User-Agent нигде не хранится.
 */
const BOT_UA = /bot|crawler|spider|slurp|headless/i;

export const isBotUserAgent = (userAgent: string | undefined): boolean =>
  typeof userAgent === 'string' && BOT_UA.test(userAgent);
