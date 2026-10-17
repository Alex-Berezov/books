/**
 * Именованные сущности, которые решают вопрос «есть ли текст»: пробелы и невидимые знаки.
 * Неизвестная именованная сущность остаётся как есть и считается текстом. Копия правила на фронте -
 * `htmlToPlainText` в `books-front/lib/utils/html-text.ts` (таблица - `lib/utils/html-entities.ts`):
 * разойдутся - бэкенд примет пересказ, а страница ответит 404, или наоборот.
 */
const TEXT_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwnj: '',
  zwj: '',
};

/** Знаки нулевой ширины: не пробел для `\s`, но и не текст. */
const INVISIBLE_CHARS = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;

function decodeEntity(whole: string, name: string): string {
  if (name[0] !== '#') return TEXT_ENTITIES[name.toLowerCase()] ?? whole;
  const code =
    name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
}

/**
 * Видимый текст HTML: без тегов, сущности расшифрованы (любые числовые и таблица выше), знаки
 * нулевой ширины сняты, пробелы схлопнуты.
 */
export function richHtmlText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}
