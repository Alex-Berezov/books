import { sanitizeRichHtml } from '../../../shared/sanitize/rich-html';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { ChapterBlock, INLINE_TAGS } from '../chapter-blocks';
import { Shape } from '../dossier/dossier.format';

/**
 * Формы ответов этапов `split` и `translate` (`F05-3`, шаги 1-2). Лишние поля формой не ошибка, но
 * и не хранятся: из ответа перевода берутся только `n` и `text` блоков, служебный текст вне
 * блоков отбрасывается.
 */

export const SPLIT_SHAPE: Shape = { object: { boundaryBlock: 'int' } };

export const TRANSLATE_SHAPE: Shape = {
  object: {
    blocks: { array: { object: { n: 'int', text: 'string' } } },
    // Неполные находки глоссария - не повод для повтора и отказа: сравнение их не хранит (С2),
    // запуск берёт годные (`glossaryFindingsOf`).
    glossaryFindings: {
      unchecked: {
        array: { object: { source: 'string', target: 'string', kind: 'string', note: 'string' } },
      },
    },
  },
};

export interface TranslatedBlock {
  n: number;
  text: string;
}

export interface GlossaryFinding {
  source: string;
  target: string;
  kind: string;
  note: string;
}

/** Находок с куска не больше: глоссарий общий на язык и идёт в промпт каждого куска. */
export const GLOSSARY_FINDINGS_MAX = 30;
/** Предел длины написания и вида находки; длиннее - не термин, а пересказ, находка отбрасывается. */
export const GLOSSARY_FINDING_TERM_MAX = 120;
/** Предел длины пояснения находки. */
export const GLOSSARY_FINDING_NOTE_MAX = 300;
/**
 * Короче - не берётся: записи глоссария ищутся в тексте куска подстрокой (`glossaryFor`), и «I»
 * или «an» попадали бы в промпт каждого куска. Имя с заглавной - от двух букв: «Li», «Ed» -
 * герои, а не служебные слова (`product.md` §3 п.3, одно написание имени на книгу).
 */
export const GLOSSARY_FINDING_SOURCE_MIN = 3;
const GLOSSARY_FINDING_NAME_MIN = 2;

function findingSourceLongEnough(source: string): boolean {
  const name = /^\p{Lu}/u.test(source);
  return source.length >= (name ? GLOSSARY_FINDING_NAME_MIN : GLOSSARY_FINDING_SOURCE_MIN);
}

/**
 * Годные находки глоссария из ответа (`F05-4`): с непустыми написаниями не длиннее предела,
 * не больше `GLOSSARY_FINDINGS_MAX`; прочие поля - строкой. Ответа нет - находок нет.
 */
export function glossaryFindingsOf(value: unknown): GlossaryFinding[] {
  if (!isRecord(value)) return [];
  const raw = value.glossaryFindings;
  if (!Array.isArray(raw)) return [];
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const term = (v: string) => v !== '' && v.length <= GLOSSARY_FINDING_TERM_MAX;
  return raw
    .filter(isRecord)
    .map((f) => ({
      source: text(f.source),
      target: text(f.target),
      kind: text(f.kind),
      note: text(f.note),
    }))
    .filter(
      (f) =>
        term(f.source) &&
        findingSourceLongEnough(f.source) &&
        term(f.target) &&
        f.kind.length <= GLOSSARY_FINDING_TERM_MAX &&
        f.note.length <= GLOSSARY_FINDING_NOTE_MAX,
    )
    .slice(0, GLOSSARY_FINDINGS_MAX);
}

/** Номера блоков ответа против блоков куска: каждый ровно один раз, чужих нет. */
export function translateBlockErrors(value: unknown, expected: readonly number[]): string[] {
  const blocks = (value as { blocks: TranslatedBlock[] }).blocks;
  const wanted = new Set(expected);
  const seen = new Set<number>();
  const errors: string[] = [];
  for (const block of blocks) {
    if (!wanted.has(block.n)) errors.push(`$.blocks: block ${block.n} is not in this piece`);
    else if (seen.has(block.n)) errors.push(`$.blocks: block ${block.n} is repeated`);
    seen.add(block.n);
  }
  const missing = expected.filter((n) => !seen.has(n));
  if (missing.length > 0) errors.push(`$.blocks: missing blocks ${missing.join(', ')}`);
  const empty = blocks.filter((b) => wanted.has(b.n) && b.text.trim() === '').map((b) => b.n);
  if (empty.length > 0) errors.push(`$.blocks: empty text in blocks ${empty.join(', ')}`);
  return errors;
}

/**
 * Ответ, который белый список разметки сводит к пустому (`<p></p>`, вырезанный `<script>`):
 * такой блок дошёл бы до главы пустым абзацем - модель получает замечание (`F05-3`, круг 1).
 */
export function cleanedBlockErrors(
  value: unknown,
  kinds: ReadonlyMap<number, Pick<ChapterBlock, 'kind' | 'html'>>,
): string[] {
  const blocks = (value as { blocks: TranslatedBlock[] }).blocks;
  const empty = blocks
    // Пусто для читателя: ни видимого текста (`<em></em>`, `&nbsp;`), ни картинки.
    .filter((b) => {
      const html = blockText(kinds.get(b.n) ?? { kind: 'p', html: '' }, b.text);
      return richHtmlText(html) === '' && !/<img\b/i.test(html);
    })
    .map((b) => b.n);
  return empty.length > 0
    ? [
        `$.blocks: blocks ${empty.join(', ')} are empty after removing markup; keep only inline tags`,
      ]
    : [];
}

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

const IMG = /<img\b[^>]*>/gi;
const LINK_OPEN = /<a(?=[\s>/])[^>]*>/gi;
const LINK_TAG = new RegExp(`${LINK_OPEN.source}|<\\/a\\s*>`, 'gi');
/**
 * Атрибуты тега по порядку: значение в двойных, одинарных кавычках или без них. Разбор подряд,
 * а не поиск ` href=` по тексту тега: иначе `href` внутри значения соседнего атрибута
 * (`rel="x href=…"`) прочитался бы как настоящий (`L-008`). `sanitizeRichHtml` отдаёт чистый
 * ввод байт в байт - кавычки бывают любые.
 */
const ATTR = /\s([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** Значение атрибута тега (первое, как у браузера); `&amp;` и `&` - одно и то же. */
function attrOf(tag: string, name: string): string | undefined {
  // Срезается только `>`: `/` перед ним - часть значения без кавычек (`href=/docs/`), а одинокий
  // `/` самозакрытого тега атрибутом не разбирается.
  const body = tag.replace(/^<[a-zA-Z][a-zA-Z0-9]*/, '').replace(/>$/, '');
  for (const m of body.matchAll(ATTR)) {
    if (m[1].toLowerCase() === name) return (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&');
  }
  return undefined;
}

/**
 * Ссылка остаётся, только если её `href` был в исходном блоке; иначе снимается тег, текст ссылки
 * остаётся (решение арбитра `F05 | F05-4b`). Оставленная ссылка получает открывающий тег
 * исходника, а не ответа модели: ни чужой `href`, ни выдуманные `target`/`rel` в главу не идут.
 * Закрывающий тег снимается вместе со своим открывающим.
 */
function keepSourceLinks(html: string, sourceTags: ReadonlyMap<string, string>): string {
  const kept: boolean[] = [];
  return html.replace(LINK_TAG, (tag) => {
    if (tag.startsWith('</')) return kept.pop() ? tag : '';
    const own = sourceTags.get(attrOf(tag, 'href') ?? '');
    kept.push(own !== undefined);
    return own ?? '';
  });
}

/**
 * Перевод блока для сборки: строчная разметка белого списка (`sanitizeRichHtml`, затем только
 * строчные теги - блочный тег внутри блока сломал бы оболочку главы). Картинка остаётся, только
 * если её `src` был в исходном блоке: чужой адрес из ответа модели в главу не попадает (решение
 * арбитра `F05 | F05-3`, круг 3); ссылка - так же по `href` (`F05 | F05-4b`). Атрибут картинки -
 * текст без тегов с экранированными кавычками.
 */
export function blockText(block: Pick<ChapterBlock, 'kind' | 'html'>, text: string): string {
  if (block.kind === 'img-alt' || block.kind === 'img-title') {
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .trim();
  }
  const source = sanitizeRichHtml(block.html);
  const sources = new Set(
    // Пустой `src` исходника ничего не разрешает: иначе прошла бы картинка модели без адреса.
    [...source.matchAll(IMG)].map((m) => attrOf(m[0], 'src')).filter((s) => !!s),
  );
  // Первый тег на адрес: одинаковые ссылки исходника различаются разве что `target`/`rel`.
  const sourceTags = new Map<string, string>();
  for (const m of source.matchAll(LINK_OPEN)) {
    const href = attrOf(m[0], 'href');
    if (href && !sourceTags.has(href)) sourceTags.set(href, m[0]);
  }
  const inline = sanitizeRichHtml(text)
    .replace(TAG, (tag, name: string) => (INLINE_TAGS.has(name.toLowerCase()) ? tag : ''))
    .replace(IMG, (img) => (sources.has(attrOf(img, 'src') ?? '') ? img : ''));
  return keepSourceLinks(inline, sourceTags).trim();
}
