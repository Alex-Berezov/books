import { RICH_HTML_ALLOWED_TAGS, sanitizeRichHtml } from '../../shared/sanitize/rich-html';
import { assembleChapter, BLOCK_TAGS, INLINE_TAGS, splitChapter } from './chapter-blocks';

/** Корпус глав: формы сида приёмки (`prisma/seed-analyses.ts:435`) и краевые случаи карточки. */
const CORPUS: string[] = [
  '<p>Service chapter 1.</p><p>«Quote one»</p>',
  '<p>Служебная глава 2.</p>',
  '<h2 style="text-align:center">Chapter I</h2><p>It was <em>the best</em> of times,<br />it was <strong>the worst</strong>.</p><hr /><p>Next scene.</p>',
  '<blockquote><p>First paragraph of the quote.</p><p>Second one.</p></blockquote><p>After.</p>',
  '<blockquote>A bare quote with <em>emphasis</em></blockquote>',
  '<ul><li>One</li><li>Two<ul><li>Nested <a href="https://example.com">link</a></li></ul></li></ul><ol start="3"><li>Three</li></ol>',
  '<p></p><p> </p><p>&nbsp;</p><p>Real text</p><p><br /></p>',
  '<figure><img src="https://example.com/a.png" alt="A &quot;quoted&quot; picture" title="Plate 1" /><figcaption>The <em>caption</em></figcaption></figure>',
  '<figure><img src="https://example.com/b.png" /></figure><p>Text</p>',
  '<pre><code class="language-js">const a = 1;</code></pre><p>Tail &amp; more</p>',
  'Loose text at the root <strong>with markup</strong><p>and a paragraph</p>',
];

const PLAIN = 'First paragraph,\nsecond line of it.\n\n\nSecond paragraph.\n   \nThird.\n';

describe('splitChapter / assembleChapter', () => {
  it.each(CORPUS)('assemble(split(x)) equals sanitize(x) for %#', (raw) => {
    const clean = sanitizeRichHtml(raw);
    const layout = splitChapter(clean);
    expect(layout.format).toBe('html');
    expect(assembleChapter(layout)).toBe(clean);
  });

  it('numbers blocks from 1 in document order', () => {
    const { blocks } = splitChapter(CORPUS[2]);
    expect(blocks.map((b) => [b.n, b.kind, b.html])).toEqual([
      [1, 'h2', 'Chapter I'],
      [2, 'p', 'It was <em>the best</em> of times,<br />it was <strong>the worst</strong>.'],
      [3, 'hr', '<hr />'],
      [4, 'p', 'Next scene.'],
    ]);
    expect(blocks[2].translatable).toBe(false);
  });

  it('splits a quote with paragraphs into the paragraphs', () => {
    const { blocks } = splitChapter(CORPUS[3]);
    expect(blocks.map((b) => [b.kind, b.html])).toEqual([
      ['p', 'First paragraph of the quote.'],
      ['p', 'Second one.'],
      ['p', 'After.'],
    ]);
    expect(splitChapter(CORPUS[4]).blocks.map((b) => [b.kind, b.html])).toEqual([
      ['blockquote', 'A bare quote with <em>emphasis</em>'],
    ]);
  });

  it('splits nested lists: item text before the nested list is its own block', () => {
    const { blocks } = splitChapter(CORPUS[5]);
    expect(blocks.map((b) => [b.kind, b.html])).toEqual([
      ['li', 'One'],
      ['li', 'Two'],
      ['li', 'Nested <a href="https://example.com">link</a>'],
      ['li', 'Three'],
    ]);
  });

  it('skips empty paragraphs but keeps them in the shell', () => {
    const clean = sanitizeRichHtml(CORPUS[6]);
    const layout = splitChapter(clean);
    expect(layout.blocks.map((b) => b.html)).toEqual(['Real text']);
    expect(assembleChapter(layout)).toBe(clean);
  });

  it('figure: alt, title and caption are blocks, the shell keeps img in place', () => {
    const layout = splitChapter(CORPUS[7]);
    expect(layout.blocks.map((b) => [b.kind, b.html])).toEqual([
      ['img-alt', 'A &quot;quoted&quot; picture'],
      ['img-title', 'Plate 1'],
      ['figcaption', 'The <em>caption</em>'],
    ]);
    const translated = assembleChapter(
      layout,
      new Map([
        [1, 'Une image &quot;citée&quot;'],
        [2, 'Planche 1'],
        [3, 'La <em>légende</em>'],
      ]),
    );
    expect(translated).toBe(
      '<figure><img src="https://example.com/a.png" alt="Une image &quot;citée&quot;" title="Planche 1" /><figcaption>La <em>légende</em></figcaption></figure>',
    );
    expect(splitChapter(CORPUS[8]).blocks.map((b) => b.kind)).toEqual(['p']);
  });

  it('assembles replacements into their places and never replaces hr', () => {
    const layout = splitChapter(CORPUS[2]);
    const out = assembleChapter(
      layout,
      new Map([
        [1, 'Глава I'],
        [3, '<p>injected</p>'],
        [4, 'Следующая сцена.'],
      ]),
    );
    expect(out).toBe(
      '<h2 style="text-align:center">Глава I</h2><p>It was <em>the best</em> of times,<br />it was <strong>the worst</strong>.</p><hr /><p>Следующая сцена.</p>',
    );
  });

  it('plain text: paragraphs by blank lines, line breaks inside a paragraph stay', () => {
    const layout = splitChapter(PLAIN);
    expect(layout.format).toBe('plain');
    expect(layout.blocks.map((b) => b.html)).toEqual([
      'First paragraph,\nsecond line of it.',
      'Second paragraph.',
      'Third.',
    ]);
    expect(assembleChapter(layout)).toBe(PLAIN);
    expect(assembleChapter(layout, new Map([[2, 'Второй абзац.']]))).toBe(
      'First paragraph,\nsecond line of it.\n\n\nВторой абзац.\n   \nThird.\n',
    );
  });

  it('empty chapter has no blocks', () => {
    expect(splitChapter('')).toEqual({ format: 'plain', blocks: [], parts: [] });
  });
});

describe('chapter blocks against the sanitizer allow-list', () => {
  const blockTag = new RegExp(String.raw`</?(${[...BLOCK_TAGS].join('|')})\b`, 'i');

  it('every allow-listed tag is either a block or an inline tag', () => {
    const known = new Set([...BLOCK_TAGS, ...INLINE_TAGS]);
    expect(RICH_HTML_ALLOWED_TAGS.filter((t) => !known.has(t))).toEqual([]);
    expect([...BLOCK_TAGS].filter((t) => INLINE_TAGS.has(t))).toEqual([]);
  });

  it.each(CORPUS)('a block never carries block markup inside, corpus %#', (raw) => {
    const { blocks } = splitChapter(sanitizeRichHtml(raw));
    const inside = blocks.filter((b) => b.kind !== 'hr' && blockTag.test(b.html));
    expect(inside.map((b) => b.html)).toEqual([]);
  });

  it.each(CORPUS)('saving the same text again changes nothing, corpus %#', (raw) => {
    const once = sanitizeRichHtml(raw);
    expect(sanitizeRichHtml(once)).toBe(once);
  });

  it('plain text with Windows line breaks splits into the same paragraphs', () => {
    const crlf = PLAIN.replace(/\n/g, '\r\n');
    const layout = splitChapter(crlf);
    expect(layout.blocks.map((b) => b.html)).toEqual([
      'First paragraph,\r\nsecond line of it.',
      'Second paragraph.',
      'Third.',
    ]);
    expect(assembleChapter(layout)).toBe(crlf);
  });
});
