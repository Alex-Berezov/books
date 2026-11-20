import { WORLD_PAIRS_MAX } from './world-write.constants';
import { selectWorldPairs, WorldPairHero } from './world-write.pairs';

/** Отбор пар хода (`F08-8e`, решения арбитра `F08 | F08-8e-1` Q1, Q3, Q4). */
describe('selectWorldPairs', () => {
  const hero = (key: string, chapters: number[], coPresence: Record<string, number[]> = {}) =>
    ({ key, chapters, coPresence }) satisfies WorldPairHero;
  const related = (from: string, to: string) => [{ key: from, relations: [{ to }] }];

  it('related in the analysis - a pair even without common chapters; the key in alphabetical order', () => {
    const got = selectWorldPairs(
      [hero('sonya', [5]), hero('raskolnikov', [1, 2])],
      related('sonya', 'raskolnikov'),
      new Map(),
    );
    expect(got.pairs).toEqual([
      { key: 'raskolnikov--sonya', a: 'raskolnikov', b: 'sonya', linked: true, chapters: [] },
    ]);
    expect(got.skipped).toEqual([]);
  });

  it('common chapters exactly a third of the chapters of each - a pair; below a third - no pair, not left out', () => {
    const onThird = selectWorldPairs(
      [hero('anna', [1, 2, 3], { boris: [2] }), hero('boris', [2, 4, 5], { anna: [2] })],
      [],
      new Map(),
    );
    expect(onThird.pairs.map((p) => [p.key, p.chapters])).toEqual([['anna--boris', [2]]]);
    const below = selectWorldPairs(
      [hero('anna', [1, 2, 3, 4], { boris: [2] }), hero('boris', [2, 5, 6], { anna: [2] })],
      [],
      new Map(),
    );
    expect(below).toEqual({ pairs: [], skipped: [] });
  });

  it('a pair already in the world is taken without the founding rule (R1); a key of another type is left out', () => {
    const heroes = [hero('anna', [1, 2, 3, 4]), hero('boris', [5]), hero('carl', [6])];
    const got = selectWorldPairs(
      heroes,
      related('anna', 'carl'),
      new Map([
        ['anna--boris', 'pair'],
        ['anna--carl', 'character'],
      ]),
    );
    expect(got.pairs.map((p) => p.key)).toEqual(['anna--boris']);
    expect(got.skipped).toEqual([{ key: 'anna--carl', reason: 'PAIR_KEY_TAKEN', chapters: 0 }]);
  });

  it('no pair key for the two (longer than 60) - left out with PAIR_KEY_INVALID, only when founded', () => {
    const a = 'a'.repeat(30);
    const b = 'b'.repeat(30);
    const got = selectWorldPairs([hero(a, [1]), hero(b, [2])], related(a, b), new Map());
    expect(got.pairs).toEqual([]);
    expect(got.skipped).toEqual([{ key: `${a}--${b}`, reason: 'PAIR_KEY_INVALID', chapters: 0 }]);
    expect(selectWorldPairs([hero(a, [1]), hero(b, [2])], [], new Map()).skipped).toEqual([]);
  });

  it('at most WORLD_PAIRS_MAX: related first, then by common chapters, then by key; the rest - PAIRS_MAX', () => {
    // 6 героев во всех главах 1..3 вместе: 15 пар по трети; связанная - одна, она первой.
    const keys = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    const heroes = keys.map((k) =>
      hero(
        k,
        [1, 2, 3],
        Object.fromEntries(
          keys.filter((o) => o !== k).map((o) => [o, o === 'h6' || k === 'h6' ? [1] : [1, 2, 3]]),
        ),
      ),
    );
    const got = selectWorldPairs(heroes, related('h6', 'h5'), new Map());
    expect(got.pairs).toHaveLength(WORLD_PAIRS_MAX);
    expect(got.pairs[0].key).toBe('h5--h6');
    expect(got.pairs.slice(1).every((p) => p.chapters.length === 3)).toBe(true);
    expect(got.pairs.slice(1, 3).map((p) => p.key)).toEqual(['h1--h2', 'h1--h3']);
    expect(got.skipped.map((s) => s.reason)).toEqual(
      new Array(15 - WORLD_PAIRS_MAX).fill('PAIRS_MAX'),
    );
    expect(got.skipped.map((s) => s.key)).toContain('h1--h6');
  });
});
