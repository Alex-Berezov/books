import { richHtmlInlineText, richHtmlText } from './rich-html-text';

describe('richHtmlInlineText (LEGACY-500)', () => {
  it('строчный тег снимается без пробела: знак после него не отрывается', () => {
    expect(richHtmlInlineText('<em>x</em>,')).toBe('x,');
    expect(richHtmlInlineText('a<SPAN class="k">b</SPAN>c <a href="/u">d</a>.')).toBe('abc d.');
    expect(richHtmlInlineText('<strong><s>x</s></strong>!')).toBe('x!');
  });

  it.each([
    ['a<br>b'],
    ['a<BR/>b'],
    ['<p>a</p><p class="x">b</p>'],
    ['<ul><li>a</li><li>b</li></ul>'],
    ['<h2>a</h2><blockquote>b</blockquote>'],
    ['a<hr>b'],
    ['<figure>a<figcaption>b</figcaption></figure>'],
    ['<tr><td>a</td><td>b</td></tr>'],
    ['a<p\n>b'],
  ])('блочный тег и перенос строки дают пробел: %s', (html) => {
    expect(richHtmlInlineText(html)).toBe('a b');
  });

  it('картинка и незнакомый тег дают пробел: слова по краям не склеиваются', () => {
    expect(richHtmlInlineText('See<img src="x.jpg" alt="i">Anna')).toBe('See Anna');
    expect(richHtmlInlineText('a<details>b</details>c')).toBe('a b c');
    expect(richHtmlInlineText('a<pre-x>b')).toBe('a b');
  });

  it('сущности и пробелы - как в richHtmlText', () => {
    expect(richHtmlInlineText(' <p>a&nbsp;&amp;​&lt;em&gt;</p> ')).toBe('a &<em>');
    expect(richHtmlText('<em>x</em>,')).toBe('x ,');
    expect(richHtmlText('a<br>b<p\n>c</p>')).toBe('a b c');
  });

  it('знак без имени тега не роняет разбор', () => {
    expect(richHtmlInlineText('a<>b</>c')).toBe('a b c');
    expect(richHtmlInlineText('x < y > z')).toBe('x z');
  });
});
