import { chaptersText, escapeHtml, htmlToParagraphs, withChapterText } from './content-draft.text';

describe('content draft text', () => {
  it('htmlToParagraphs: saved rich HTML to paragraphs, headings kept, image attributes and empty blocks dropped', () => {
    expect(
      htmlToParagraphs(
        '<h2>Part&nbsp;One</h2><p>Anna <em>arrives</em>.</p><p></p><figure><img src="a.jpg" alt="Alt"></figure>',
      ),
    ).toBe('## Part One\n\nAnna arrives.');
  });

  it('htmlToParagraphs: inline markup glued, line break and image spaced (LEGACY-500)', () => {
    expect(htmlToParagraphs('<p>See <em>Anna</em>, then<br>go<img src="x.jpg">home.</p>')).toBe(
      'See Anna, then go home.',
    );
  });

  it('chaptersText: the reader chapter mark before each chapter', () => {
    expect(
      chaptersText([
        { number: 2, title: 'Two', content: '<p>A.</p>' },
        { number: 3, title: '', content: '<p>B.</p>' },
      ]),
    ).toBe('[READER CHAPTER 2] Two\n\nA.\n\n[READER CHAPTER 3]\n\nB.');
  });

  it('escapeHtml: markup of the model is text', () => {
    expect(escapeHtml('a < b & <script>')).toBe('a &lt; b &amp; &lt;script&gt;');
  });

  it('withChapterText: chapters without visible text are dropped, order kept', () => {
    const chapters = [
      { number: 1, content: '<p>text</p>' },
      { number: 2, content: '<p> </p>' },
      { number: 3, content: '<img alt="only alt">' },
      { number: 4, content: '<h2>Title</h2>' },
    ];
    expect(withChapterText(chapters).map((c) => c.number)).toEqual([1, 4]);
  });
});
