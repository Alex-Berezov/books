import { runPlanOf, sectionSource, sectionTitleOf } from './summary-write.parts';

/** План досье для хода (`F06-2`, решение арбитра `F06 | F06-2`, круг 1, В4): номер - позиция. */
describe('runPlanOf', () => {
  const section = (number: number, chapters: number[]) => ({
    number,
    title: `S${number}`,
    chapters,
    why: 'x',
  });

  it('a gap and a duplicate in the model numbers become 1..N in the plan order', () => {
    const plan = runPlanOf({
      summaryPlan: [section(1, [1]), section(3, [2]), section(3, [3]), section(7, [4])],
    });
    expect(plan.map((p) => [p.number, p.chapters])).toEqual([
      [1, [1]],
      [2, [2]],
      [3, [3]],
      [4, [4]],
    ]);
  });

  it('the plan of a section is its own entry by position, not the entry with the same model number (круг 2)', () => {
    const plan = runPlanOf({
      summaryPlan: [
        { ...section(1, [1]), why: 'w1' },
        null,
        { ...section(3, [2]), why: 'w2' },
        { ...section(3, [3]), why: 'w3' },
      ],
    });
    expect(plan.map((p) => [p.number, p.title, p.why])).toEqual([
      [1, 'S1', 'w1'],
      [2, 'S3', 'w2'],
      [3, 'S3', 'w3'],
    ]);
  });

  it('an empty or missing plan stays empty', () => {
    expect(runPlanOf({ summaryPlan: [] })).toEqual([]);
    expect(runPlanOf(null)).toEqual([]);
  });
});

describe('section title under the rules of «Add section» (круг 2)', () => {
  it('angle brackets are dropped, the title is trimmed and cut to 200 characters without splitting a pair', () => {
    expect(sectionTitleOf('Part I <Prologue>', () => 'x')).toBe('Part I Prologue');
    // 199 знаков + пара из двух единиц UTF-16 - больше 200: пара не режется пополам, а уходит.
    expect(sectionTitleOf(`${'a'.repeat(199)}😀b`, () => 'x')).toBe('a'.repeat(199));
    expect(sectionTitleOf(`${'a'.repeat(198)}😀b`, () => 'x')).toBe(`${'a'.repeat(198)}😀`);
  });

  it('an empty title falls back to the chapter form', () => {
    expect(sectionTitleOf(' <> ', () => 'Chapter 4')).toBe('Chapter 4');
  });

  it('a chapter title with brackets becomes a plain section title', () => {
    const source = sectionSource(
      { number: 1, title: 'Plan', chapters: [1], why: '' },
      [{ number: 1, title: '<Intro>', content: '<p>Anna.</p>' }],
      'en',
    );
    expect(source.title).toBe('Intro');
  });
});
