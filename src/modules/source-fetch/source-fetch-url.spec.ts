import { htmlToText } from './source-fetch-html';
import { normalizeSourceUrl, parseSourceUrl } from './source-fetch-url';

describe('parseSourceUrl', () => {
  it('принимает https без порта и с портом 443', () => {
    expect(parseSourceUrl('https://example.com/a?b=1')?.hostname).toBe('example.com');
    expect(parseSourceUrl('https://example.com:443/a')?.hostname).toBe('example.com');
  });

  it.each([
    ['http', 'http://example.com/'],
    ['чужой порт', 'https://example.com:8443/'],
    ['user@host', 'https://user@example.com/'],
    ['user:pass@host', 'https://user:pass@example.com/'],
    ['IPv4-литерал', 'https://127.0.0.1/'],
    ['IPv6-литерал', 'https://[::1]/'],
    ['IPv6-литерал публичный', 'https://[2606:4700:4700::1111]/'],
    ['десятичная запись', 'https://2130706433/'],
    ['шестнадцатеричная запись', 'https://0x7f.1/'],
    ['восьмеричная запись', 'https://0177.0.0.1/'],
    ['ftp', 'ftp://example.com/'],
    ['не адрес', 'not a url'],
    ['пусто', ''],
  ])('отказ: %s', (_name, raw) => {
    expect(parseSourceUrl(raw)).toBeNull();
  });

  it('отказ на длине больше 2000', () => {
    expect(parseSourceUrl(`https://example.com/${'a'.repeat(2000)}`)).toBeNull();
    expect(parseSourceUrl(`https://example.com/${'a'.repeat(1900)}`)).not.toBeNull();
  });

  it('allowedPort открывает только указанный порт', () => {
    expect(parseSourceUrl('https://example.com:8443/', 8443)).not.toBeNull();
    expect(parseSourceUrl('https://example.com:9000/', 8443)).toBeNull();
  });

  it('нормализация отбрасывает фрагмент', () => {
    expect(normalizeSourceUrl('https://example.com/a#x')).toBe(
      normalizeSourceUrl('https://example.com/a#y'),
    );
  });
});

describe('htmlToText', () => {
  it('вырезает script, style, комментарии и теги, декодирует сущности', () => {
    const html =
      '<html><head><style>p{color:red}</style><script>alert(1)</script></head>' +
      '<body><!-- скрыто --><p>Тут &amp; там &lt;b&gt; &#65;&#x42; &nbsp;конец</p></body></html>';
    expect(htmlToText(html)).toBe('Тут & там <b> AB конец');
  });

  it('незакрытый script не протекает в текст', () => {
    expect(htmlToText('до<script>evil(')).toBe('до');
  });

  it('обрезает по длине', () => {
    expect(htmlToText(`<p>${'а'.repeat(50)}</p>`, 10)).toHaveLength(10);
  });

  it('страница в 2 МБ знаков «<» без «>» и незакрытых комментариев разбирается за линейное время', () => {
    const limit = 2 * 1024 * 1024;
    for (const page of ['<'.repeat(limit), '<!--'.repeat(limit / 4), '<script'.repeat(limit / 7)]) {
      const started = Date.now();
      htmlToText(`текст ${page}`);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  it('мягкий перенос и знаки нулевой ширины не рвут слово; тег с именем на script не глотает текст', () => {
    expect(htmlToText('<p>Dosto&shy;evsky и Dosto\u00adevsky</p>')).toBe('Dostoevsky и Dostoevsky');
    expect(htmlToText('<scripted>да</scripted>')).toBe('да');
  });

  it('знак, у которого нижний регистр длиннее («İ»), не сдвигает поиск конца script', () => {
    const many = 'İ'.repeat(20);
    expect(htmlToText(`${many}<p>до</p><SCRIPT>{"title":"Book"}</Script><p>после</p>`)).toBe(
      `${many} до после`,
    );
  });
});
