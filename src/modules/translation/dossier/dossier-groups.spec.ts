import { ANSWER_CHARS_PER_TOKEN, estimateInputTokens } from '../../llm/openrouter.client';
import {
  distinctChapters,
  dossierListLimits,
  exceedsChapterCap,
  groupSectionCap,
  level0GroupsUpperBound,
  GroupItem,
  groupChapterCap,
  levelNarrows,
  packGroups,
  refusedBeforeParts,
  SUMMARY_ITEM_WRAPPER_CHARS,
  summaryCapacity,
  summaryInputChars,
  summaryItemChars,
  summaryLevels,
} from './dossier-groups';
import { dossierSummaryRequest, emptyMergeInputChars } from './dossier.prompts';

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
    const limits = dossierListLimits(16_000);
    const empty = estimateInputTokens(dossierSummaryRequest({ chapters, parts: [], limits }));
    for (const size of [0, 1, 2, 5, 17]) {
      for (let round = 0; round < 5; round++) {
        const parts = Array.from({ length: size }, (_, i) => entry(i));
        const real = estimateInputTokens(dossierSummaryRequest({ chapters, parts, limits }));
        const summed = summaryInputChars(
          empty,
          parts.map((p) => JSON.stringify(p).length),
        );
        expect(summed).toBe(real);
      }
    }
  });
});

describe('chapter limit of a level 0 group (F05-12)', () => {
  it('40 % of maxTokens at 350 tokens a chapter, recounted from the stage setting', () => {
    expect(groupChapterCap(16_000)).toBe(18);
    expect(groupChapterCap(2_000)).toBe(2);
    expect(groupChapterCap(100)).toBe(1);
  });

  it('groups are needed above the limit, not at it', () => {
    expect(exceedsChapterCap(18, 16_000)).toBe(false);
    expect(exceedsChapterCap(19, 16_000)).toBe(true);
  });

  it('level 0 groups for the estimate: none when one summary fits, otherwise both limits added up', () => {
    expect(level0GroupsUpperBound(18, 18, Number.POSITIVE_INFINITY, 16_000)).toBe(0);
    expect(level0GroupsUpperBound(250, 250, Number.POSITIVE_INFINITY, 16_000)).toBe(14);
    // Упаковка закрывает группу по тому пределу, что настал раньше: 10 по входу, 4 по главам, 1.
    expect(level0GroupsUpperBound(100, 80, 10, 16_000)).toBe(15);
    // Групп не больше кусков.
    expect(level0GroupsUpperBound(3, 3, 1, 16_000)).toBe(3);
  });

  it('a level 0 group gets its share of the 200 sections, at least one, and the shares fit the cap', () => {
    expect(groupSectionCap(40, 40, 1)).toBe(195);
    expect(groupSectionCap(40, 2_001, 51)).toBe(3);
    expect(groupSectionCap(1, 2_001, 51)).toBe(1);
    const shares = [40, 40, 40, 40, 40, 40, 10].map((n) => groupSectionCap(n, 250, 7));
    expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200);
    // Глава 21 разрезана между двумя группами и считается у обеих: 21 + 21 из 41 главы.
    expect(groupSectionCap(21, 41, 2) * 2).toBeLessThanOrEqual(200);
  });

  it('the estimate bound is never below the groups the packing really makes, both limits mixed', async () => {
    /** Повторяемый генератор: сбой воспроизводится тем же тестом. */
    let state = 11;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    for (let round = 0; round < 40; round++) {
      // Главы по 1-6 кусков, куски разной длины: предел по входу и по главам срабатывают вперемешку.
      const pieces: Array<GroupItem & { size: number }> = [];
      const chapters = 20 + Math.floor(next() * 200);
      for (let c = 1; c <= chapters; c++) {
        const count = 1 + Math.floor(next() * 6);
        for (let i = 0; i < count; i++) {
          pieces.push({ ...item(c), size: 1 + Math.floor(next() * 100) });
        }
      }
      const maxTokens = [400, 2_000, 16_000][round % 3];
      const capacity = 2 + Math.floor(next() * 30);
      // Упаковка по входу: элемент не больше одного «ответа», в группе не больше `capacity` ответов.
      const sizes = new Map<GroupItem, number>(pieces.map((p) => [p, p.size]));
      const spans = await packGroups(pieces, (group) =>
        Promise.resolve(
          group.reduce((sum, p) => sum + (sizes.get(p) ?? 0), 0) <= capacity * 100 &&
            distinctChapters(group) <= groupChapterCap(maxTokens),
        ),
      );
      const bound = level0GroupsUpperBound(pieces.length, chapters, capacity, maxTokens);
      expect(spans).not.toBeNull();
      if ((spans ?? []).length > 1) expect(bound).toBeGreaterThanOrEqual((spans ?? []).length);
    }
  });

  it('caps characters, entities and chronology from maxTokens, at least one each', () => {
    expect(dossierListLimits(16_000)).toEqual({ characters: 64, entities: 50, chronology: 50 });
    expect(dossierListLimits(2_000)).toEqual({ characters: 8, entities: 6, chronology: 6 });
    expect(dossierListLimits(100)).toEqual({ characters: 1, entities: 1, chronology: 1 });
  });

  it('counts chapters, not pieces: pieces of one chapter count once', () => {
    const pieces = [item(1), item(1), item(2), item(3), item(3)];
    expect(distinctChapters(pieces)).toBe(3);
  });

  it('packs groups under the chapter limit even when the input would fit whole', async () => {
    const all = Array.from({ length: 250 }, (_, i) => item(i + 1));
    const spans = await packGroups(all, (group) => Promise.resolve(distinctChapters(group) <= 100));
    expect(spans?.map((s) => s.itemCount)).toEqual([100, 100, 50]);
  });
});

describe('summaryCapacity (F05-12, Р3 revised)', () => {
  it('answers of maxTokens with the item wrapper that surely fit the room', () => {
    const answer = 2_000 * ANSWER_CHARS_PER_TOKEN + SUMMARY_ITEM_WRAPPER_CHARS;
    expect(summaryCapacity(2 * answer, 2_000)).toBe(2);
    expect(summaryCapacity(2 * answer - 1, 2_000)).toBe(1);
    expect(summaryCapacity(-5, 2_000)).toBe(-1);
  });

  it('the wrapper covers the JSON of a piece and of a group around the answer, with the comma', () => {
    const data = { summary: 'x' };
    const inner = JSON.stringify(data).length;
    for (const entry of [
      { chapterNumber: 12_345, partIndex: 7, data },
      { firstChapter: 1_000, lastChapter: 12_345, data },
    ]) {
      expect(JSON.stringify(entry).length + 1).toBeLessThanOrEqual(
        inner + SUMMARY_ITEM_WRAPPER_CHARS,
      );
    }
  });
});

describe('refusal before the parts are paid (F05-13b)', () => {
  // maxTokens 16 000: K = 18, два ответа группы выше уровня 0 - 2 × (64 000 + обёртка) символов.
  const twoAnswers = 2 * summaryItemChars(16_000);

  it('refuses only over the chapter limit and only when two group answers do not fit above', () => {
    expect(refusedBeforeParts(19, twoAnswers + 999, 1_000, 16_000)).toBe(true);
    expect(refusedBeforeParts(19, twoAnswers + 1_000, 1_000, 16_000)).toBe(false);
    // Глав не больше K - одна сводка или группы по входу, отказ решает обработчик.
    expect(refusedBeforeParts(18, 0, 1_000, 16_000)).toBe(false);
  });

  it('an unknown input ceiling never refuses, as in the handler', () => {
    expect(refusedBeforeParts(313, null, 1_000, 16_000)).toBe(false);
  });

  it('a ceiling below the empty request refuses, as upperLevelFits does in the handler', () => {
    expect(refusedBeforeParts(19, 500, 1_000, 16_000)).toBe(true);
  });

  it('the empty upper-level input is the merge request with every chapter title, counted against the ceiling', () => {
    const titles = Array.from({ length: 19 }, (_, i) => ({
      number: i + 1,
      title: 'T'.repeat(500),
    }));
    const limits = dossierListLimits(16_000);
    const empty = emptyMergeInputChars(titles, limits);
    // Названия всех глав входят в мерку символ в символ: длиннее на 400 у каждой - мерка на 19 × 400.
    const short = emptyMergeInputChars(
      titles.map((t) => ({ ...t, title: 'T'.repeat(100) })),
      limits,
    );
    expect(empty - short).toBe(19 * 400);
    expect(refusedBeforeParts(19, twoAnswers + empty - 1, empty, 16_000)).toBe(true);
    expect(refusedBeforeParts(19, twoAnswers + 19 * 500, empty, 16_000)).toBe(true);
  });
});
