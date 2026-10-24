import { Prisma } from '@prisma/client';
import { addChapterFindings, ChapterFindingsRow } from './chapter-findings';

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
