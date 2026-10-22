import { Parser } from 'htmlparser2';
import { richHtmlText } from '../../shared/sanitize/rich-html-text';

/**
 * Вид блока главы (`tech.md` §2, «Формат текста»). `text` - строчный текст вне блочного тега
 * (в корне главы, в `figure` вне подписи); `img-alt`/`img-title` - атрибуты картинки в `figure`;
 * `hr` - разделитель сцены, непереводимый, но с номером: по нему режется глава.
 */
export type ChapterBlockKind =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'blockquote'
  | 'li'
  | 'pre'
  | 'hr'
  | 'figcaption'
  | 'img-alt'
  | 'img-title'
  | 'text';

export interface ChapterBlock {
  /** Номер блока в главе с 1: модель возвращает перевод с тем же номером. */
  n: number;
  kind: ChapterBlockKind;
  /** Содержимое блока как в главе: строчная разметка, у атрибутов - значение с сущностями. */
  html: string;
  translatable: boolean;
}

/**
 * Раскладка главы: блоки и оболочка между ними. `parts` - куски исходного `content` вперемешку
 * с номерами блоков; сборка подставляет блоки на их номера, поэтому оболочка (теги списков,
 * цитат, `figure`, `img` без атрибутов) возвращается байт в байт.
 */
export interface ChapterLayout {
  format: 'html' | 'plain';
  blocks: ChapterBlock[];
  parts: Array<string | number>;
}

export const LEAF_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre']);
/** Блочные теги: строчный текст вокруг них режется на отдельные блоки. */
export const BLOCK_TAGS = new Set([
  ...LEAF_BLOCKS,
  'blockquote',
  'ul',
  'ol',
  'li',
  'hr',
  'figure',
  'figcaption',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
/**
 * Строчные теги белого списка санитайзера: остаются внутри блока. Вместе с `BLOCK_TAGS` покрывают
 * `RICH_HTML_ALLOWED_TAGS` целиком - сверяет спека: новый тег белого списка без места здесь
 * разбор молча счёл бы строчным.
 */
export const INLINE_TAGS = new Set(['br', 'strong', 'em', 'u', 's', 'code', 'a', 'img']);
const IMG_TEXT_ATTRS = /\s(alt|title)="([^"]*)"/g;

interface TextNode {
  type: 'text';
  start: number;
  end: number;
}

interface ElementNode {
  type: 'element';
  name: string;
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
  children: Node[];
}

type Node = TextNode | ElementNode;

interface Range {
  start: number;
  end: number;
  kind: ChapterBlockKind;
  translatable: boolean;
}

/** Есть ли разметка: глава без единого тега - plain-текст и режется по пустым строкам. */
function isPlainText(content: string): boolean {
  return !/<[a-zA-Z/!]/.test(content);
}

/** Пусто для перевода: ни видимого текста (правило `richHtmlText`), ни картинки. */
function isBlank(html: string): boolean {
  return richHtmlText(html) === '' && !/<img\b/i.test(html);
}

function parseTree(content: string): ElementNode {
  const root: ElementNode = {
    type: 'element',
    name: '#root',
    start: 0,
    innerStart: 0,
    innerEnd: content.length,
    end: content.length,
    children: [],
  };
  const stack: ElementNode[] = [root];
  const parser = new Parser(
    {
      onopentag(name) {
        const node: ElementNode = {
          type: 'element',
          name,
          start: parser.startIndex,
          innerStart: parser.endIndex + 1,
          innerEnd: parser.endIndex + 1,
          end: parser.endIndex + 1,
          children: [],
        };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      },
      onclosetag(name, isImplied) {
        const node = stack.pop();
        if (!node) return;
        if (VOID_TAGS.has(name)) return; // границы уже стоят на открывающем теге
        if (isImplied) {
          // Закрыт неявно (конец главы, закрытие родителя): содержимое - до этого места.
          node.innerEnd = node.end = parser.startIndex;
        } else {
          node.innerEnd = parser.startIndex;
          node.end = parser.endIndex + 1;
        }
      },
      ontext() {
        const parent = stack[stack.length - 1];
        const last = parent.children[parent.children.length - 1];
        // Текст приходит кусками: соседние куски - один узел.
        if (last?.type === 'text' && last.end === parser.startIndex) {
          last.end = parser.endIndex + 1;
        } else {
          parent.children.push({
            type: 'text',
            start: parser.startIndex,
            end: parser.endIndex + 1,
          });
        }
      },
    },
    { decodeEntities: false },
  );
  parser.write(content);
  parser.end();
  return root;
}

function collectImgAttrs(content: string, node: Node, out: Range[]): void {
  if (node.type !== 'element') return;
  if (node.name === 'img') {
    const tag = content.slice(node.start, node.innerStart);
    for (const match of tag.matchAll(IMG_TEXT_ATTRS)) {
      const valueStart = node.start + (match.index ?? 0) + match[0].length - match[2].length - 1;
      if (isBlank(match[2])) continue;
      out.push({
        start: valueStart,
        end: valueStart + match[2].length,
        kind: match[1] === 'alt' ? 'img-alt' : 'img-title',
        translatable: true,
      });
    }
    return;
  }
  for (const child of node.children) collectImgAttrs(content, child, out);
}

/**
 * Обходит контейнер: блочные дети - отдельно, строчные подряд идущие узлы между ними - один
 * блок вида `runKind` (`li` с текстом и вложенным списком даёт блок текста и блоки списка).
 */
function walk(content: string, container: ElementNode, runKind: ChapterBlockKind, out: Range[]) {
  let run: Node[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const start = run[0].start;
    const end = run[run.length - 1].end;
    run = [];
    if (isBlank(content.slice(start, end))) return;
    out.push({ start, end, kind: runKind, translatable: true });
  };
  for (const child of container.children) {
    if (child.type === 'text' || !BLOCK_TAGS.has(child.name)) {
      run.push(child);
      continue;
    }
    flush();
    visitBlock(content, child, out);
  }
  flush();
}

function visitBlock(content: string, node: ElementNode, out: Range[]): void {
  if (LEAF_BLOCKS.has(node.name)) {
    if (isBlank(content.slice(node.innerStart, node.innerEnd))) return;
    out.push({
      start: node.innerStart,
      end: node.innerEnd,
      kind: node.name as ChapterBlockKind,
      translatable: true,
    });
    return;
  }
  switch (node.name) {
    case 'hr':
      out.push({ start: node.start, end: node.end, kind: 'hr', translatable: false });
      return;
    case 'blockquote':
    case 'li':
    case 'figcaption':
      walk(content, node, node.name, out);
      return;
    case 'ul':
    case 'ol':
      walk(content, node, 'text', out);
      return;
    case 'figure':
      visitFigure(content, node, out);
      return;
  }
}

/**
 * `figure` - непереводимая оболочка: переводятся `alt` и `title` картинки и подпись. Строчный
 * текст `figure` вне подписи без картинки внутри - блок `text`.
 */
function visitFigure(content: string, figure: ElementNode, out: Range[]): void {
  for (const child of figure.children) {
    if (child.type === 'element' && BLOCK_TAGS.has(child.name)) {
      visitBlock(content, child, out);
      continue;
    }
    const images: Range[] = [];
    collectImgAttrs(content, child, images);
    if (images.length > 0) {
      out.push(...images);
      continue;
    }
    // Картинка без `alt` и `title` - переводить в ней нечего, она остаётся оболочкой.
    if (/<img\b/i.test(content.slice(child.start, child.end))) continue;
    if (!isBlank(content.slice(child.start, child.end))) {
      out.push({ start: child.start, end: child.end, kind: 'text', translatable: true });
    }
  }
}

/** Plain-текст: блок - абзац между пустыми строками, переводы строк внутри абзаца остаются. */
function plainRanges(content: string): Range[] {
  const ranges: Range[] = [];
  // Переводы строк любые: `\n` и `\r\n` (текст из Windows) - один и тот же разрыв абзаца.
  const paragraph = /\S(?:[^\r\n]|\r?\n(?![ \t]*\r?\n))*/g;
  for (const match of content.matchAll(paragraph)) {
    const start = match.index ?? 0;
    const end = start + match[0].trimEnd().length;
    ranges.push({ start, end, kind: 'p', translatable: true });
  }
  return ranges;
}

/**
 * Разбор `content` главы на блоки абзацного уровня с номерами. Вход - текст после санитайзера
 * (`sanitizeRichHtml`): внутри блока остаются только строчные теги его белого списка.
 */
export function splitChapter(content: string): ChapterLayout {
  const format = isPlainText(content) ? 'plain' : 'html';
  let ranges: Range[];
  if (format === 'plain') {
    ranges = plainRanges(content);
  } else {
    ranges = [];
    walk(content, parseTree(content), 'text', ranges);
    ranges.sort((a, b) => a.start - b.start);
  }
  const blocks: ChapterBlock[] = [];
  const parts: Array<string | number> = [];
  let cursor = 0;
  for (const range of ranges) {
    const n = blocks.length + 1;
    if (range.start > cursor) parts.push(content.slice(cursor, range.start));
    parts.push(n);
    blocks.push({
      n,
      kind: range.kind,
      html: content.slice(range.start, range.end),
      translatable: range.translatable,
    });
    cursor = range.end;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return { format, blocks, parts };
}

/**
 * Обратная сборка: блоки на свои места, переводимые - из `replacements` по номеру, если он там
 * есть. Непереводимые (`hr`) всегда исходные. Результат сборки записывается тем же
 * санитайзером, что ручная правка (`tech.md` §2, этап 6) - здесь он не зовётся.
 */
export function assembleChapter(
  layout: Pick<ChapterLayout, 'blocks' | 'parts'>,
  replacements: ReadonlyMap<number, string> = new Map(),
): string {
  const byNumber = new Map(layout.blocks.map((b) => [b.n, b]));
  return layout.parts
    .map((part) => {
      if (typeof part === 'string') return part;
      const block = byNumber.get(part);
      if (!block) throw new Error(`Chapter layout has no block ${part}`);
      return block.translatable ? (replacements.get(part) ?? block.html) : block.html;
    })
    .join('');
}
