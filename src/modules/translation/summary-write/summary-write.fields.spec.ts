import { chapterChanged, sectionCoverage } from './summary-write.fields';

/**
 * Охват глав раздела версии и иное деление у замены раздела того же номера (`F06-2`, решение
 * арбитра `F06 | F06-2`, круг 1, В3): охват - от главы читалки раздела до главы перед следующим
 * разделом, у последнего - до последней главы версии.
 */
describe('section coverage and chapter change', () => {
  const section = (number: number, readerChapter: number | null) => ({
    number,
    title: `S${number}`,
    text: '<p>x</p>',
    readerChapter,
  });
  const state = (readers: Array<number | null>, lastChapter: number | null = 10) => ({
    sections: readers.map((r, i) => section(i + 1, r)),
    lastChapter,
  });

  it('a section covers its chapter up to the one before the next section; the last - up to the last chapter', () => {
    const s = state([1, 4, 7]);
    expect(sectionCoverage(s, 1)).toEqual({ from: 1, to: 3 });
    expect(sectionCoverage(s, 2)).toEqual({ from: 4, to: 6 });
    expect(sectionCoverage(s, 3)).toEqual({ from: 7, to: 10 });
    expect(sectionCoverage(s, 4)).toBeNull();
  });

  it('a coverage that cannot be derived is null: no reader chapter, chapters not ascending, no chapters', () => {
    expect(sectionCoverage(state([null, 4]), 1)).toBeNull();
    expect(sectionCoverage(state([1, null]), 1)).toBeNull();
    expect(sectionCoverage(state([5, 3]), 1)).toBeNull();
    expect(sectionCoverage(state([1], null), 1)).toBeNull();
  });

  it('the same coverage is not a change; another end, chapters with a gap or an unknown coverage are', () => {
    const s = state([1, 4, 7]);
    expect(chapterChanged({ chapters: [4, 5, 6] }, s, 2)).toBe(false);
    expect(chapterChanged({ chapters: [6, 4, 5] }, s, 2)).toBe(false);
    expect(chapterChanged({ chapters: [4, 5] }, s, 2)).toBe(true);
    expect(chapterChanged({ chapters: [4, 6] }, s, 2)).toBe(true);
    expect(chapterChanged({ chapters: [] }, s, 2)).toBe(true);
    expect(chapterChanged({ chapters: null }, s, 2)).toBe(true);
    expect(chapterChanged({ chapters: [1] }, state([null]), 1)).toBe(true);
  });
});
