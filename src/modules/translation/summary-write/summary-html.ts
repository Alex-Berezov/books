import { sanitizeRichHtml } from '../../../shared/sanitize/rich-html';
import { escapeHtml } from '../content-draft/content-draft.text';
import { blocksOf, isSubheading } from '../draft-quality/text-checks';

/**
 * Текст чистовика → rich HTML поля пересказа (`F06-2`): одно правило подзаголовка с код-проверками
 * (`blocksOf`, `isSubheading`; решение арбитра `F06 | F06-1`, круг 3) - строка `## ` в любом месте
 * блока своя `<h2>`, а не только первая строка блока, как у `answerToHtml` заготовок `F05-10`.
 * Строки внутри абзаца склеиваются пробелом; прочая разметка модели не переносится.
 */

export function summaryHtml(text: string): string {
  const html = blocksOf(text)
    .map((block) =>
      isSubheading(block)
        ? `<h2>${escapeHtml(block.replace(/^##[ \t]+/, '').trim())}</h2>`
        : `<p>${escapeHtml(block.replace(/\s*\n\s*/g, ' '))}</p>`,
    )
    .join('');
  return sanitizeRichHtml(html);
}
