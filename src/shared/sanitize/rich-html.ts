import sanitizeHtml from 'sanitize-html';

// Копия того же списка живёт в books-front/lib/utils/rich-html.ts; оба сверяются своими тестами (LEGACY-414).
export const RICH_HTML_ALLOWED_TAGS: readonly string[] = [
  'p',
  'br',
  'strong',
  'em',
  'u',
  's',
  'code',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'a',
  'img',
];

export const RICH_HTML_ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  ol: ['start'],
  code: ['class'],
  p: ['style'],
  h1: ['style'],
  h2: ['style'],
  h3: ['style'],
  h4: ['style'],
  h5: ['style'],
  h6: ['style'],
};

export const RICH_HTML_ALLOWED_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];
export const RICH_HTML_IMG_SCHEMES: readonly string[] = ['http', 'https'];

// Допустимые значения атрибутов, которые проверяются не только по имени. Входят в белый список и сверяются с фронтом.
export const RICH_HTML_TEXT_ALIGN_STYLE =
  /^\s*text-align\s*:\s*(left|right|center|justify)\s*;?\s*$/i;
export const RICH_HTML_CODE_CLASS = /^language-[a-z0-9_+#-]+$/i;

// Теги, которые выбрасываются вместе с содержимым: умолчания DOMPurify и sanitize-html плюс object/embed/select.
// Один список на бэкенд и обе ветки фронта — иначе один и тот же HTML даёт разный текст на сервере и в браузере.
export const RICH_HTML_DROP_CONTENT_TAGS: readonly string[] = [
  'annotation-xml',
  'audio',
  'colgroup',
  'desc',
  'embed',
  'foreignobject',
  'head',
  'iframe',
  'math',
  'mi',
  'mn',
  'mo',
  'ms',
  'mtext',
  'noembed',
  'noframes',
  'noscript',
  'object',
  'option',
  'plaintext',
  'script',
  'select',
  'style',
  'svg',
  'template',
  'textarea',
  'thead',
  'title',
  'video',
  'xmp',
];

const VALUE_CHECKED_ATTRIBUTES: readonly string[] = ['style', 'class'];

// Та же проверка значения, что `isAllowedValue` во фронтовой копии (там же — схемы ссылок для DOMPurify).
function isAllowedValue(attr: string, value: string): boolean {
  if (attr === 'style') return RICH_HTML_TEXT_ALIGN_STYLE.test(value);
  if (attr === 'class') return RICH_HTML_CODE_CLASS.test(value);
  return false;
}

function keepOnlySafeAttributes(
  tagName: string,
  attribs: sanitizeHtml.Attributes,
): sanitizeHtml.Tag {
  const next: sanitizeHtml.Attributes = { ...attribs };
  for (const attr of VALUE_CHECKED_ATTRIBUTES) {
    const value = next[attr];
    if (value !== undefined && !isAllowedValue(attr, value)) delete next[attr];
  }
  return { tagName, attribs: next };
}

// Теги, у которых белый список разрешает атрибут с проверкой значения, выводятся из того же списка, а не пишутся рядом.
const VALUE_CHECKED_TAGS = Object.entries(RICH_HTML_ALLOWED_ATTRIBUTES)
  .filter(([, attrs]) => attrs.some((attr) => VALUE_CHECKED_ATTRIBUTES.includes(attr)))
  .map(([tag]) => tag);

const STRICT: sanitizeHtml.IOptions = {
  allowedTags: [...RICH_HTML_ALLOWED_TAGS],
  allowedAttributes: Object.fromEntries(
    Object.entries(RICH_HTML_ALLOWED_ATTRIBUTES).map(([tag, attrs]) => [tag, [...attrs]]),
  ),
  allowedSchemes: [...RICH_HTML_ALLOWED_SCHEMES],
  allowedSchemesByTag: { img: [...RICH_HTML_IMG_SCHEMES] },
  allowProtocolRelative: false,
  // style сверяется регэкспом целиком; разбор postcss переписал бы `text-align: center` и снял «байт в байт».
  parseStyleAttributes: false,
  nonTextTags: [...RICH_HTML_DROP_CONTENT_TAGS],
  transformTags: Object.fromEntries(VALUE_CHECKED_TAGS.map((tag) => [tag, keepOnlySafeAttributes])),
};

// Тот же парсер и сериализатор без фильтра: равенство с STRICT значит, что чистить было нечего.
const PASSTHROUGH: sanitizeHtml.IOptions = {
  allowedTags: false,
  allowedAttributes: false,
  allowVulnerableTags: true,
  allowedSchemesAppliedToAttributes: [],
  allowProtocolRelative: true,
  parseStyleAttributes: false,
  nonTextTags: [],
};

function countTagOpeners(text: string): number {
  return text.split('<').length - 1;
}

export function sanitizeRichHtml(html: string): string {
  const cleaned = sanitizeHtml(html, STRICT);
  if (cleaned === html) return html;
  const reserialized = sanitizeHtml(html, PASSTHROUGH);
  // Каждый `<` ввода должен дойти до вывода распознанным тегом. Что htmlparser2 выбросил целиком или прочёл текстом
  // (CDATA, комментарии, <?…>, doctype, голый `<`), браузер может разобрать как теги — и равенство проходов уже
  // не значит «чистить нечего».
  if (countTagOpeners(reserialized) !== countTagOpeners(html)) return cleaned;
  // Чистый ввод возвращается байт в байт: иначе пересохранение без правок меняет правовой хеш содержимого.
  return cleaned === reserialized ? html : cleaned;
}
