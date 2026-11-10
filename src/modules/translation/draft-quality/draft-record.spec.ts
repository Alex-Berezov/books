import { ANALYSIS_REVIEW_KINDS } from '../analysis-write/analysis-write.data';
import { REVIEW_KINDS } from '../summary-write/summary-write.data';
import { remarksReader, reviewReader } from './draft-record';
import { DRAFT_REMARK_CODES, SUMMARY_REMARK_CODES } from './text-checks';

/** Чтение замечаний и итога проверяющей из `ContentDraft.data` - общее у пересказа и анализа (`T178`). */

const remark = (code: string) => ({ code, by: 'model', where: 'w', note: 'n' });

describe('remarksReader', () => {
  it('the summary set drops a code of the analysis; the analysis set keeps it', () => {
    const list = [remark('STYLE_POOR'), remark('NOT_IN_TEXT')];
    expect(remarksReader(SUMMARY_REMARK_CODES)(list)).toEqual([remark('STYLE_POOR')]);
    expect(remarksReader(DRAFT_REMARK_CODES)(list)).toEqual(list);
  });

  it('a remark of a wrong shape is dropped, not a list - empty', () => {
    const read = remarksReader(DRAFT_REMARK_CODES);
    const good = remark('STYLE_POOR');
    expect(
      read([good, { ...good, by: 'x' }, { ...good, where: 1 }, { ...good, note: null }, 7]),
    ).toEqual([good]);
    expect(read('nope')).toEqual([]);
    expect(read(undefined)).toEqual([]);
  });
});

describe('reviewReader', () => {
  it.each([
    ['summary', REVIEW_KINDS],
    ['analysis', ANALYSIS_REVIEW_KINDS],
  ] as const)('%s: every kind of its list is read, answered needs its model', (_name, kinds) => {
    const read = reviewReader(kinds);
    for (const kind of kinds) {
      if (kind === 'answered') continue;
      expect(read({ kind })).toEqual({ kind });
    }
    expect(read({ kind: 'answered', model: 'm' })).toEqual({ kind: 'answered', model: 'm' });
    expect(read({ kind: 'answered' })).toBeNull();
    expect(read({ kind: 'unknown' })).toBeNull();
    expect(read(null)).toBeNull();
  });

  it('a kind outside the given list is null', () => {
    expect(reviewReader(['answered'])({ kind: 'invalid' })).toBeNull();
  });
});
