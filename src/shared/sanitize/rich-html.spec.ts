import {
  RICH_HTML_ALLOWED_ATTRIBUTES,
  RICH_HTML_ALLOWED_SCHEMES,
  RICH_HTML_ALLOWED_TAGS,
  RICH_HTML_CODE_CLASS,
  RICH_HTML_DROP_CONTENT_TAGS,
  RICH_HTML_IMG_SCHEMES,
  RICH_HTML_TEXT_ALIGN_STYLE,
  sanitizeRichHtml,
} from './rich-html';

describe('sanitizeRichHtml (LEGACY-414)', () => {
  describe('разметка редактора проходит байт в байт', () => {
    it.each([
      '<p style="text-align: center">Привет<br>мир &amp; <strong>жирный</strong> <em>к</em> <u>п</u> <s>з</s></p>',
      '<p><img src="https://cdn.example.com/a.png" alt="обложка"></p>',
      '<h2 style="text-align: right">Заголовок</h2><h3>Под</h3><blockquote><p>цитата</p></blockquote><hr>',
      '<pre><code class="language-ts">a &lt; b</code></pre><p><code>x</code></p>',
      '<ol start="3"><li><p>x</p></li></ol><ul><li><p>y</p></li></ul>',
      '<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com">ссылка</a></p>',
      '<p><a href="mailto:a@example.com">почта</a> <a href="/ru/book/x">внутренняя</a></p>',
      'обычный текст без тегов',
      '',
    ])('%s', (html) => {
      expect(sanitizeRichHtml(html)).toBe(html);
    });
  });

  describe('опасное вырезается', () => {
    it('обработчик события на картинке', () => {
      const out = sanitizeRichHtml('<p>ok</p><img src="https://e.com/x.png" onerror="alert(1)">');
      expect(out).not.toContain('onerror');
      expect(out).toContain('src="https://e.com/x.png"');
    });

    it('script вместе с содержимым', () => {
      const out = sanitizeRichHtml('<script>alert(1)</script><p>t</p>');
      expect(out).toBe('<p>t</p>');
    });

    it('javascript: в ссылке', () => {
      expect(sanitizeRichHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript');
    });

    it('data: в картинке', () => {
      expect(sanitizeRichHtml('<img src="data:image/png;base64,AAA">')).not.toContain('data:');
    });

    it('протокол-относительный адрес', () => {
      expect(sanitizeRichHtml('<img src="//evil.example/x.png">')).not.toContain('evil');
    });

    it('iframe, style-тег и неразрешённые теги', () => {
      const out = sanitizeRichHtml(
        '<iframe src="https://e"></iframe><style>p{}</style><div><p>t</p></div>',
      );
      expect(out).toBe('<p>t</p>');
    });

    it('style кроме text-align', () => {
      expect(sanitizeRichHtml('<p style="color:red">c</p>')).toBe('<p>c</p>');
      expect(sanitizeRichHtml('<p style="text-align: center; background: url(x)">c</p>')).toBe(
        '<p>c</p>',
      );
    });

    it('class на code, кроме language-*', () => {
      expect(sanitizeRichHtml('<code class="x onclick">c</code>')).toBe('<code>c</code>');
    });

    // Разметка, которую парсер выбрасывает целиком, а браузер читает как теги: сырой ввод возвращать нельзя.
    it.each([
      ['CDATA', '<p>t</p><![CDATA[><img src=x onerror=alert(1)>]]>'],
      [
        'комментарий, закрытый по-браузерному на --!>',
        '<p>a</p><!-- --!><img src=x onerror=alert(1)> -->',
      ],
      ['пустой комментарий <!-->', '<p>t</p><!--><img src=x onerror=alert(1)>-->'],
      ['инструкция обработки', '<p>t</p><?x ><img src=x onerror=alert(1)>?>'],
      ['doctype', '<p>t</p><!DOCTYPE x><p>u</p>'],
    ])('%s не возвращается как есть', (_name, html) => {
      const out = sanitizeRichHtml(html);
      expect(out).not.toBe(html);
      expect(out).not.toContain('onerror');
      expect(out).not.toContain('<!');
      expect(out).not.toContain('<?');
    });

    it('текстовый < не проходит под видом чистого ввода', () => {
      const html = '<p>a < b</p>';
      expect(sanitizeRichHtml(html)).toBe('<p>a &lt; b</p>');
    });

    // Тот же список, что у обеих веток фронта: иначе текст в базе и на странице расходится.
    it.each([
      '<textarea>ZZ</textarea>',
      '<select><option>ZZ</option></select>',
      '<title>ZZ</title>',
      '<svg><text>ZZ</text></svg>',
      '<math><mi>ZZ</mi></math>',
      '<template><p>ZZ</p></template>',
      '<iframe>ZZ</iframe>',
      '<noscript>ZZ</noscript>',
      '<object>ZZ</object>',
      '<xmp>ZZ</xmp>',
    ])('%s выбрасывается вместе с содержимым', (html) => {
      expect(sanitizeRichHtml(`<p>a</p>${html}<p>b</p>`)).toBe('<p>a</p><p>b</p>');
    });

    it('результат чистки устойчив к повторной чистке', () => {
      const once = sanitizeRichHtml('<p onclick="x()">a<br>b</p><img src="x" onerror="y">');
      expect(sanitizeRichHtml(once)).toBe(once);
    });
  });

  // Сверка не межрепозиторная: общего файла нет (D:/newDev/CLAUDE.md, запрет 4). Тот же литерал держит копию
  // в books-front/__tests__/lib/utils/richHtml.test.ts — меняются только вместе, в двух коммитах одной пачки.
  it('белый список прибит к литералу, общему со спекой фронта', () => {
    expect([...RICH_HTML_ALLOWED_TAGS].sort()).toEqual(
      [
        'a',
        'blockquote',
        'br',
        'code',
        'em',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'hr',
        'img',
        'li',
        'ol',
        'p',
        'pre',
        's',
        'strong',
        'u',
        'ul',
      ].sort(),
    );
    expect(RICH_HTML_ALLOWED_ATTRIBUTES).toEqual({
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      ol: ['start'],
      code: ['class'],
      p: ['style'],
      h1: ['style'],
      h2: ['style'],
      h3: ['style'],
      h4: ['style'],
      h5: ['style'],
      h6: ['style'],
    });
    expect(RICH_HTML_ALLOWED_SCHEMES).toEqual(['http', 'https', 'mailto']);
    expect(RICH_HTML_IMG_SCHEMES).toEqual(['http', 'https']);
    expect(String(RICH_HTML_TEXT_ALIGN_STYLE)).toBe(
      String(/^\s*text-align\s*:\s*(left|right|center|justify)\s*;?\s*$/i),
    );
    expect(String(RICH_HTML_CODE_CLASS)).toBe(String(/^language-[a-z0-9_+#-]+$/i));
    expect([...RICH_HTML_DROP_CONTENT_TAGS]).toEqual([
      'annotation-xml',
      'audio',
      'colgroup',
      'desc',
      'embed',
      'foreignobject',
      'head',
      'iframe',
      'math',
      'mi',
      'mn',
      'mo',
      'ms',
      'mtext',
      'noembed',
      'noframes',
      'noscript',
      'object',
      'option',
      'plaintext',
      'script',
      'select',
      'style',
      'svg',
      'template',
      'textarea',
      'thead',
      'title',
      'video',
      'xmp',
    ]);
  });
});
