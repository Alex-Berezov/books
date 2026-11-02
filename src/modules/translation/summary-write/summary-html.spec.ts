import { summaryHtml } from './summary-html';

/** HTML полей хода (`F06-2`): то же правило подзаголовка, что у код-проверок строя. */
describe('summaryHtml', () => {
  it('a "## " line glued inside a block is its own heading between two paragraphs', () => {
    expect(summaryHtml('Intro line.\n## Part one\nAnna leaves.')).toBe(
      '<p>Intro line.</p><h2>Part one</h2><p>Anna leaves.</p>',
    );
  });

  it('paragraphs by an empty line, lines inside a paragraph joined by a space, text escaped', () => {
    expect(summaryHtml('Anna\nleaves <home>.\n\nBob & Co stay.')).toBe(
      '<p>Anna leaves &lt;home&gt;.</p><p>Bob &amp; Co stay.</p>',
    );
  });

  it('"##" without text and "###" are not subheadings: they stay text, as in the structure check', () => {
    expect(summaryHtml('##Part')).toBe('<p>##Part</p>');
  });
});
