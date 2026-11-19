import { pairMentions } from './world-mentions-count';
import type { WorldMentions } from './world-mentions';

/**
 * F08-8c, решение арбитра `F08 | F08-8c` Q6: присутствие пары — общие главы героев ключа из
 * `coPresence` первого героя; пара в тексте не ищется, счёта и соседей у неё нет.
 */
const counted = (coPresence: Record<string, number[]>): WorldMentions => ({
  chapters: [1, 2, 3, 5],
  first: 1,
  perChapter: {},
  paragraphs: {},
  coPresence,
});

describe('pairMentions (F08-8c)', () => {
  it('главы пары — общие главы героев по возрастанию', () => {
    const byKey = new Map([['anna', counted({ tom: [5, 2], olga: [1] })]]);
    expect(pairMentions('anna--tom', byKey)).toEqual({
      chapters: [2, 5],
      first: 2,
      perChapter: {},
      paragraphs: {},
      coPresence: {},
    });
  });

  it('вместе нигде, героя нет в подсчёте или ключ не пары — глав нет', () => {
    const byKey = new Map([['anna', counted({ olga: [1] })]]);
    for (const key of ['anna--tom', 'olga--tom', 'anna']) {
      expect(pairMentions(key, byKey)).toMatchObject({ chapters: [], first: null });
    }
  });
});
