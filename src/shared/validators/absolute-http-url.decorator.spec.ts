import { validateSync } from 'class-validator';
import { IsAbsoluteHttpsUrl } from './absolute-http-url.decorator';

/** Источник анализа книги (F03, `tech.md` §3): только `https://` с доменом верхнего уровня. */
class Probe {
  @IsAbsoluteHttpsUrl()
  url!: unknown;
}

const ok = (url: unknown) => {
  const p = new Probe();
  p.url = url;
  return validateSync(p).length === 0;
};

describe('IsAbsoluteHttpsUrl', () => {
  it.each([
    'https://en.wikipedia.org/wiki/Crime_and_Punishment',
    'https://ru.wikipedia.org/wiki/%D0%9F',
    'https://example.com:8443/path?q=1#x',
  ])('пропускает %s', (url) => {
    expect(ok(url)).toBe(true);
  });

  it.each([
    'http://en.wikipedia.org/wiki/X',
    'https://localhost/x',
    'https://intranet/x',
    'ftp://example.com/x',
    'javascript:alert(1)',
    '//example.com/x',
    '',
    42,
  ])('отбивает %j', (url) => {
    expect(ok(url)).toBe(false);
  });
});
