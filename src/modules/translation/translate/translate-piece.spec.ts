import { splitChapter } from '../chapter-blocks';
import { pieceInput } from './translate-piece';

/**
 * Выбор глоссария куска: текст куска нормализуется так же, как `pieceTexts` в проверках
 * (`richHtmlInlineText`) - строчный тег внутри слова и перед запятой не рвёт имя (`LEGACY-500`).
 */

const glossary = (source: string) => ({
  entries: [{ key: 'k', source, target: 'Цель', kind: 'person', keepOriginal: false, note: '' }],
  address: [],
  phrases: [{ source: 'Old Man,', target: 'Старик,' }],
});

function input(html: string, source: string) {
  const layout = splitChapter(html);
  return pieceInput({
    layout,
    chunks: [{ firstBlock: 1, lastBlock: layout.blocks.length, words: 0 }],
    index: 0,
    dossier: null,
    glossary: glossary(source),
    sourceLanguage: 'en',
    targetLanguage: 'es',
    chapterNumber: 1,
    previousTail: null,
  });
}

describe('pieceInput: glossary over inline markup (LEGACY-500)', () => {
  it('finds a name split by an inline tag', () => {
    expect(input('<p><b>Mc</b>Gregor came home.</p>', 'McGregor').glossary.entries).toHaveLength(1);
  });

  it('finds a phrase with a comma right after an inline tag', () => {
    expect(
      input('<p>The <em>Old Man</em>, tired, sat.</p>', 'Nobody').glossary.phrases,
    ).toHaveLength(1);
  });

  it('finds a short name with a numeric footnote glued to it', () => {
    expect(input('<p>Li<sup>1</sup> walked in.</p>', 'Li').glossary.entries).toHaveLength(1);
    expect(input('<p>Li<a href="#fn1">1</a> walked in.</p>', 'Li').glossary.entries).toHaveLength(
      1,
    );
  });

  it('a short name is still not found inside a longer word', () => {
    expect(input('<p>She would like a little tea.</p>', 'Li').glossary.entries).toEqual([]);
  });

  it('a line break inside one block still separates words', () => {
    expect(input('<p>Mc<br>Gregor</p>', 'McGregor').glossary.entries).toEqual([]);
  });
});
