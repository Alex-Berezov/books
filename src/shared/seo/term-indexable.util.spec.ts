import {
  isCategoryTermIndexable,
  isCategoryTermOpen,
  isTagTermIndexable,
  isTagTermOpen,
  robotsHasNoindex,
  seoAllowsIndex,
} from './term-indexable.util';

// `LEGACY-422`, пачка `T81` (решение арбитра 01.10.2026): одно правило индексируемости страницы
// термина на robots, `slugsMap` hreflang, «похожие» и свёрнутый `indexable` публичных списков.
describe('robotsHasNoindex', () => {
  it.each(['noindex', 'noindex, follow', 'NOINDEX,NOFOLLOW', ' none ', 'index, noindex'])(
    '«%s» закрывает',
    (robots) => {
      expect(robotsHasNoindex(robots)).toBe(true);
    },
  );

  it.each([null, undefined, '', 'index, follow', 'index, nofollow', 'noindexed', 'nonee'])(
    '«%s» не закрывает',
    (robots) => {
      expect(robotsHasNoindex(robots)).toBe(false);
    },
  );
});

describe('isTagTermIndexable', () => {
  const open = { indexable: true, autoIndexable: true };

  it('открыт, когда открыты тег, перевод, автоматика и нет noindex в поле', () => {
    expect(isTagTermIndexable({ indexable: true }, open, { robots: 'index, follow' })).toBe(true);
    expect(isTagTermIndexable({ indexable: null }, { autoIndexable: null }, null)).toBe(true);
  });

  it.each([
    ['тег', { indexable: false }, open, null],
    ['перевод', { indexable: true }, { ...open, indexable: false }, null],
    ['автоматика', { indexable: true }, { ...open, autoIndexable: false }, null],
    ['поле Robots', { indexable: true }, open, { robots: 'noindex' }],
  ])('закрыт, когда закрыт %s', (_name, tag, translation, seo) => {
    expect(isTagTermIndexable(tag, translation, seo)).toBe(false);
  });
});

describe('isCategoryTermIndexable', () => {
  it('открыт, когда открыты категория, автоматика и нет noindex в поле', () => {
    expect(isCategoryTermIndexable({ indexable: true }, { autoIndexable: true }, null)).toBe(true);
  });

  it.each([
    ['категория', { indexable: false }, { autoIndexable: true }, null],
    ['автоматика', { indexable: true }, { autoIndexable: false }, null],
    ['поле Robots', { indexable: true }, { autoIndexable: true }, { robots: 'none' }],
  ])('закрыт, когда закрыта %s', (_name, category, translation, seo) => {
    expect(isCategoryTermIndexable(category, translation, seo)).toBe(false);
  });
});

// Два уровня: «открыт» — для списков и «похожих» (`autoIndexable` идёт у них отдельным полем и складывается
// на фронте), «индексируем» — для robots и hreflang бандла, где автоматика входит в страницу.
describe('isTagTermOpen / isCategoryTermOpen / seoAllowsIndex', () => {
  it('seoAllowsIndex: только поле Robots', () => {
    expect(seoAllowsIndex(null)).toBe(true);
    expect(seoAllowsIndex({ robots: 'index, follow' })).toBe(true);
    expect(seoAllowsIndex({ robots: 'noindex' })).toBe(false);
  });

  it('тег: автоматика не закрывает, флаги и поле Robots закрывают', () => {
    expect(isTagTermOpen({ indexable: true }, { indexable: true }, null)).toBe(true);
    expect(isTagTermOpen(null, { indexable: true }, null)).toBe(true);
    expect(isTagTermOpen({ indexable: false }, { indexable: true }, null)).toBe(false);
    expect(isTagTermOpen({ indexable: true }, { indexable: false }, null)).toBe(false);
    expect(isTagTermOpen({ indexable: true }, { indexable: true }, { robots: 'none' })).toBe(false);
    // `autoIndexable` у «открыт» нет вовсе: тип его не принимает, а закрытый автоматикой термин открыт.
    expect(
      isTagTermOpen({ indexable: true }, { indexable: true, autoIndexable: false } as never, null),
    ).toBe(true);
  });

  it('категория: автоматика не закрывает, флаг и поле Robots закрывают', () => {
    expect(isCategoryTermOpen({ indexable: true }, null)).toBe(true);
    expect(isCategoryTermOpen({ indexable: false }, null)).toBe(false);
    expect(isCategoryTermOpen({ indexable: true }, { robots: 'noindex, follow' })).toBe(false);
  });
});
