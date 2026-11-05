import { SourceRefs, StepDraft } from './analysis-write.data';
import { codeRemark } from '../draft-quality/text-checks';
import {
  composeKept,
  hostOf,
  overLimit,
  ownSources,
  PageCheck,
  pageIsAbout,
  remapRemarks,
  sourcesOffline,
  surname,
  verifyExternal,
  withoutDoubted,
  withoutInvalidSources,
} from './analysis-write.external';

const TITLES = ['Преступление и наказание', 'Crime and Punishment'];
const AUTHORS = ['Фёдор Достоевский'];

const page = (text: string, opened = true, host = 'a.example'): PageCheck => ({
  host,
  opened,
  text,
});
const ABOUT = 'Роман Достоевского «Преступление и наказание» вышел в 1866 году.';

const refs = (over: Partial<SourceRefs> = {}): SourceRefs => ({
  facts: {},
  context: [],
  reception: [],
  timeline: [],
  adaptations: [],
  ...over,
});

const draft = (blocks: StepDraft['blocks'], r: SourceRefs): StepDraft => ({
  blocks,
  themeLinks: null,
  refs: r,
  droppedQuotes: [],
  fixes: [],
});

const SOURCES = [
  { title: 'One', url: 'https://a.example/1' },
  { title: 'Two', url: 'https://b.example/2' },
];

describe('pageIsAbout', () => {
  it('finds the title in any of the languages, case and diacritics aside', () => {
    expect(pageIsAbout('the novel CRIME AND punishment', TITLES, AUTHORS)).toBe(true);
    expect(pageIsAbout('Un román de Dostoïevski', [], ['Fiodor Dostoïevski'])).toBe(true);
  });

  it('a name matches as a whole word only: Eco is not in economy, Dune not in Dunedin', () => {
    expect(pageIsAbout('A page about the economy and ecology', [], ['Umberto Eco'])).toBe(false);
    expect(pageIsAbout('Umberto Eco, «Il nome della rosa»', [], ['Umberto Eco'])).toBe(true);
    expect(pageIsAbout('A trip to Dunedin', ['Dune'], [])).toBe(false);
    expect(pageIsAbout('Dune (1965) by Herbert', ['Dune'], [])).toBe(true);
    // Название из нескольких слов - через любые пробелы страницы.
    expect(pageIsAbout('Crime   and\npunishment, 1866', TITLES, [])).toBe(true);
  });

  it('a page that names neither the book nor the author is unrelated', () => {
    expect(pageIsAbout('A recipe for soup', TITLES, AUTHORS)).toBe(false);
  });

  it('a name shorter than three signs does not count: it is in every text', () => {
    expect(pageIsAbout('any text with an in it', ['An'], ['X Y'])).toBe(false);
  });

  it('the surname is the last word of the author', () => {
    expect(surname('Fyodor Mikhailovich Dostoevsky')).toBe('Dostoevsky');
    expect(surname('')).toBe('');
  });

  it('the host of an address, nothing of its parameters; not an address - empty', () => {
    expect(hostOf('https://ru.wikipedia.org/wiki/X?token=1')).toBe('ru.wikipedia.org');
    expect(hostOf('not a url')).toBe('');
  });
});

describe('sourcesOffline', () => {
  it('only when every source failed by the channel: one page that answered is not offline', () => {
    const down = { host: 'a', opened: false, text: '', transport: true };
    expect(sourcesOffline([down, down])).toBe(true);
    expect(sourcesOffline([down, { ...down, transport: false }])).toBe(false);
    expect(sourcesOffline([down, { host: 'b', opened: true, text: ABOUT }])).toBe(false);
    expect(sourcesOffline([])).toBe(false);
  });
});

describe('withoutDoubted (EXTERNAL_DOUBT, product.md §3.4)', () => {
  const doubt = (where: string) => ({
    ...codeRemark('EXTERNAL_DOUBT', where, 'doubt'),
    by: 'model' as const,
  });

  it('the doubted statement is removed with its refs: a paragraph, an element, a fact', () => {
    const { draft: out, fixes } = withoutDoubted(
      draft(
        {
          facts: { genre: 'novel', writtenYears: '1865' },
          context: 'One.\n\nTwo.',
          timeline: [
            { year: '1866', event: 'A', kind: 'book' },
            { year: '1867', event: 'B', kind: 'book' },
          ],
          sources: SOURCES,
        },
        refs({
          facts: { genre: [0], writtenYears: [1] },
          context: [[0], [1]],
          timeline: [[0], [1]],
        }),
      ),
      [doubt('context.1: Two'), doubt('timeline.0'), doubt('facts.writtenYears')],
    );
    expect(out.blocks.context).toBe('One.');
    expect(out.blocks.timeline).toEqual([{ year: '1867', event: 'B', kind: 'book' }]);
    expect(out.blocks.facts).toEqual({ genre: 'novel' });
    expect(out.refs).toMatchObject({ context: [[0]], timeline: [[1]], facts: { genre: [0] } });
    expect(fixes.map((f) => f.path).sort()).toEqual([
      'context.1',
      'facts.writtenYears',
      'timeline.0',
    ]);
  });

  it('only the doubts that removed something are applied: a path it does not know stays a flag', () => {
    const known = doubt('timeline.0');
    const unknown = doubt('sources.1: the address is doubtful');
    const { applied } = withoutDoubted(
      draft(
        { timeline: [{ year: '1866', event: 'A', kind: 'book' }], sources: SOURCES },
        refs({ timeline: [[0]] }),
      ),
      [known, unknown],
    );
    expect(applied).toEqual([known]);
  });

  it('a path without a number removes the whole block; other remarks remove nothing', () => {
    const { draft: out } = withoutDoubted(
      draft({ reception: 'A.\n\nB.', sources: SOURCES }, refs({ reception: [[0], [0]] })),
      [doubt('reception'), { ...doubt('context.0'), code: 'STYLE_POOR' }],
    );
    expect(out.blocks).toEqual({ sources: SOURCES });
  });
});

describe('withoutInvalidSources (one bad address is not the whole sources block)', () => {
  const invalid = (where: string) => codeRemark('IMPORT_INVALID', where, 'bad');

  it('the source failing the import goes alone; the refs of the rest move with it; its remark leaves the flags', () => {
    const three = [...SOURCES, { title: 'Three', url: 'https://c.example/3' }];
    const style = codeRemark('LANGUAGE_MIXED', 'context.0', 'x');
    const out = withoutInvalidSources(
      draft({ context: 'A.\n\nB.', sources: three }, refs({ context: [[1], [2]] })),
      [invalid('sources.1.url'), style],
    );
    expect(out.draft.blocks.sources?.map((s) => s.title)).toEqual(['One', 'Three']);
    expect(out.draft.refs?.context).toEqual([[], [1]]);
    expect(out.remarks).toEqual([style]);
    expect(out.fixes).toEqual([
      expect.objectContaining({ code: 'IMPORT_INVALID', path: 'sources.1' }),
    ]);
  });

  it('no remark on sources - nothing changes', () => {
    const d = draft({ sources: SOURCES }, refs());
    expect(withoutInvalidSources(d, [invalid('context.0')]).draft).toBe(d);
  });
});

describe('verifyExternal', () => {
  it('a verified source keeps its statements and the block is written with that source only', () => {
    const verdict = verifyExternal(
      draft(
        { context: 'First.\n\nSecond.', facts: { genre: 'novel' }, sources: SOURCES },
        refs({ context: [[0], [1]], facts: { genre: [0] } }),
      ),
      [page(ABOUT), page('Soup', true, 'b.example')],
      TITLES,
      AUTHORS,
    );
    expect(verdict.draft.blocks.context).toBe('First.');
    expect(verdict.draft.blocks.facts).toEqual({ genre: 'novel' });
    expect(verdict.draft.blocks.sources).toEqual([SOURCES[0]]);
    expect(verdict.droppedSources).toEqual([
      { title: 'Two', host: 'b.example', reason: 'SOURCE_UNRELATED' },
    ]);
    expect(verdict.fixes.map((f) => f.code).sort()).toEqual([
      'SOURCE_UNRELATED',
      'SOURCE_UNVERIFIED',
    ]);
  });

  it('a source that does not open is dropped with SOURCE_UNREACHABLE and its host only', () => {
    const verdict = verifyExternal(
      draft({ reception: 'Praised.', sources: [SOURCES[0]] }, refs({ reception: [[0]] })),
      [page('', false, 'a.example')],
      TITLES,
      AUTHORS,
    );
    expect(verdict.droppedSources).toEqual([
      { title: 'One', host: 'a.example', reason: 'SOURCE_UNREACHABLE' },
    ]);
    expect(JSON.stringify(verdict)).not.toContain('/1');
  });

  it('no verified source: nothing is written, every given unit is reported unverified', () => {
    const verdict = verifyExternal(
      draft(
        {
          facts: { genre: 'novel', movement: 'realism' },
          context: 'Epoch.',
          timeline: [{ year: '1866', event: 'Published', kind: 'book' }],
          sources: [SOURCES[0]],
        },
        refs({ facts: { genre: [0], movement: [0] }, context: [[0]], timeline: [[0]] }),
      ),
      [page('', false)],
      TITLES,
      AUTHORS,
    );
    expect(verdict.draft.blocks).toEqual({});
    expect(verdict.unverified.sort()).toEqual([
      'context',
      'facts.genre',
      'facts.movement',
      'sources',
      'timeline',
    ]);
  });

  it('an element resting on a dropped source only is dropped; one with a second verified source stays', () => {
    const verdict = verifyExternal(
      draft(
        {
          timeline: [
            { year: '1866', event: 'Only the bad source', kind: 'book' },
            { year: '1867', event: 'Both sources', kind: 'book' },
          ],
          sources: SOURCES,
        },
        refs({ timeline: [[1], [0, 1]] }),
      ),
      [page(ABOUT), page('Soup', true, 'b.example')],
      TITLES,
      AUTHORS,
    );
    expect(verdict.draft.blocks.timeline).toEqual([
      { year: '1867', event: 'Both sources', kind: 'book' },
    ]);
  });

  it('a statement with no ref at all, or a ref to a source that is not in the answer, is dropped', () => {
    const verdict = verifyExternal(
      draft(
        {
          adaptations: [
            { title: 'No ref', kind: 'film' },
            { title: 'Far ref', kind: 'film' },
            { title: 'Good', kind: 'film' },
          ],
          sources: [SOURCES[0]],
        },
        refs({ adaptations: [[], [7], [0]] }),
      ),
      [page(ABOUT)],
      TITLES,
      AUTHORS,
    );
    expect(verdict.draft.blocks.adaptations?.map((a) => a.title)).toEqual(['Good']);
  });

  it('a source nobody refers to is not written', () => {
    const verdict = verifyExternal(
      draft({ context: 'Epoch.', sources: SOURCES }, refs({ context: [[0]] })),
      [page(ABOUT), page(ABOUT, true, 'b.example')],
      TITLES,
      AUTHORS,
    );
    expect(verdict.draft.blocks.sources).toEqual([SOURCES[0]]);
  });

  it('only the unverified paragraph of context goes: the rest is written', () => {
    const verdict = verifyExternal(
      draft(
        { context: 'Good.\n\nBad.\n\nGood again.', sources: [SOURCES[0]] },
        refs({ context: [[0], [], [0]] }),
      ),
      [page(ABOUT)],
      TITLES,
      AUTHORS,
    );
    expect(verdict.draft.blocks.context).toBe('Good.\n\nGood again.');
    expect(verdict.fixes).toEqual([
      expect.objectContaining({ code: 'SOURCE_UNVERIFIED', path: 'context.1' }),
    ]);
  });
});

describe('the paths of the other remarks of step 5 after drops (F07-2b; review of F07-2a)', () => {
  it('verifyExternal reports the kept indexes of a block it cut; a block it kept whole is absent', () => {
    const verdict = verifyExternal(
      draft(
        {
          timeline: [
            { year: 1860, event: 'A' },
            { year: 1865, event: 'B' },
            { year: 1866, event: 'C' },
          ],
          context: 'One.\n\nTwo.',
          sources: SOURCES,
        } as unknown as StepDraft['blocks'],
        refs({ timeline: [[0], [1], [0]], context: [[0], [0]] }),
      ),
      [page(ABOUT), page('', false)],
      TITLES,
      AUTHORS,
    );
    // Источник 1 не открылся и снят: номера источников тоже сдвигаются.
    expect(verdict.kept).toEqual({ timeline: [0, 2], sources: [0] });
  });

  it('a remark of a kept element follows it to its new index; a remark of a dropped element goes; others stay', () => {
    const remarks = [
      codeRemark('STYLE_POOR', 'timeline.2.event', 'n'),
      codeRemark('STYLE_POOR', 'timeline.1: fragment', 'n'),
      codeRemark('STYLE_POOR', 'context.1', 'n'),
      codeRemark('STYLE_POOR', 'facts.genre', 'n'),
    ];
    const out = remapRemarks(remarks, { timeline: [0, 2] });
    expect(out.map((r) => r.where)).toEqual(['timeline.1.event', 'context.1', 'facts.genre']);
  });

  it('two drops in a row compose: the second numbers are the indexes in the result of the first', () => {
    // Сомнение сняло элемент 1 из [0,1,2,3] → [0,2,3]; проверка сняла второй из оставшихся → [0,3].
    expect(composeKept({ timeline: [0, 2, 3] }, { timeline: [0, 2] })).toEqual({
      timeline: [0, 3],
    });
    expect(composeKept({ context: [1] }, {})).toEqual({ context: [1] });
    expect(composeKept({}, { reception: [0] })).toEqual({ reception: [0] });
  });

  it('withoutDoubted reports what it kept', () => {
    const doubted = withoutDoubted(
      draft(
        {
          adaptations: [
            { title: 'A', year: 1970 },
            { title: 'B', year: 1980 },
          ],
          sources: SOURCES,
        } as unknown as StepDraft['blocks'],
        refs({ adaptations: [[0], [0]] }),
      ),
      [codeRemark('EXTERNAL_DOUBT', 'adaptations.0', 'n')],
    );
    expect(doubted.kept).toEqual({ adaptations: [1] });
  });
});

describe('the paths of the sources after drops (F07-2b, /fix 1)', () => {
  it('a remark on a source follows it after a source before it is dropped by the import', () => {
    const sourced = withoutInvalidSources(
      draft({ sources: [...SOURCES, { title: 'Three', url: 'https://c.example/3' }] }, refs()),
      [codeRemark('IMPORT_INVALID', 'sources.0.url', 'n')],
    );
    expect(sourced.kept).toEqual({ sources: [1, 2] });
    const out = remapRemarks([codeRemark('STYLE_POOR', 'sources.2.title', 'n')], sourced.kept);
    expect(out.map((r) => r.where)).toEqual(['sources.1.title']);
  });

  it('a block keeps its own sources renumbered; refs of the other blocks are gone', () => {
    const own = ownSources(
      draft(
        { context: 'One.', sources: [...SOURCES, { title: 'Three', url: 'https://c.example/3' }] },
        refs({ context: [[2]], timeline: [[0]] }),
      ),
      'context',
      { context: 'One.' },
    );
    expect(own.blocks.sources?.map((x) => x.title)).toEqual(['Three']);
    expect(own.refs).toEqual(refs({ context: [[0]] }));
  });
});

describe('the limit of the saved sources at a regeneration (decision F07 | F07-2b, the limit)', () => {
  const src = (n: number) => ({ title: `S${n}`, url: `https://s${n}.example/page` });
  const saved = (count: number) => Array.from({ length: count }, (_, i) => src(100 + i));
  /** Ответ перегенерации `context`: абзац i держится на источнике i, все страницы про книгу. */
  const answer = (sources: Array<{ title: string; url: string }>) =>
    draft(
      {
        context: sources.map((_, i) => `Paragraph ${i}.`).join('\n\n'),
        sources,
      } as unknown as StepDraft['blocks'],
      refs({ context: sources.map((_, i) => [i]) }),
    );
  const verify = (d: StepDraft, stored: Array<{ title: string; url: string }>) => {
    const checks = (d.blocks.sources ?? []).map(() => page(ABOUT));
    const first = verifyExternal(d, checks, TITLES, AUTHORS);
    const limited = overLimit(d, first, stored);
    return { limited, verdict: verifyExternal(d, checks, TITLES, AUTHORS, limited) };
  };

  it('13 saved + 3 new: the third new source does not fit, its statement is dropped with LIMIT_OUT, the rest is kept', () => {
    const { limited, verdict } = verify(answer([src(1), src(2), src(3)]), saved(13));
    expect([...limited]).toEqual([2]);
    expect(verdict.draft.blocks.context).toBe('Paragraph 0.\n\nParagraph 1.');
    expect(verdict.draft.blocks.sources).toEqual([src(1), src(2)]);
    expect(verdict.fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'LIMIT_OUT', path: 'sources.2' }),
        expect.objectContaining({ code: 'LIMIT_OUT', path: 'context.2' }),
      ]),
    );
    // Не влезший источник - не отказ источника: в отброшенных его нет.
    expect(verdict.droppedSources).toEqual([]);
  });

  it('15 saved + new ones: nothing new fits, the block is unverified as a whole', () => {
    const { verdict } = verify(answer([src(1), src(2)]), saved(15));
    expect(verdict.draft.blocks).toEqual({});
    expect(verdict.unverified).toContain('context');
  });

  it('a source whose address is already saved takes no room, in any form of the address', () => {
    const stored = saved(15);
    const same = { title: 'Again', url: 'http://S100.example/page/' };
    const { limited, verdict } = verify(answer([same]), stored);
    expect(limited.size).toBe(0);
    expect(verdict.draft.blocks.context).toBe('Paragraph 0.');
  });

  it('one new address twice in the answer takes one place', () => {
    const twice = [src(1), { title: 'Again', url: 'https://s1.example/page/' }, src(2)];
    const { limited } = verify(answer(twice), saved(14));
    // Места одно: s1 влез (оба его вхождения), s2 - нет.
    expect([...limited]).toEqual([2]);
  });
});
