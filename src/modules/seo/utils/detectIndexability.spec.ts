import { detectIndexability } from './detectIndexability';

// `LEGACY-422`, `T90` (слово владельца 02.10.2026, решение арбитра 03.10.2026): служебный путь
// узнаётся по первому сегменту после языка, а не по подстроке.
describe('detectIndexability — служебные пути', () => {
  const origin = 'https://example.com';

  it.each([
    `${origin}/en/search`,
    `${origin}/en/search?q=x`,
    `${origin}/ru/account`,
    `${origin}/en/account/settings`,
    `${origin}/fr/sign-in`,
    `${origin}/es/sign-up`,
    `${origin}/pt/my-bookshelf`,
    `${origin}/en/checkout`,
    `${origin}/api/health`,
    `${origin}/admin/books`,
    `${origin}/debug/x`,
    '/en/search',
    '/EN/Search',
    `${origin}/en/search/`,
    `${origin}/en/auth/sign-in`,
    `${origin}/ru/profile`,
    `${origin}/en/bookshelf`,
    // Без языка — первый сегмент пути (решение арбитра 03.10.2026, ревью `T90`).
    `${origin}/search?q=x`,
    `${origin}/account`,
    '/sign-in',
    `${origin}/api`,
  ])('«%s» закрыт', (path) => {
    expect(detectIndexability('published', path)).toBe('noindex, follow');
  });

  it.each([
    `${origin}/en/tag/search`,
    `${origin}/en/tag/search-engines`,
    `${origin}/en/book/account-of-a-life`,
    `${origin}/en/category/searching`,
    `${origin}/en/author/admin`,
    `${origin}/en/searchlight`,
    `${origin}/en`,
    '/en/book/search',
    `${origin}/en/tag/auth`,
    `${origin}/en/tag/profile`,
    `${origin}/en/admin`,
    `${origin}/`,
  ])('«%s» открыт', (path) => {
    expect(detectIndexability('published', path)).toBe('index, follow');
  });
});

// Закрытая флагом страница сохраняет из строки Robots только `nofollow`/`none` — по тому же разбору
// (`robotsTokens`, ревью `T90`): директива со значением `none` не даёт.
describe('detectIndexability — закрытая флагом страница и строка Robots', () => {
  it.each([
    ['index, max-image-preview:none', 'noindex, follow'],
    ['googlebot: nofollow', 'noindex, nofollow'],
    ['noindex nofollow', 'noindex, nofollow'],
    ['googlebot:none', 'none'],
    ['max-snippet:-1', 'noindex, follow'],
  ])('«%s» -> %s', (robots, expected) => {
    expect(detectIndexability('published', '/en/tag/x', robots, false)).toBe(expected);
  });
});
