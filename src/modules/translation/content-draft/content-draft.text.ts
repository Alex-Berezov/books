import { sanitizeRichHtml } from '../../../shared/sanitize/rich-html';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { splitChapter } from '../chapter-blocks';

/**
 * Перевод между текстом модели и rich HTML полей пересказа (`@RichHtml`): модель пишет абзацы
 * через пустую строку и подзаголовки `## `, форма вкладки получает HTML, который пройдёт
 * сохранение существующими ручками. Текст из базы модели - абзацами без разметки.
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Абзац - `<p>`, строки внутри абзаца склеиваются пробелом. */
const paragraph = (text: string): string => `<p>${escapeHtml(text.replace(/\s*\n\s*/g, ' '))}</p>`;

/**
 * Абзацы - `<p>`, строка `## ` - `<h2>`: заголовок - только первая строка блока, текст под ним
 * без пустой строки остаётся абзацем. Заголовок любого уровня (`#`…`######`) - `<h2>`: в полях
 * пересказа подзаголовки одного уровня; `##` без текста отбрасывается. Прочая разметка модели
 * (`**`) не переносится.
 */
export function answerToHtml(text: string): string {
  const html = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => {
      const heading = /^#{1,6}(?:[ \t]+([^\n]*))?[ \t]*(?:\n([\s\S]*))?$/.exec(block);
      if (!heading) return paragraph(block);
      const title = heading[1]?.trim() ?? '';
      const rest = heading[2]?.trim() ?? '';
      return (title ? `<h2>${escapeHtml(title)}</h2>` : '') + (rest ? paragraph(rest) : '');
    })
    .join('');
  return sanitizeRichHtml(html);
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

/** Вопрос редактору: «нет» в любом виде - пусто. */
export function editorQuestion(value: string): string | null {
  const text = value.trim();
  return text === '' || /^(none|нет|no|non|nenhuma?|ninguna?)\.?$/i.test(text) ? null : text;
}
