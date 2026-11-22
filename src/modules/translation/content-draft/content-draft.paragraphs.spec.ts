import { readFileSync } from 'fs';
import { join } from 'path';
import { paragraphsOf } from '../draft-quality/quote-check';
import { htmlToParagraphs } from './content-draft.text';

/**
 * Правило абзаца бэкенда и читалки одно (`F08-10a`, решение арбитра `F08 | F08-10` Q2): абзац K
 * сцены мира книги - `paragraphsOf(htmlToParagraphs(content))[K - 1]`. Копия фикстуры лежит
 * в `books-front/__tests__/fixtures/reader-paragraphs.json`, по ней читалка сверяет свою сторону
 * (`readerParagraphs.ts`). Копии между собой не сверяет ничто: менять обе и правило с обеих сторон
 * вместе.
 */
describe('reader paragraph numbering (F08-10a)', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '../../../../test/fixtures/reader-paragraphs.json'), 'utf8'),
  ) as { html: string; paragraphs: string[] };

  it('the shared fixture gives the same paragraphs in the same order', () => {
    expect(paragraphsOf(htmlToParagraphs(fixture.html))).toEqual(fixture.paragraphs);
  });
});
