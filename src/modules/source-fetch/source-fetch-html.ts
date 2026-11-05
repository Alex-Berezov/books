export const MAX_TEXT_LENGTH = 20_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  // Мягкий перенос и знаки нулевой ширины - не текст: «Dosto&shy;evsky» - это «Dostoevsky».
  shy: '',
  zwnj: '',
  zwj: '',
};

/** Знаки нулевой ширины: не пробел для `\s`, но и не текст (как `richHtmlText`). */
const INVISIBLE_CHARS = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;

const SKIPPED_ELEMENTS = ['script', 'style', 'noscript'];

/** Начало закрывающего тега `</name` без учёта регистра от `from`; нет - `-1`. Линейно: шаблон без возврата. */
function closingTag(html: string, name: string, from: number): number {
  const pattern = new RegExp(`</${name}`, 'gi');
  pattern.lastIndex = from;
  return pattern.exec(html)?.index ?? -1;
}

/**
 * Разметка без регулярок с возвратом: каждый `<` разбирается один раз через `indexOf`, поэтому
 * время линейно от длины страницы. Регулярка `<[^>]*>` на 2 МБ знаков `<` без `>` работала бы за
 * квадрат и держала бы цикл событий минутами (класс `LEGACY-475`). Незакрытый комментарий, тег
 * или `script` - конец текста: дальше разметка, а не содержимое.
 */
function stripMarkup(html: string): string {
  const parts: string[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open === -1) {
      parts.push(html.slice(at));
      break;
    }
    parts.push(html.slice(at, open), ' ');
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      if (end === -1) break;
      at = end + 3;
      continue;
    }
    // Регистр - по срезу самого имени, а не по `toLowerCase` всей страницы: у части знаков нижний
    // регистр длиннее («İ» → два знака), и индексы сдвинулись бы относительно `html`.
    const skipped = SKIPPED_ELEMENTS.find(
      (name) =>
        html.slice(open + 1, open + 1 + name.length).toLowerCase() === name &&
        !/[a-z0-9-]/i.test(html[open + 1 + name.length] ?? ''),
    );
    const from = skipped ? closingTag(html, skipped, open + 1) : open + 1;
    if (from === -1) break;
    const close = html.indexOf('>', from);
    if (close === -1) break;
    at = close + 1;
  }
  return parts.join('');
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1].toLowerCase() === 'x';
      const code = isHex ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      const isValid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return isValid ? String.fromCodePoint(code) : ' ';
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Текст страницы без разметки. Это не санитайзер для вывода в HTML, а подготовка текста для модели:
 * script/style/комментарии вырезаются вместе с содержимым, остальные теги — в пробел. Сущности
 * декодируются после вырезания тегов, чтобы `&lt;b&gt;` остался текстом.
 */
export function htmlToText(html: string, maxLength = MAX_TEXT_LENGTH): string {
  return plainToText(decodeEntities(stripMarkup(html)).replace(INVISIBLE_CHARS, ''), maxLength);
}

/** Схлопывание пробелов и обрезка по длине (для text/plain и итога разбора HTML). */
export function plainToText(text: string, maxLength = MAX_TEXT_LENGTH): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
