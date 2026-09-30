import { isTagTranslationIndexable } from './tag-translation-indexable.util';

describe('isTagTranslationIndexable (LEGACY-422, T74)', () => {
  it.each([
    [true, true, true],
    [false, true, false],
    [true, false, false],
    [false, false, false],
  ])('тег %s, перевод %s -> %s', (tagFlag, translationFlag, expected) => {
    expect(isTagTranslationIndexable({ indexable: tagFlag }, { indexable: translationFlag })).toBe(
      expected,
    );
  });

  it('не заданный флаг и отсутствующий перевод не закрывают страницу', () => {
    expect(isTagTranslationIndexable({}, undefined)).toBe(true);
    expect(isTagTranslationIndexable({ indexable: null }, null)).toBe(true);
    expect(isTagTranslationIndexable(undefined, { indexable: true })).toBe(true);
  });

  it('закрытый флаг закрывает и при отсутствии другой половины', () => {
    expect(isTagTranslationIndexable({ indexable: false }, null)).toBe(false);
    expect(isTagTranslationIndexable(null, { indexable: false })).toBe(false);
  });
});
