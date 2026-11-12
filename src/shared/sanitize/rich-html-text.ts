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

/** Видимый текст HTML; `tagText` - чем заменить тег (имя без `/` и атрибутов, в нижнем регистре). */
function visibleText(html: string, tagText: (name: string) => string): string {
  return html
    .replace(/<\/?([a-z][a-z0-9-]*)?[^>]*>/gi, (_whole, name?: string) =>
      tagText((name ?? '').toLowerCase()),
    )
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Видимый текст HTML: без тегов, сущности расшифрованы (любые числовые и таблица выше), знаки
 * нулевой ширины сняты, пробелы схлопнуты.
 */
export function richHtmlText(html: string): string {
  return visibleText(html, () => ' ');
}

/**
 * Строчные теги с текстом внутри: снимаются без пробела. Строчные теги белого списка санитайзера
 * (`INLINE_TAGS` в `modules/translation/chapter-blocks.ts`, кроме `br` и `img`) обязаны быть здесь,
 * блочные - нет; сверяет `chapter-blocks.spec.ts`. Остальные имена - строчные теги вне белого списка
 * (текст из импорта и сидов): лишний здесь строчный тег безвреден, недостающий даёт старый пробел.
 */
export const GLUED_TAGS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'label',
  'mark',
  'nobr',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  // Место возможного переноса внутри слова: не пробел.
  'wbr',
]);

/**
 * Видимый текст всего, что в переводе уходит модели или сравнивается с её текстом: механика куска
 * (`plain` в `mechanical-check.ts`), абзацы для модели (`htmlToParagraphs`), кодовая проверка главы,
 * выбор глоссария куска, поля версии, повтор на стыке при сборке, счёт слов и начало блока при
 * нарезке (`LEGACY-500`, `T193`). Правило пустого текста остаётся на `richHtmlText` - оно общее
 * с `htmlToPlainText` фронта. Строчные теги (`<em>`, `<a>`, `<span>`) снимаются без пробела,
 * любой другой (блочный, `<br>`, `<img>`, незнакомый) - с пробелом. Иначе «<em>x</em>,» читается
 * как «x ,» - пунктуационный брак, которого нет (`LEGACY-500`). Незнакомый тег - пробел, как
 * в `richHtmlText`: лишний пробел безопаснее склейки двух слов.
 */
export function richHtmlInlineText(html: string): string {
  return visibleText(html, (name) => (GLUED_TAGS.has(name) ? '' : ' '));
}
