import { estimateInputTokens } from '../../llm/openrouter.client';
import {
  GroupItem,
  levelNarrows,
  packGroups,
  summaryInputChars,
  summaryLevels,
} from './dossier-groups';
import { dossierSummaryRequest } from './dossier.prompts';

const item = (chapter: number): GroupItem => ({
  firstChapter: chapter,
  lastChapter: chapter,
  entry: { chapter },
});

const items = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1));

describe('packGroups', () => {
  it('splits into consecutive groups, each under the limit, covering every item once', async () => {
    const spans = await packGroups(items(23), (group) => Promise.resolve(group.length <= 5));
    expect(spans?.map((s) => s.itemCount)).toEqual([5, 5, 5, 5, 3]);
    expect(spans?.map((s) => s.firstItem)).toEqual([0, 5, 10, 15, 20]);
    expect(spans?.[4]).toMatchObject({ firstChapter: 21, lastChapter: 23 });
  });

  it('finds the boundary by doubling and bisection, not item by item', async () => {
    let calls = 0;
    const spans = await packGroups(items(400), (group) => {
      calls++;
      return Promise.resolve(group.length <= 100);
    });
    expect(spans?.map((s) => s.itemCount)).toEqual([100, 100, 100, 100]);
    expect(calls).toBeLessThan(60);
  });

  it('takes everything in one group when all of it fits', async () => {
    const spans = await packGroups(items(7), () => Promise.resolve(true));
    expect(spans).toEqual([{ firstItem: 0, itemCount: 7, firstChapter: 1, lastChapter: 7 }]);
  });

  it('is null when one item does not fit alone (DOSSIER_TOO_LONG)', async () => {
    expect(await packGroups(items(3), () => Promise.resolve(false))).toBeNull();
    expect(
      await packGroups(items(3), (g) => Promise.resolve(!g.some((i) => i.firstChapter === 2))),
    ).toBeNull();
  });

  it('keeps the chapter range of a group made of groups', async () => {
    const wide: GroupItem[] = [
      { firstChapter: 1, lastChapter: 40, entry: {} },
      { firstChapter: 41, lastChapter: 90, entry: {} },
    ];
    const spans = await packGroups(wide, () => Promise.resolve(true));
    expect(spans).toEqual([{ firstItem: 0, itemCount: 2, firstChapter: 1, lastChapter: 90 }]);
  });
});

describe('summaryLevels', () => {
  it('a single call when the answers fit', () => {
    expect(summaryLevels(10, 10)).toEqual({ groupsPerLevel: [], finalItems: 10 });
    expect(summaryLevels(10, Number.POSITIVE_INFINITY)).toEqual({
      groupsPerLevel: [],
      finalItems: 10,
    });
  });

  it('groups per level until the last call fits', () => {
    expect(summaryLevels(250, 20)).toEqual({ groupsPerLevel: [13], finalItems: 13 });
    expect(summaryLevels(250, 5)).toEqual({ groupsPerLevel: [50, 10, 2], finalItems: 2 });
  });

  it('one item per call: the first level keeps every item, later levels at least halve', () => {
    expect(summaryLevels(50, 1)).toEqual({ groupsPerLevel: [50, 25, 13, 7, 4, 2], finalItems: 2 });
  });
});

describe('levelNarrows (Р3)', () => {
  it('level 0 may keep every item in its own group', () => {
    expect(levelNarrows(0, 5, 5)).toBe(true);
  });

  it('a higher level passes when it at least halves, an odd tail included', () => {
    expect(levelNarrows(1, 8, 4)).toBe(true);
    expect(levelNarrows(1, 7, 4)).toBe(true);
    expect(levelNarrows(2, 2, 1)).toBe(true);
  });

  it('a higher level that narrows by less than half fails', () => {
    expect(levelNarrows(1, 8, 5)).toBe(false);
    expect(levelNarrows(1, 5, 4)).toBe(false);
  });

  it('one item regrouped alone is not progress', () => {
    expect(levelNarrows(1, 1, 1)).toBe(false);
  });
});

describe('summaryInputChars (Р6)', () => {
  /** Псевдослучайный, но повторяемый генератор: сбой воспроизводится тем же тестом. */
  const random = (start: number) => {
    let state = start;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  };

  it('equals the input length of the real summary request for any group, empty and single included', () => {
    const next = random(7);
    const chapters = Array.from({ length: 30 }, (_, i) => ({
      number: i + 1,
      title: `Ch ${i + 1}`,
    }));
    const entry = (i: number) => ({
      chapterNumber: i + 1,
      partIndex: 0,
      data: {
        // Кавычка, обратная косая и не-ASCII: их JSON экранирует, длина считается после этого.
        summary:
          `é"${String.fromCharCode(92)}`.repeat(Math.floor(next() * 50)) +
          'x'.repeat(Math.floor(next() * 400)),
        events: [{ event: `e${i}`, orderNote: '' }],
      },
    });
    const empty = estimateInputTokens(dossierSummaryRequest({ chapters, parts: [] }));
    for (const size of [0, 1, 2, 5, 17]) {
      for (let round = 0; round < 5; round++) {
        const parts = Array.from({ length: size }, (_, i) => entry(i));
        const real = estimateInputTokens(dossierSummaryRequest({ chapters, parts }));
        const summed = summaryInputChars(
          empty,
          parts.map((p) => JSON.stringify(p).length),
        );
        expect(summed).toBe(real);
      }
    }
  });
});
