import { computeWorldCore, mentionChapters, WORLD_CHARACTER_CORE } from './world-core';
import { worldItemKey } from './world-quote-check';

/**
 * F08-1: ядро героя на границах (`product.md` §3, `tech.md` §3) — ровно порог проходит, на один
 * меньше — `missing` с тем, сколько есть и сколько нужно.
 */
const quote = (chapter: number | null) => ({
  text: 'Quote',
  chapter: chapter as number,
  interpretation: 'Why it matters',
});
const scene = (chapter: number | null) => ({ chapter: chapter as number, title: 'T', text: 'S' });

const full = () => ({
  short: 'Who he is.',
  character: 'Kind and lazy.',
  arc: { from: 'Dreamer', to: 'Still a dreamer' },
  quotes: [quote(1), quote(2), quote(3)],
  scenes: [scene(1), scene(2)],
  mentions: { chapters: [1, 2], first: 1 },
});

const missingParts = (input: Parameters<typeof computeWorldCore>[0]) =>
  computeWorldCore(input).missing.map((m) => m.part);

describe('computeWorldCore (F08-1)', () => {
  it('пороги — 3 цитаты, 2 сцены, присутствие хотя бы в одной главе', () => {
    expect(WORLD_CHARACTER_CORE).toEqual({ quotes: 3, scenes: 2, mentionChapters: 1 });
  });

  it('полное ядро — hasCore и пустой missing', () => {
    expect(computeWorldCore(full())).toEqual({ hasCore: true, missing: [] });
  });

  it('2 цитаты из 3 — ядра нет', () => {
    const r = computeWorldCore({ ...full(), quotes: [quote(1), quote(2)] });
    expect(r.hasCore).toBe(false);
    expect(r.missing).toEqual([{ part: 'quotes', have: 2, need: 3 }]);
  });

  it('1 сцена из 2 — ядра нет', () => {
    const r = computeWorldCore({ ...full(), scenes: [scene(4)] });
    expect(r.hasCore).toBe(false);
    expect(r.missing).toEqual([{ part: 'scenes', have: 1, need: 2 }]);
  });

  it('цитата без главы не считается', () => {
    const r = computeWorldCore({ ...full(), quotes: [quote(1), quote(2), quote(null)] });
    expect(r.missing).toEqual([{ part: 'quotes', have: 2, need: 3 }]);
  });

  it('arc.to из пробелов — путь не заполнен', () => {
    expect(missingParts({ ...full(), arc: { from: 'Dreamer', to: '   ' } })).toEqual(['arc']);
  });

  it('mentions.chapters = [] — присутствия нет', () => {
    const r = computeWorldCore({ ...full(), mentions: { chapters: [] } });
    expect(r.missing).toEqual([{ part: 'mentions', have: 0, need: 1 }]);
  });

  it('mentions нет вовсе (до F08-2) — ядра нет', () => {
    expect(missingParts({ ...full(), mentions: null })).toEqual(['mentions']);
  });

  it('пустые short и character — оба в missing', () => {
    expect(missingParts({ ...full(), short: ' ', character: null })).toEqual([
      'short',
      'character',
    ]);
  });

  it('mentionChapters: только числа из chapters; не та форма — пусто', () => {
    expect(mentionChapters({ chapters: [1, 'x', 3] })).toEqual([1, 3]);
    expect(mentionChapters({ chapters: 'no' })).toEqual([]);
    expect(mentionChapters([1, 2])).toEqual([]);
  });
});

describe('computeWorldCore: несошедшиеся пункты (F08-2, решение арбитра Q2)', () => {
  it('цитата из mentions.stale не засчитывается — ядро падает', () => {
    const r = computeWorldCore({
      ...full(),
      mentions: { chapters: [1, 2], first: 1, stale: [worldItemKey('quotes', quote(2))] },
    });
    expect(r.hasCore).toBe(false);
    expect(r.missing).toEqual([{ part: 'quotes', have: 2, need: 3 }]);
  });

  it('сцена из удалённой главы не засчитывается', () => {
    const r = computeWorldCore({
      ...full(),
      mentions: { chapters: [1, 2], first: 1, stale: [worldItemKey('scenes', scene(1))] },
    });
    expect(r.missing).toEqual([{ part: 'scenes', have: 1, need: 2 }]);
  });

  it('герой исчез из всех глав — ядра нет', () => {
    const r = computeWorldCore({ ...full(), mentions: { chapters: [], first: null } });
    expect(r.missing).toEqual([{ part: 'mentions', have: 0, need: 1 }]);
  });
});
