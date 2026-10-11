import { escapeLikeWildcards } from './escape-like';

// LEGACY-462: `%`, `_` и `\` пользователя — символы, а не подстановки ILIKE.
describe('escapeLikeWildcards', () => {
  it.each([
    ['100%', '100\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
    ['plain', 'plain'],
  ])('%s → %s', (input, expected) => {
    expect(escapeLikeWildcards(input)).toBe(expected);
  });
});
