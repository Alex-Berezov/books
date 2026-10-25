import { Prisma } from '@prisma/client';
import {
  activeFlagOf,
  addChapterFindings,
  ChapterFindingsRow,
  rebuiltFindings,
  writeRebuiltFindings,
} from './chapter-findings';

interface StoredChapter {
  status: string;
  flagReason: string | null;
  seamIndex: number | null;
  findings: unknown[];
}

/**
 * Транзакция на подмене: строка главы в «базе» с условиями `where`, как у `updateMany`, и счётчик
 * флагов языка. Строка шага (`row`) может отставать от «базы» - так шаг видит главу после
 * потерянной аренды.
 */
function fakeTx(stored: StoredChapter) {
  let flaggedChapters = 0;
  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([k, v]) => k === 'id' || (stored as unknown as Record<string, unknown>)[k] === v,
    );
  const tx = {
    translationChapter: {
      updateMany: jest.fn(
        (args: { where: Record<string, unknown>; data: Partial<StoredChapter> }) => {
          if (!matches(args.where)) return Promise.resolve({ count: 0 });
          Object.assign(stored, args.data);
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    translationRunLanguage: {
      update: jest.fn(() => {
        flaggedChapters += 1;
        return Promise.resolve({});
      }),
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, flagged: () => flaggedChapters };
}

const fresh = (over: Partial<StoredChapter> = {}): StoredChapter => ({
  status: 'assembled',
  flagReason: null,
  seamIndex: null,
  findings: [],
  ...over,
});
const rowOf = (s: StoredChapter): ChapterFindingsRow => ({
  id: 'ch',
  chapterNumber: 1,
  flagReason: s.flagReason,
  seamIndex: s.seamIndex,
  findings: [...s.findings] as Prisma.JsonValue,
});

describe('addChapterFindings', () => {
  it('the first flag sets flagReason and the joint number and counts once; records are appended', async () => {
    const stored = fresh();
    const { tx, flagged } = fakeTx(stored);
    await addChapterFindings(tx, 'lang', rowOf(stored), [
      { code: 'SEAM_CHECKED', seam: 1 },
      { code: 'SEAM_BROKEN', seam: 2 },
      { code: 'GLOSSARY_SOURCE_FORM' },
    ]);
    expect(stored).toEqual({
      status: 'assembled',
      flagReason: 'SEAM_BROKEN',
      seamIndex: 2,
      findings: [
        { code: 'SEAM_CHECKED', seam: 1 },
        { code: 'SEAM_BROKEN', seam: 2 },
        { code: 'GLOSSARY_SOURCE_FORM' },
      ],
    });
    expect(flagged()).toBe(1);
  });

  it('a chapter already flagged keeps its flag and is not counted again', async () => {
    const stored = fresh({
      flagReason: 'SEAM_REPEAT',
      seamIndex: 1,
      findings: [{ code: 'SEAM_REPEAT', seam: 1 }],
    });
    const { tx, flagged } = fakeTx(stored);
    await addChapterFindings(tx, 'lang', rowOf(stored), [{ code: 'FINAL_CHECK_FAIL' }]);
    expect(stored.flagReason).toBe('SEAM_REPEAT');
    expect(stored.findings).toEqual([
      { code: 'SEAM_REPEAT', seam: 1 },
      { code: 'FINAL_CHECK_FAIL' },
    ]);
    expect(flagged()).toBe(0);
  });

  it('a step with a row read before another step flagged the chapter does not count it twice', async () => {
    const stored = fresh();
    const stale = rowOf(stored);
    const { tx, flagged } = fakeTx(stored);
    await addChapterFindings(tx, 'lang', stale, [{ code: 'FINAL_CHECK_FAIL' }]);
    // Второй исполнитель с той же строкой, прочитанной до первого (аренду забрали посреди вызова).
    await addChapterFindings(tx, 'lang', stale, [{ code: 'FINAL_NOT_INDEPENDENT' }]);
    expect(stored.flagReason).toBe('FINAL_CHECK_FAIL');
    expect(flagged()).toBe(1);
  });

  it('only paid answers without a problem: no flag, no count', async () => {
    const stored = fresh();
    const { tx, flagged } = fakeTx(stored);
    await addChapterFindings(tx, 'lang', rowOf(stored), [{ code: 'FINAL_CHECKED' }]);
    expect(stored).toMatchObject({ flagReason: null, findings: [{ code: 'FINAL_CHECKED' }] });
    expect(flagged()).toBe(0);
  });

  it('the flag from findings already written (closing a chapter), with the status change and its condition', async () => {
    const stored = fresh({ status: 'pending' });
    const { tx, flagged } = fakeTx(stored);
    const written = await addChapterFindings(tx, 'lang', rowOf(stored), [], {
      data: { status: 'assembled' },
      where: { status: 'pending' },
      flagFrom: [
        { code: 'SEAM_CHECKED', seam: 1 },
        { code: 'SEAM_NOT_INDEPENDENT', seam: 2 },
      ],
    });
    expect(written).toBe(true);
    expect(stored).toMatchObject({
      status: 'assembled',
      flagReason: 'SEAM_NOT_INDEPENDENT',
      seamIndex: 2,
    });
    expect(flagged()).toBe(1);
  });

  it('no row changed (the status moved on): no flag, not counted', async () => {
    const stored = fresh({ status: 'written' });
    const { tx, flagged } = fakeTx(stored);
    const written = await addChapterFindings(
      tx,
      'lang',
      rowOf(stored),
      [{ code: 'TITLE_MISSING' }],
      { where: { status: 'assembled' } },
    );
    expect(written).toBe(false);
    expect(stored.flagReason).toBeNull();
    expect(flagged()).toBe(0);
  });
});

describe('addChapterFindings, overwriteFlag (a chapter not written to the draft)', () => {
  it('replaces the flag of an already flagged chapter without counting it again', async () => {
    const stored = fresh({ flagReason: 'CHUNK_FLAGGED', findings: [{ code: 'CHUNK_FLAGGED' }] });
    const { tx, flagged } = fakeTx(stored);
    await addChapterFindings(tx, 'lang', rowOf(stored), [{ code: 'SOURCE_CHANGED' }], {
      data: { status: 'flagged' },
      where: { status: 'assembled' },
      overwriteFlag: true,
    });
    expect(stored).toMatchObject({ status: 'flagged', flagReason: 'SOURCE_CHANGED' });
    expect(stored.findings).toEqual([{ code: 'CHUNK_FLAGGED' }, { code: 'SOURCE_CHANGED' }]);
    expect(flagged()).toBe(0);
  });

  it('a chapter without a flag gets it and is counted once', async () => {
    const stored = fresh();
    const { tx, flagged } = fakeTx(stored);
    await addChapterFindings(tx, 'lang', rowOf(stored), [{ code: 'CHUNK_UNTRANSLATED' }], {
      data: { status: 'flagged' },
      where: { status: 'assembled' },
      overwriteFlag: true,
    });
    expect(stored.flagReason).toBe('CHUNK_UNTRANSLATED');
    expect(flagged()).toBe(1);
  });
});

describe('findings after a retry or a hand edit (F05-7v)', () => {
  const previous = [
    { code: 'SEAM_REPEAT', seam: 1 },
    { code: 'CHUNK_FLAGGED', chunkIndex: 0, chunkReason: 'JEV_LANGUAGE' },
    { code: 'SEAM_BROKEN', seam: 2, model: 'm', costUsd: '0.1' },
    { code: 'SEAM_CHECKED', seam: 1, model: 'm', costUsd: '0.1' },
    { code: 'FINAL_CHECK_FAIL' },
    { code: 'TITLE_MISSING' },
  ] as unknown as Prisma.JsonValue;

  it('code findings are replaced by fresh ones, model answers stay stale, draft findings stay as is', () => {
    const rebuilt = rebuiltFindings(previous, [{ code: 'SEAM_REPEAT', seam: 3 }]);
    expect(rebuilt).toEqual([
      { code: 'SEAM_REPEAT', seam: 3 },
      { code: 'SEAM_BROKEN', seam: 2, model: 'm', costUsd: '0.1', stale: true },
      { code: 'SEAM_CHECKED', seam: 1, model: 'm', costUsd: '0.1', stale: true },
      { code: 'FINAL_CHECK_FAIL', stale: true },
      { code: 'TITLE_MISSING' },
    ]);
    expect(activeFlagOf(rebuilt)).toEqual({ flagReason: 'SEAM_REPEAT', seamIndex: 3 });
  });

  it('stale findings do not flag: only the draft finding is left', () => {
    const rebuilt = rebuiltFindings(previous, []);
    expect(activeFlagOf(rebuilt)).toEqual({ flagReason: 'TITLE_MISSING', seamIndex: null });
  });

  it('a chapter that is not written carries its code last and as the flag', () => {
    const rebuilt = rebuiltFindings(
      [],
      [{ code: 'CHUNK_UNTRANSLATED', chunkIndex: 1 }],
      'CHUNK_UNTRANSLATED',
    );
    expect(rebuilt).toEqual([{ code: 'CHUNK_UNTRANSLATED', chunkIndex: 1 }]);
    const changed = rebuiltFindings([], [], 'SOURCE_CHANGED');
    expect(changed).toEqual([{ code: 'SOURCE_CHANGED' }]);
    expect(activeFlagOf(changed, 'SOURCE_CHANGED').flagReason).toBe('SOURCE_CHANGED');
  });

  describe('writeRebuiltFindings', () => {
    const txOf = () => {
      const update = jest.fn().mockResolvedValue({});
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const tx = {
        translationChapter: { update },
        translationRunLanguage: { updateMany },
      } as unknown as Prisma.TransactionClient;
      return { tx, update, updateMany };
    };

    it('the flag goes away: flaggedChapters -1, not below zero', async () => {
      const { tx, update, updateMany } = txOf();
      await writeRebuiltFindings(tx, 'lang', { id: 'ch', flagReason: 'SEAM_REPEAT' }, [], {
        status: 'written',
      });
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'ch' },
        data: { status: 'written', flagReason: null, seamIndex: null, findings: [] },
      });
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'lang', flaggedChapters: { gt: 0 } },
        data: { flaggedChapters: { decrement: 1 } },
      });
    });

    it('a flag appears: flaggedChapters +1', async () => {
      const { tx, updateMany } = txOf();
      await writeRebuiltFindings(
        tx,
        'lang',
        { id: 'ch', flagReason: null },
        [{ code: 'SEAM_REPEAT', seam: 1 }],
        {},
      );
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'lang' },
        data: { flaggedChapters: { increment: 1 } },
      });
    });

    it('the flag stays (even with another code): the counter is not touched', async () => {
      const { tx, updateMany } = txOf();
      await writeRebuiltFindings(
        tx,
        'lang',
        { id: 'ch', flagReason: 'FINAL_CHECK_FAIL' },
        [{ code: 'SEAM_REPEAT', seam: 1 }],
        {},
      );
      expect(updateMany).not.toHaveBeenCalled();
    });
  });
});
