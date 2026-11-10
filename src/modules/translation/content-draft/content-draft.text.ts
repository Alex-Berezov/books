import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { splitChapter } from '../chapter-blocks';

/**
 * Текст из базы модели - абзацами без разметки; экранирование текста модели для rich HTML.
 * Перевод ответа модели в HTML полей пересказа - `summary-write/summary-html.ts` (`F06`).
 */

/** Экранирование текста модели для rich HTML хода `F06` (`summary-html.ts`). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Сохранённый HTML пересказа - абзацами через пустую строку, подзаголовки строкой `## `. */
export function htmlToParagraphs(html: string): string {
  return (
    splitChapter(html)
      // Атрибуты картинок (`alt`, `title`) - не текст пересказа и не текст главы.
      .blocks.filter((b) => b.translatable && b.kind !== 'img-alt' && b.kind !== 'img-title')
      .map((b) => {
        // Строчная разметка снимается без пробела («<em>arrives</em>.»), перенос строки - пробел.
        const text = richHtmlText(b.html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''));
        return /^h[1-6]$/.test(b.kind) ? `## ${text}` : text;
      })
      .filter((text) => text !== '' && text !== '##')
      .join('\n\n')
  );
}

/** Главы раздела для промпта: метка главы читалки и абзацы её текста. */
export function chaptersText(
  chapters: ReadonlyArray<{ number: number; title: string; content: string }>,
): string {
  return chapters
    .map((c) => {
      const head = `[READER CHAPTER ${c.number}]` + (c.title ? ` ${c.title}` : '');
      return `${head}\n\n${htmlToParagraphs(c.content)}`;
    })
    .join('\n\n');
}

/** Главы, в которых есть текст (пустые и из одной разметки отбрасываются). */
export const withChapterText = <T extends { content: string }>(chapters: readonly T[]): T[] =>
  chapters.filter((c) => htmlToParagraphs(c.content) !== '');
