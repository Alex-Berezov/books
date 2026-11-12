import { EMPTY_BOOK_ANALYSIS } from '../../book-analysis/book-analysis-data';
import { stableJson } from '../draft-quality/draft-record';
import {
  analysisDataJson,
  AnalysisItem,
  AnalysisTarget,
  AnalysisWriteData,
  blockPrint,
  emptyAnalysisData,
  pathInTarget,
  readAnalysisData,
  regenBase,
  RegenResult,
  targetValue,
  withoutRegen,
  withRegenerated,
  withRegenTaken,
  sourceKey,
  withSources,
  withRegenDropped,
} from './analysis-write.data';

/**
 * Данные хода анализа (`tech.md` §5): отпечаток блока не зависит от порядка ключей jsonb (Л2),
 * чтение проверяет форму, элемент не той формы пишется назад как был.
 */
describe('analysis run data', () => {
  it('the print of a block does not depend on the key order (jsonb reorders keys, Л2)', () => {
    const a = [{ key: 'anna', name: 'Anna', arc: { from: 'x', to: 'y' } }];
    const b = [{ arc: { to: 'y', from: 'x' }, name: 'Anna', key: 'anna' }];
    expect(stableJson(a)).toBe(stableJson(b));
    expect(blockPrint(a)).toBe(blockPrint(b));
    expect(blockPrint(a)).not.toBe(blockPrint([{ ...a[0], name: 'Anne' }]));
    expect(blockPrint(null)).toBe(blockPrint(undefined));
  });

  it('a facts subfield is its own unit: the value of the subfield, not of the block', () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, facts: { settingPlace: 'Town', genre: 'novel' } };
    expect(targetValue(stored, 'facts.settingPlace')).toBe('Town');
    expect(targetValue(stored, 'facts.narrator')).toBeNull();
    expect(targetValue(stored, 'characters')).toBeNull();
  });

  it('reads its own form back; a broken item stays in place and goes back as it was', () => {
    const data = emptyAnalysisData({ characters: true }, { characters: blockPrint(null) });
    const json = analysisDataJson({
      ...data,
      steps: [
        {
          step: 1,
          verdict: 'ok',
          remarks: [{ code: 'NOT_IN_TEXT', where: 'characters.anna', note: 'n', by: 'model' }],
          attempt: 1,
          outcome: 'done',
          failedReason: null,
          authorModel: 'z-ai/glm-5.3',
          review: { kind: 'answered', model: 'openai/gpt-6-luna' },
          source: 'text',
          dropped: [{ code: 'LIMIT_OUT', path: 'characters', note: 'cut' }],
        },
      ],
      items: [
        {
          target: 'characters',
          step: 1,
          verdict: 'ok',
          remarks: [],
          review: null,
          outcome: 'written',
          hash: null,
          value: [{ key: 'anna' }],
          failedReason: null,
          links: false,
          regen: null,
          regenFailedReason: null,
        },
      ],
      themeLinks: { characters: { anna: ['loss'] }, keyQuotes: {} },
      droppedQuotes: [{ step: 2, path: 'keyQuotes.0', text: 't', chapter: 1, reason: 'NOT_FOUND' }],
    });
    const raw = JSON.parse(JSON.stringify(json)) as { items: unknown[] };
    raw.items.push({ target: 'nope' });
    const read = readAnalysisData(raw);
    expect(read.steps[0]).toMatchObject({
      step: 1,
      source: 'text',
      dropped: [{ code: 'LIMIT_OUT' }],
    });
    expect(read.items[0]).toMatchObject({ target: 'characters', outcome: 'written' });
    expect(read.items[1]).toMatchObject({ outcome: 'none', failedReason: 'DRAFT_DATA_INVALID' });
    expect(read.owns).toEqual({ characters: true });
    expect(read.themeLinks).toEqual({ characters: { anna: ['loss'] }, keyQuotes: {} });
    expect(read.droppedQuotes).toHaveLength(1);
    expect((analysisDataJson(read) as { items: unknown[] }).items[1]).toEqual({ target: 'nope' });
  });

  it('a broken step record is not dropped silently: stepsBroken, the next step number is not guessed', () => {
    const good = {
      step: 1,
      verdict: 'ok',
      remarks: [],
      attempt: 1,
      outcome: 'done',
      dropped: [],
    };
    expect(readAnalysisData({ steps: [good] }).stepsBroken).toBe(false);
    expect(readAnalysisData({ steps: [good, { step: 2 }] }).stepsBroken).toBe(true);
    expect(readAnalysisData({ steps: [{ ...good, step: 2 }] }).stepsBroken).toBe(true);
    expect(readAnalysisData({ steps: 'x' }).stepsBroken).toBe(true);
    expect('stepsBroken' in (analysisDataJson(readAnalysisData({})) as object)).toBe(false);
  });

  it('not its form at all - an empty run without rights on blocks', () => {
    // Нет поля `stepsTotal` - ход `F07-1`, три шага (`F07-2a`).
    expect(readAnalysisData('x')).toEqual({ ...emptyAnalysisData({}, {}), stepsTotal: 3 });
  });
});

describe('pathInTarget (F07-1b, blocker 4)', () => {
  it('a path belongs to its unit of write on a segment border only', () => {
    expect(pathInTarget('facts.settingTime', 'facts.settingTime')).toBe(true);
    expect(pathInTarget('keyQuotes.2', 'keyQuotes')).toBe(true);
    expect(pathInTarget('characters[key=anna].name', 'characters')).toBe(true);
    expect(pathInTarget('characters: unknown key', 'characters')).toBe(true);
    // Префикс без границы сегмента - чужое поле.
    expect(pathInTarget('facts.settingTime', 'facts.setting' as AnalysisTarget)).toBe(false);
    expect(pathInTarget('keyQuotesExtra.0', 'keyQuotes')).toBe(false);
    expect(pathInTarget('facts.settingPlace', 'facts.settingTime')).toBe(false);
    // Путь всего `facts` - и каждого подполя: одно правило у ответа перегенерации и у выбросов хода.
    expect(pathInTarget('facts', 'facts.settingTime')).toBe(true);
    expect(pathInTarget('facts', 'characters')).toBe(false);
  });
});

describe('the result of a regeneration in the data of the run (F07-1b, /fix 1 blockers 2, 3, 5, 9; /fix 2 blocker 4)', () => {
  const item = (patch: Partial<AnalysisItem> = {}): AnalysisItem => ({
    target: 'characters',
    step: 1,
    verdict: 'ok',
    remarks: [],
    review: null,
    outcome: 'written',
    hash: null,
    value: [{ key: 'old' }],
    failedReason: null,
    links: false,
    regen: { operationId: 'op2', remark: null, pending: null, previous: null },
    regenFailedReason: null,
    ...patch,
  });
  const result = (patch: Partial<RegenResult> = {}): RegenResult => ({
    value: [{ key: 'new' }],
    verdict: 'ok',
    remarks: [],
    review: { kind: 'answered', model: 'r' },
    droppedQuotes: [],
    ...patch,
  });
  const data = (items: AnalysisItem[]): AnalysisWriteData => ({
    ...emptyAnalysisData({}, {}),
    steps: [],
    items,
    merged: { characters: [{ key: 'old' }] as never, keyQuotes: [] },
    droppedQuotes: [
      { step: 1, path: 'characters.0.quote', text: 'old drop', chapter: 1, reason: 'NOT_FOUND' },
      { step: 1, path: 'facts.settingTime', text: 'neighbour', chapter: 1, reason: 'NOT_FOUND' },
    ],
  });

  it('a block in the analysis is regenerated from the saved content (keys of the editor); a proposal - from the content of the run', () => {
    const stored = {
      ...EMPTY_BOOK_ANALYSIS,
      characters: [{ key: 'saved', name: 'S', role: 'main' as const }],
    };
    for (const outcome of ['written', 'accepted'] as const) {
      expect(regenBase(item({ outcome }), stored)).toEqual(stored.characters);
    }
    expect(regenBase(item({ outcome: 'proposed' }), stored)).toEqual([{ key: 'old' }]);
    expect(regenBase(item({ outcome: 'none', value: null }), stored)).toEqual(stored.characters);
  });

  it('the waiting result changes neither merged nor the dropped quotations nor the record of the step; the block before it is kept', () => {
    const before = data([item()]);
    const drop = {
      step: 1 as const,
      path: 'characters.1.quote',
      text: 'new drop',
      chapter: 2,
      reason: 'NOT_FOUND' as const,
    };
    const waiting = withRegenerated(before, 0, result({ droppedQuotes: [drop] }));
    expect(waiting.merged).toBe(before.merged);
    expect(waiting.droppedQuotes).toBe(before.droppedQuotes);
    expect(waiting.steps).toBe(before.steps);
    expect(waiting.items[0]).toMatchObject({
      outcome: 'waiting',
      value: [{ key: 'new' }],
      pendingDropped: [drop],
    });
    expect(waiting.items[0].regen?.previous).toMatchObject({
      outcome: 'written',
      value: [{ key: 'old' }],
      regen: null,
    });
  });

  it('a cancel or a failure before the decision rolls the block back; merged and the dropped quotations stay as before', () => {
    const before = data([item()]);
    const rolledBack = withoutRegen(withRegenerated(before, 0, result()), 0, null);
    expect(rolledBack.items[0]).toMatchObject({
      outcome: 'written',
      value: [{ key: 'old' }],
      regen: null,
    });
    expect(rolledBack.items[0].pendingDropped ?? null).toBeNull();
    expect(rolledBack.merged).toEqual(before.merged);
    expect(rolledBack.droppedQuotes).toEqual(before.droppedQuotes);
    const settled = withoutRegen(
      { ...before, items: [{ ...item(), outcome: 'proposed', value: [{ key: 'new' }] }] },
      0,
      'DRAFT_TOO_LONG',
    );
    expect(settled.items[0]).toMatchObject({
      outcome: 'proposed',
      regen: null,
      regenFailedReason: 'DRAFT_TOO_LONG',
    });
  });

  it('taken into the analysis (written or accepted): the block goes into merged, the dropped quotations of this unit are replaced, not those of a neighbour subfield', () => {
    const drop = {
      step: 1 as const,
      path: 'facts.settingPlace',
      text: 'new drop',
      chapter: 2,
      reason: 'NOT_FOUND' as const,
    };
    const facts = item({ target: 'facts.settingPlace', value: 'Town' });
    const before: AnalysisWriteData = {
      ...data([facts]),
      droppedQuotes: [
        { step: 1, path: 'facts.settingPlace', text: 'own', chapter: 1, reason: 'NOT_FOUND' },
        { step: 1, path: 'facts.settingTime', text: 'neighbour', chapter: 1, reason: 'NOT_FOUND' },
      ],
    };
    const waiting = withRegenerated(
      before,
      0,
      result({ value: 'River town', droppedQuotes: [drop] }),
    );
    const taken = withRegenTaken(
      { ...waiting, items: [{ ...waiting.items[0], outcome: 'written' }] },
      0,
      'River town, as written',
    );
    // В merged - записанное значение (/fix 3, блокер 4), а не значение итога.
    expect(taken.merged.facts).toEqual({ settingPlace: 'River town, as written' });
    expect(taken.droppedQuotes.map((d) => d.text)).toEqual(['neighbour', 'new drop']);
    expect(taken.items[0].pendingDropped).toBeNull();
    // Не из перегенерации - ничего не меняется.
    expect(withRegenTaken(before, 0, 'x')).toBe(before);
  });

  it('the block before the regeneration and the pending dropped quotations survive the round trip through the stored data', () => {
    const drop = {
      step: 1 as const,
      path: 'characters.0',
      text: 'd',
      chapter: 1,
      reason: 'NOT_FOUND' as const,
    };
    const waiting = withRegenerated(data([item()]), 0, result({ droppedQuotes: [drop] }));
    const read = readAnalysisData(JSON.parse(JSON.stringify(analysisDataJson(waiting))));
    expect(read.items[0].regen?.previous).toMatchObject({
      outcome: 'written',
      value: [{ key: 'old' }],
    });
    expect(read.items[0].pendingDropped).toEqual([drop]);
  });
});

describe('the address of a source (F07-2b)', () => {
  it('one address in different forms is one source: scheme, case of the host, final slash', () => {
    expect(sourceKey('http://En.Wikipedia.org/wiki/X/')).toBe(
      sourceKey('https://en.wikipedia.org/wiki/X'),
    );
    expect(sourceKey('https://a.example/x?b=1')).not.toBe(sourceKey('https://a.example/x?b=2'));
    // `www.` - тот же сайт; другой порт - другой адрес.
    expect(sourceKey('https://www.example.com/x')).toBe(sourceKey('https://example.com/x'));
    expect(sourceKey('https://host:8443/a')).not.toBe(sourceKey('http://host/a'));
    expect(sourceKey(' not an address ')).toBe('not an address');
  });

  it('withSources keeps the saved ones and adds only new addresses', () => {
    const saved = [{ title: 'A', url: 'https://a.example/x' }];
    expect(
      withSources(saved, [
        { title: 'A again', url: 'http://A.example/x/' },
        { title: 'B', url: 'https://b.example/' },
      ]),
    ).toEqual([saved[0], { title: 'B', url: 'https://b.example/' }]);
  });
});

describe('the reasons of a regeneration in the run (F07-2b, decision F07 | F07-2b, round 4)', () => {
  const step5 = {
    step: 5 as const,
    verdict: 'flags' as const,
    remarks: [],
    attempt: 1 as const,
    outcome: 'done' as const,
    failedReason: null,
    authorModel: 'm',
    review: null,
    source: 'none' as const,
    dropped: [
      { code: 'SOURCE_UNREACHABLE' as const, path: 'sources.0', note: 'a.example did not open' },
      { code: 'SOURCE_UNVERIFIED' as const, path: 'context.1', note: 'old' },
    ],
  };
  const run = () => ({ ...emptyAnalysisData({}, {}), steps: [step5] });
  const regenFixes = [
    { code: 'SOURCE_UNREACHABLE' as const, path: 'sources.0', note: 'b.example did not open' },
    { code: 'SOURCE_UNVERIFIED' as const, path: 'context.1', note: 'new' },
  ];
  const dropped = [{ title: 'B', host: 'b.example', reason: 'SOURCE_UNREACHABLE' as const }];

  it('a source reason of the regeneration is added next to the one of the run, not over it; other reasons are replaced by code and path', () => {
    const next = withRegenDropped(run(), 5, regenFixes, dropped);
    expect(next.steps[0].dropped).toEqual([
      { code: 'SOURCE_UNREACHABLE', path: 'sources.0', note: 'a.example did not open' },
      { code: 'SOURCE_UNVERIFIED', path: 'context.1', note: 'new' },
      { code: 'SOURCE_UNREACHABLE', path: 'sources.0', note: 'b.example did not open' },
    ]);
    expect(next.droppedSources).toEqual(dropped);
  });

  it('the same regeneration again adds no duplicate reason and no duplicate dropped source', () => {
    const once = withRegenDropped(run(), 5, regenFixes, dropped);
    const twice = withRegenDropped(once, 5, regenFixes, dropped);
    // Порядок не важен (заменённая причина встаёт в конец, как у `withStepFixes`), повторов нет.
    expect(twice.steps[0].dropped).toHaveLength(once.steps[0].dropped.length);
    expect(twice.steps[0].dropped).toEqual(expect.arrayContaining(once.steps[0].dropped));
    expect(twice.droppedSources).toEqual(dropped);
  });
});
