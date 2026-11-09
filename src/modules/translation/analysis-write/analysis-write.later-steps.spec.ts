import { Language } from '@prisma/client';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { TEST_TLS_CERT, TEST_TLS_KEY } from '../../../common/testing/source-fetch-tls-spec';
import { EMPTY_BOOK_ANALYSIS } from '../../book-analysis/book-analysis-data';
import { SourceFetcherService } from '../../source-fetch/source-fetcher.service';
import { indexChapters } from '../draft-quality/quote-check';
import { emptyAnalysisData, STEP_TARGETS } from './analysis-write.data';
import { doneRecord, openSources, withStep } from './analysis-write.handler';
import { verifyExternal } from './analysis-write.external';
import {
  bookFor,
  exampleSlice,
  fitStepInput,
  readStepAnswer,
  referencedChapters,
  StepContext,
  stepInput,
} from './analysis-write.steps';

/**
 * Шаги 4-5 хода анализа (`F07-2a`): ответ в блоки, ссылки на источники, вход шага, итог шага с
 * проверкой источников и флагом `EXTERNAL_CHECK`.
 */

const context = (merged: StepContext['merged'] = {}): StepContext => ({
  language: 'en',
  dossier: { chapters: [{ number: 1, title: 'C1', summary: 'S1.' }] },
  glossary: null,
  bookTitle: 'Book',
  author: 'Ann Author',
  stored: EMPTY_BOOK_ANALYSIS,
  merged,
  chapters: [{ number: 1, title: 'C1', content: '<p>Line 1.</p>' }],
  otherKeys: '',
});
const targets = {
  characterKeys: new Set<string>(),
  quoteIds: new Set<string>(),
  storedThemeKeys: new Set<string>(),
};
const chapters = indexChapters(new Map([[1, 'Line 1.']]));
const textOf = (messages: Array<{ content: string }>) => messages.map((m) => m.content).join('\n');

describe('step 4: the blocks for the reader', () => {
  it('empty elements are not elements; the order and the texts are kept', () => {
    const draft = readStepAnswer(
      4,
      {
        misreadings: [
          { myth: ' Myth ', explanation: 'Why not.' },
          { myth: '', explanation: 'no myth' },
        ],
        discussionQuestions: ['Q1?', '  ', 'Q2?'],
        faq: [
          { question: 'What?', answer: 'This.' },
          { question: 'No answer', answer: '' },
        ],
      },
      chapters,
      targets,
    );
    expect(draft.blocks).toEqual({
      misreadings: [{ myth: 'Myth', explanation: 'Why not.' }],
      discussionQuestions: ['Q1?', 'Q2?'],
      faq: [{ question: 'What?', answer: 'This.' }],
    });
    expect(draft.refs).toBeNull();
  });

  it('a list over the import limit is cut with LIMIT_OUT', () => {
    const draft = readStepAnswer(
      4,
      { discussionQuestions: Array.from({ length: 14 }, (_, i) => `Q${i}?`) },
      chapters,
      targets,
    );
    expect(draft.blocks.discussionQuestions).toHaveLength(12);
    expect(draft.fixes).toEqual([
      expect.objectContaining({ code: 'LIMIT_OUT', path: 'discussionQuestions' }),
    ]);
  });

  it('the input has the chapter summaries and the earlier steps, no book text', () => {
    const input = stepInput(4, context({ mainIdea: 'Idea.' }), bookFor(4, context()), chapters);
    const text = textOf(input.author(null).messages);
    expect(text).toContain('MAIN_IDEA');
    expect(text).toContain('Idea.');
    expect(text).toContain('S1.');
    expect(text).not.toContain('Line 1.');
  });

  it('step 4 writes only its own blocks: nothing of the core (mainIdea, themes, characters, keyQuotes)', () => {
    expect(STEP_TARGETS[4]).toEqual(['misreadings', 'discussionQuestions', 'faq']);
  });

  it('no chapters are referenced: steps 4-5 read no text of the version', () => {
    const merged = {
      characters: [
        { key: 'a', name: 'A', role: 'main' as const, quote: { text: 'Line 1.', chapter: 1 } },
      ],
    };
    expect(referencedChapters(4, context(merged))).toEqual([]);
    expect(referencedChapters(5, context(merged))).toEqual([]);
  });
});

describe('step 5: the external blocks and the refs of the statements', () => {
  const answer = {
    genre: 'a novel',
    genreRefs: [0],
    movement: '',
    movementRefs: [1],
    writtenYears: '1865',
    writtenYearsRefs: [],
    context: [
      { text: 'Epoch.', refs: [0] },
      { text: '  ', refs: [1] },
      { text: 'Work.', refs: [1] },
    ],
    timeline: [
      { year: '1866', event: 'Published', kind: 'book', refs: [0] },
      { year: '', event: 'no year', kind: 'book', refs: [0] },
    ],
    reception: [{ text: 'Praised.', refs: [0, 1] }],
    adaptations: [
      { title: 'Film', year: 1970, kind: 'film', differences: 'Shorter.', refs: [1] },
      { title: 'Show', year: 0, kind: 'series', differences: '', refs: [0] },
      { title: 'Old', year: 1500, kind: 'stage', differences: '', refs: [0] },
    ],
    sources: [
      { title: 'One', url: 'https://a.example/1' },
      { title: 'Two', url: 'https://b.example/2' },
    ],
  };

  it('blocks are built, empty values are not blocks, the refs follow the elements', () => {
    const draft = readStepAnswer(5, answer, chapters, targets);
    expect(draft.blocks.facts).toEqual({ genre: 'a novel', writtenYears: '1865' });
    expect(draft.blocks.context).toBe('Epoch.\n\nWork.');
    expect(draft.blocks.timeline).toEqual([{ year: '1866', event: 'Published', kind: 'book' }]);
    expect(draft.blocks.adaptations?.map((a) => [a.title, a.year])).toEqual([['Film', 1970]]);
    expect(draft.refs).toEqual({
      facts: { genre: [0], writtenYears: [] },
      context: [[0], [1]],
      reception: [[0, 1]],
      timeline: [[0]],
      adaptations: [[1]],
    });
  });

  it('an empty source does not shift the refs of the statements: they keep pointing at the same source', () => {
    const draft = readStepAnswer(
      5,
      {
        context: [{ text: 'Epoch.', refs: [2] }],
        sources: [
          { title: 'A', url: 'https://a.example/' },
          { title: '', url: 'https://empty.example/' },
          { title: 'C', url: 'https://c.example/' },
        ],
      },
      chapters,
      targets,
    );
    expect(draft.blocks.sources?.map((s) => s.title)).toEqual(['A', 'C']);
    expect(draft.refs?.context).toEqual([[1]]);
    const toEmpty = readStepAnswer(
      5,
      {
        context: [{ text: 'Epoch.', refs: [1] }],
        sources: [
          { title: 'A', url: 'https://a.example/' },
          { title: '', url: 'x' },
        ],
      },
      chapters,
      targets,
    );
    expect(toEmpty.refs?.context).toEqual([[]]);
  });

  it('an empty line inside one paragraph of the answer makes two paragraphs with the same refs', () => {
    const draft = readStepAnswer(
      5,
      {
        context: [
          { text: 'A.\n\nB.', refs: [0] },
          { text: 'C.', refs: [1] },
        ],
        sources: [],
      },
      chapters,
      targets,
    );
    expect(draft.blocks.context).toBe('A.\n\nB.\n\nC.');
    expect(draft.refs?.context).toEqual([[], [], []]);
    const both = readStepAnswer(
      5,
      {
        context: [
          { text: 'A.\n\nB.', refs: [0] },
          { text: 'C.', refs: [1] },
        ],
        sources: [
          { title: 'S0', url: 'https://a.example/' },
          { title: 'S1', url: 'https://b.example/' },
        ],
      },
      chapters,
      targets,
    );
    expect(both.refs?.context).toEqual([[0], [0], [1]]);
  });

  it('an adaptation without a sure year is not written (the canon: not sure of the year - leave it out)', () => {
    const draft = readStepAnswer(
      5,
      {
        adaptations: [
          { title: 'Sure', year: 1970, kind: 'film', differences: '', refs: [0] },
          { title: 'Unsure', year: 0, kind: 'film', differences: '', refs: [0] },
        ],
        sources: [{ title: 'S', url: 'https://a.example/' }],
      },
      chapters,
      targets,
    );
    expect(draft.blocks.adaptations?.map((a) => a.title)).toEqual(['Sure']);
    expect(draft.refs?.adaptations).toEqual([[0]]);
  });

  it('an over-limit timeline is cut together with its refs', () => {
    const timeline = Array.from({ length: 22 }, (_, i) => ({
      year: `${1800 + i}`,
      event: `E${i}`,
      kind: 'epoch',
      refs: [i % 2],
    }));
    const draft = readStepAnswer(5, { ...answer, timeline }, chapters, targets);
    expect(draft.blocks.timeline).toHaveLength(20);
    expect(draft.refs?.timeline).toHaveLength(20);
    expect(draft.fixes).toEqual([expect.objectContaining({ code: 'LIMIT_OUT', path: 'timeline' })]);
  });

  it('the prompt has no book text and no quotations rule: the title, the author and the step 3 only', () => {
    const ctx = context({ mainIdea: 'Idea.', themes: [{ key: 'guilt', title: 'Guilt' }] });
    const input = stepInput(5, ctx, bookFor(5, ctx), chapters);
    const text = textOf(input.author(null).messages);
    expect(text).toContain('Idea.');
    expect(text).toContain('guilt');
    expect(text).not.toContain('BOOK_TEXT');
    expect(text).not.toContain('Line 1.');
    expect(text).toContain('No quotations of the book');
    // Вход по `tech.md` §2: ни досье, ни глоссария, ни ключей, ни списка глав; язык оригинала - есть.
    for (const fence of ['DOSSIER', 'GLOSSARY', 'KEYS', 'CHAPTERS_LIST', 'S1.']) {
      expect(text).not.toContain(fence);
    }
    const withOriginal = stepInput(
      5,
      { ...ctx, originalLanguage: 'Russian' },
      bookFor(5, ctx),
      chapters,
    );
    expect(textOf(withOriginal.author(null).messages)).toContain('Russian');
  });

  it('the quality bar of step 5 rests on a source, not on a quotation with its chapter; the reviewer gets the same', () => {
    const ctx = context({ mainIdea: 'Idea.' });
    const input = stepInput(5, ctx, bookFor(5, ctx), chapters);
    expect(textOf(input.author(null).messages)).not.toContain('a quotation with its chapter');
    expect(textOf(input.author(null).messages)).not.toContain('every quotation is a line');
    expect(
      textOf(input.review({ blocks: {}, themeLinks: null, droppedQuotes: [], fixes: [] }).messages),
    ).not.toContain('a quotation with its chapter');
  });

  it('step 4 sees the whole result of steps 1-3: quotations, symbols, the meaning of the title and of the ending', () => {
    const ctx = context({
      keyQuotes: [{ text: 'Line 1.', chapter: 1, interpretation: 'Q-int.' }],
      symbols: [{ title: 'Bell', interpretation: 'S-int.' }],
      titleMeaning: 'T-mean.',
      endingMeaning: 'E-mean.',
    });
    const text = textOf(stepInput(4, ctx, bookFor(4, ctx), chapters).author(null).messages);
    for (const part of ['Q-int.', 'Bell', 'T-mean.', 'E-mean.']) expect(text).toContain(part);
  });

  it('the reviewer of step 5 is not told to compare with the book and has no NOT_IN_TEXT; other steps keep both', () => {
    const empty = { blocks: {}, themeLinks: null, droppedQuotes: [], fixes: [] };
    const five = textOf(
      stepInput(5, context(), bookFor(5, context()), chapters).review(empty).messages,
    );
    expect(five).not.toContain('Compare the answer with the book');
    // Код в перечне формы ответа остаётся общим; снято его описание - проверяющей он не предложен.
    expect(five).not.toContain('NOT_IN_TEXT: an interpretation');
    const three = textOf(
      stepInput(3, context(), bookFor(3, context()), chapters).review(empty).messages,
    );
    expect(three).toContain('Compare the answer with the book');
    expect(three).toContain('NOT_IN_TEXT: an interpretation');
    // F07-5: проверяющая сверяет каждую деталь сюжета и границу глав (краткие содержания - тоже
    // главы); кавычки сверяет код - у проверяющей «do not remark» на все цитаты. У шага 5 - нет.
    expect(three).toContain('Check every plot detail');
    expect(three).toContain('after the last chapter of the book given (chapter summaries count)');
    expect(three).toContain('whether quotations are word for word');
    expect(three).not.toContain('are yours to check');
    expect(five).not.toContain('Check every plot detail');
    for (const step of [1, 2, 4] as const) {
      const review = textOf(
        stepInput(step, context(), bookFor(step, context()), chapters).review(empty).messages,
      );
      expect(review).toContain('Check every plot detail');
      expect(review).toContain('whether quotations are word for word');
    }
  });

  it('the redo of step 5 shows the previous answer in the answer form, with the refs of every statement', () => {
    const previous = readStepAnswer(
      5,
      {
        genre: 'novel',
        genreRefs: [0],
        context: [
          { text: 'A.', refs: [0] },
          { text: 'B.', refs: [1] },
        ],
        sources: [
          { title: 'S0', url: 'https://a.example/' },
          { title: 'S1', url: 'https://b.example/' },
        ],
      },
      chapters,
      targets,
    );
    const text = textOf(
      stepInput(5, context(), bookFor(5, context()), chapters).author({
        previous,
        remarks: [],
      } as never).messages,
    );
    expect(text).toContain('"genreRefs":[0]');
    expect(text).toContain('{"text":"B.","refs":[1]}');
  });

  it('a prompt of another step keeps the rules about quotations', () => {
    const input = stepInput(2, context(), bookFor(2, context()), chapters);
    expect(textOf(input.author(null).messages)).toContain('word for word');
  });
});

describe('openSources: one retry on a passing failure or a refusal of the site, never on a failure of the address', () => {
  const page = (over: object) => ({
    ok: false,
    host: 'h',
    status: null,
    reason: null,
    text: '',
    ...over,
  });
  const draftOf = (n: number) =>
    ({
      blocks: {
        sources: Array.from({ length: n }, (_, i) => ({
          title: `S${i}`,
          url: `https://s${i}.example/`,
        })),
      },
      themeLinks: null,
      droppedQuotes: [],
      fixes: [],
    }) as never;

  it('a 503 and a timeout are asked once more, a 404 and an unknown name are not; the second answer lands at its place', async () => {
    const fetchMany = jest
      .fn()
      .mockResolvedValueOnce([
        page({ reason: 'HTTP_STATUS', status: 503 }),
        page({ reason: 'HTTP_STATUS', status: 404 }),
        page({ reason: 'TIMEOUT' }),
        page({ reason: 'NAME_UNKNOWN' }),
      ])
      .mockResolvedValueOnce([
        page({ ok: true, host: 'a', text: 'Book' }),
        page({ reason: 'TIMEOUT' }),
      ]);
    const checks = await openSources({ fetchMany }, draftOf(4));
    expect(fetchMany).toHaveBeenCalledTimes(2);
    expect(fetchMany.mock.calls[1][0]).toEqual(['https://s0.example/', 'https://s2.example/']);
    // Канал - только NETWORK: таймаут медленного сайта - отказ адреса, не повод для паузы.
    expect(checks.map((c) => [c.opened, c.transport])).toEqual([
      [true, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
  });

  it('the channel is NETWORK only: a refused or reset connection of the site is the address, it is retried and is not transport', async () => {
    const fetchMany = jest
      .fn()
      .mockResolvedValueOnce([page({ reason: 'NETWORK' }), page({ reason: 'CONNECTION' })])
      .mockResolvedValueOnce([page({ reason: 'NETWORK' }), page({ reason: 'CONNECTION' })]);
    const checks = await openSources({ fetchMany }, draftOf(2));
    expect(fetchMany).toHaveBeenCalledTimes(2);
    expect(checks.map((c) => c.transport)).toEqual([true, false]);
  });

  it('one pause per step, however many addresses were refused and whatever else failed', async () => {
    const fetchMany = jest
      .fn()
      .mockResolvedValueOnce([
        page({ reason: 'HTTP_STATUS', status: 403 }),
        page({ reason: 'HTTP_STATUS', status: 503 }),
        page({ reason: 'HTTP_STATUS', status: 429 }),
      ])
      .mockResolvedValueOnce([page({ ok: true }), page({ ok: true }), page({ ok: true })]);
    const pause = jest.fn().mockResolvedValue(undefined);
    await openSources({ fetchMany }, draftOf(3), pause);
    expect(pause.mock.calls).toEqual([[2000]]);
    expect(fetchMany).toHaveBeenCalledTimes(2);
    expect(fetchMany.mock.calls[1][0]).toHaveLength(3);
  });

  it('the pause of the running code is real: the retry waits two seconds', async () => {
    jest.useFakeTimers();
    try {
      const fetchMany = jest
        .fn()
        .mockResolvedValueOnce([page({ reason: 'HTTP_STATUS', status: 403 })])
        .mockResolvedValueOnce([page({ ok: true })]);
      const run = openSources({ fetchMany }, draftOf(1));
      await jest.advanceTimersByTimeAsync(1999);
      expect(fetchMany).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await run;
      expect(fetchMany).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('nothing to retry - one request per address', async () => {
    const fetchMany = jest.fn().mockResolvedValue([page({ ok: true, text: 'Book' })]);
    await openSources({ fetchMany }, draftOf(1));
    expect(fetchMany).toHaveBeenCalledTimes(1);
  });
});

describe('openSources: a passing 403 of the site (LEGACY-492), real fetcher against a local server', () => {
  let server: https.Server;
  let port: number;
  let answers: number[];
  let seen: IncomingMessage[];

  beforeAll(async () => {
    const respond = (req: IncomingMessage, res: ServerResponse) => {
      seen.push(req);
      res.writeHead(answers.shift() ?? 500, { 'content-type': 'text/plain' });
      res.end('Book');
    };
    server = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, respond);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen = [];
  });

  const fetcher = () =>
    new SourceFetcherService({
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      requestOptions: { ca: TEST_TLS_CERT },
      allowPort: port,
      allowBlockedAddresses: ['source.test'],
      timeoutMs: 5000,
    });
  const draft = () =>
    ({
      blocks: { sources: [{ title: 'S', url: `https://source.test:${port}/page` }] },
      themeLinks: null,
      droppedQuotes: [],
      fixes: [],
    }) as never;

  it.each([
    ['403 then 200: the source is kept', [403, 200], 2, true, [2000]],
    ['429 then 200: the source is kept', [429, 200], 2, true, [2000]],
    ['403 twice: refused after one retry', [403, 403], 2, false, [2000]],
    ['404: an address refusal is not retried', [404], 1, false, []],
    ['503 then 200: retried without the pause', [503, 200], 2, true, []],
  ])('%s', async (_name, statuses, requests, opened, pauses) => {
    answers = [...statuses];
    const pause = jest.fn().mockResolvedValue(undefined);
    const [check] = await openSources(fetcher(), draft(), pause);
    expect(seen).toHaveLength(requests);
    expect(check.opened).toBe(opened);
    // Ответ сайта - отказ адреса, а не канала: шаг из-за него на паузу не встаёт.
    expect(check.transport).toBe(false);
    expect(pause.mock.calls.map(([ms]) => ms as number)).toEqual(pauses);
  });
});

describe('the input of steps 4-5 fits or the step is DRAFT_TOO_LONG', () => {
  it('fits: the summaries (step 4) or no book (step 5); does not fit: null', async () => {
    const yes = () => Promise.resolve(true);
    const no = () => Promise.resolve(false);
    expect(await fitStepInput(4, context(), chapters, yes)).toMatchObject({ source: 'summaries' });
    expect(await fitStepInput(5, context(), chapters, yes)).toMatchObject({ source: 'none' });
    expect(await fitStepInput(4, context(), chapters, no)).toBeNull();
    expect(await fitStepInput(5, context(), chapters, no)).toBeNull();
  });
});

describe('the sample of steps 4-5 in every language', () => {
  it.each(['en', 'ru', 'fr', 'es', 'pt'] as Language[])(
    '%s: the blocks of the step only',
    (language) => {
      const four = JSON.parse(exampleSlice(4, language)) as Record<string, unknown>;
      expect(Object.keys(four).sort()).toEqual(['discussionQuestions', 'faq', 'misreadings']);
      const five = JSON.parse(exampleSlice(5, language)) as Record<string, unknown>;
      expect(Object.keys(five).sort()).toEqual([
        'adaptations',
        'context',
        'genre',
        'genreRefs',
        'movement',
        'movementRefs',
        'reception',
        'sources',
        'timeline',
        'writtenYears',
        'writtenYearsRefs',
      ]);
      // Форма ответа шага, а не импорта: абзацы со ссылками, адреса - заглушки, не реальные.
      expect(Array.isArray(five.context)).toBe(true);
      for (const source of five.sources as Array<{ url: string }>) {
        expect(source.url).toMatch(/^https:\/\/encyclopedia\.example\//);
      }
    },
  );
});

describe('the result of step 5: the flag, the dropped sources, the sources that were not verified', () => {
  const sources = [
    { title: 'One', url: 'https://a.example/1' },
    { title: 'Two', url: 'https://b.example/2' },
  ];
  const loop = (blocks: object, refs: object) => ({
    ok: true as const,
    draft: { blocks, themeLinks: null, refs, droppedQuotes: [], fixes: [] },
    remarks: [],
    verdict: 'ok' as const,
    attempt: 1 as const,
    authorModel: 'm',
    review: { kind: 'answered' as const, model: 'r' },
  });
  const emptyRefs = { facts: {}, context: [], reception: [], timeline: [], adaptations: [] };
  const about = (host: string) => ({ host, opened: true, text: 'Book by Ann Author' });

  it('every written external unit carries EXTERNAL_CHECK, so the verdict is flags, not ok', () => {
    const result = loop(
      { facts: { genre: 'novel' }, context: 'Epoch.', sources: [sources[0]] },
      { ...emptyRefs, facts: { genre: [0] }, context: [[0]] },
    );
    const verdict = verifyExternal(
      result.draft as never,
      [about('a.example')],
      ['Book'],
      ['Ann Author'],
    );
    const record = doneRecord(5, { ...result, draft: verdict.draft } as never, 'none', verdict);
    // Ответ без замечаний проверяющей - всё равно `flags`: внешнее сверяет человек.
    expect(record.step.verdict).toBe('flags');
    expect(record.step.remarks.map((r) => [r.code, r.where])).toEqual([
      ['EXTERNAL_CHECK', 'facts.genre'],
      ['EXTERNAL_CHECK', 'context'],
      ['EXTERNAL_CHECK', 'sources'],
    ]);
    const data = withStep(emptyAnalysisData({}, {}), record);
    expect(data.items.map((i) => [i.target, i.verdict, i.outcome])).toEqual([
      ['facts.genre', 'flags', 'waiting'],
      ['context', 'flags', 'waiting'],
      ['sources', 'flags', 'waiting'],
    ]);
    expect(data.merged.sources).toEqual([sources[0]]);
  });

  it('the step dropped everything and the reviewer said ok: the verdict is flags, not ok', () => {
    const result = loop(
      { context: 'Epoch.', sources: [sources[0]] },
      { ...emptyRefs, context: [[0]] },
    );
    const verdict = verifyExternal(
      result.draft as never,
      [{ host: 'a.example', opened: false, text: '' }],
      ['Book'],
      ['Ann Author'],
    );
    const record = doneRecord(5, { ...result, draft: verdict.draft } as never, 'none', verdict);
    expect(record.step.verdict).toBe('flags');
  });

  it('a source that did not open: the block is not written, the item says why, the source is in droppedSources', () => {
    const result = loop(
      { context: 'Epoch.', sources: [sources[0]] },
      { ...emptyRefs, context: [[0]] },
    );
    const verdict = verifyExternal(
      result.draft as never,
      [{ host: 'a.example', opened: false, text: '' }],
      ['Book'],
      ['Ann Author'],
    );
    const record = doneRecord(5, { ...result, draft: verdict.draft } as never, 'none', verdict);
    const data = withStep(emptyAnalysisData({}, {}), record);
    expect(data.items.filter((i) => i.outcome === 'waiting')).toEqual([]);
    expect(data.items.map((i) => [i.target, i.outcome, i.failedReason])).toEqual([
      ['context', 'none', 'EXTERNAL_UNVERIFIED'],
      ['sources', 'none', 'EXTERNAL_UNVERIFIED'],
    ]);
    expect(data.droppedSources).toEqual([
      { title: 'One', host: 'a.example', reason: 'SOURCE_UNREACHABLE' },
    ]);
    expect(data.merged).toEqual({});
  });

  it('step 5 targets are exactly the external blocks', () => {
    expect(STEP_TARGETS[5]).toEqual([
      'facts.genre',
      'facts.movement',
      'facts.writtenYears',
      'context',
      'timeline',
      'reception',
      'adaptations',
      'sources',
    ]);
  });
});
