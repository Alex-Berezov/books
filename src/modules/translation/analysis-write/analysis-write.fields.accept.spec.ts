import { BadRequestException, ConflictException } from '@nestjs/common';
import { EMPTY_BOOK_ANALYSIS, StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import type {
  BookAnalysisService,
  BookAnalysisWriteGuard,
} from '../../book-analysis/book-analysis.service';
import { BOOK_ANALYSIS_LIMITS } from '../../book-analysis/dto/book-analysis-blocks.dto';
import type { UpdateBookAnalysisDto } from '../../book-analysis/dto/update-book-analysis.dto';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  AnalysisItem,
  AnalysisTarget,
  AnalysisWriteData,
  analysisDataJson,
  blockPrint,
  emptyAnalysisData,
  readAnalysisData,
  targetValue,
  ThemeLinks,
} from './analysis-write.data';
import {
  analysisReadyGate,
  analysisRegenGate,
  AnalysisWriteFields,
  planStep,
  withThemeLinks,
} from './analysis-write.fields';
import { quotePrint } from './analysis-write.steps';

/**
 * Решения редактора по ходу `ready` (`F07-1b`; `features/F07-analysis-autofill/tech.md` §5):
 * «Accept» сверяет хэш содержимого блока на момент предложения (не `updatedAt`), вливает
 * `themeKeys` героям и цитатам (решение арбитра `F07 | F07-1a`, А3) и пишет тем же телом, что
 * импорт; «Discard» блок не трогает; перегенерация решается как шаг, с повторным вливанием связей.
 */

const ANNA = { key: 'anna', name: 'Anna', role: 'main' as const, description: 'd' };
const BORIS = { key: 'boris', name: 'Boris', role: 'secondary' as const, description: 'd' };
const QUOTE = { text: 'The bell rang.', chapter: 1, interpretation: 'i' };
const theme = (key: string) => ({ key, title: key, interpretation: 'i' });
const LINKS: ThemeLinks = {
  characters: { anna: ['loss', 'home', 'gone'], boris: ['home'] },
  keyQuotes: { [quotePrint(QUOTE.text)]: ['loss'] },
};
const ROW = { id: 'd1', bookVersionId: 'v1', language: 'en' as const };

function item(target: AnalysisTarget, patch: Partial<AnalysisItem>): AnalysisItem {
  return {
    target,
    step: target === 'keyQuotes' || target === 'style' ? 2 : 1,
    verdict: 'ok',
    remarks: [],
    review: null,
    outcome: 'proposed',
    hash: null,
    value: null,
    failedReason: null,
    links: false,
    regen: null,
    regenFailedReason: null,
    ...patch,
  };
}

/** Ход `ready` с данными и блоками версии; предложение запомнило отпечаток блока на старте. */
function runData(
  items: AnalysisItem[],
  themeLinks: ThemeLinks | null = LINKS,
  owns: AnalysisWriteData['owns'] = {},
  written: AnalysisWriteData['written'] = {},
): AnalysisWriteData {
  return { ...emptyAnalysisData(owns, written), items, themeLinks };
}

interface Db {
  row: { id: string; kind: string; status: string; operationId: string; data: unknown };
  stored: StoredBookAnalysis;
  published: boolean;
}

/**
 * Подменённая база: строка хода, анализ версии и `saveGuarded` в порядке сервиса анализа (`allow`
 * под замком → запись поверх → `done`). `onSave` - вмешательство между чтением без замка и замком.
 */
function harness(
  data: AnalysisWriteData,
  stored: StoredBookAnalysis,
  onSave: (db: Db, call: number) => void = () => undefined,
  status = 'ready',
) {
  const db: Db = {
    row: {
      id: 'd1',
      kind: 'analysis_write',
      status,
      operationId: 'op1',
      data: JSON.parse(JSON.stringify(analysisDataJson(data))) as unknown,
    },
    stored,
    published: false,
  };
  const tx = {
    $queryRaw: jest.fn(() => Promise.resolve([])),
    contentDraft: {
      findUnique: jest.fn(() => Promise.resolve({ ...db.row })),
      updateMany: jest.fn(
        (args: { where: { status?: string; operationId?: string }; data: { data: unknown } }) => {
          if (
            (args.where.status !== undefined && db.row.status !== args.where.status) ||
            (args.where.operationId !== undefined && db.row.operationId !== args.where.operationId)
          ) {
            return Promise.resolve({ count: 0 });
          }
          db.row.data = JSON.parse(JSON.stringify(args.data.data)) as unknown;
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    bookVersion: {
      findUnique: jest.fn(() => Promise.resolve({ status: db.published ? 'published' : 'draft' })),
    },
    bookAnalysis: { findUnique: jest.fn(() => Promise.resolve({ ...db.stored })) },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((cb: (client: typeof tx) => unknown) => cb(tx)),
  };
  let calls = 0;
  const written: UpdateBookAnalysisDto[] = [];
  const saveGuarded = jest.fn(
    async (_id: string, dto: UpdateBookAnalysisDto, guard: BookAnalysisWriteGuard) => {
      calls += 1;
      onSave(db, calls);
      if (!(await guard.allow(tx as never, db.stored))) return false;
      written.push(dto);
      const { language: _language, ...blocks } = dto;
      void _language;
      db.stored = { ...db.stored, ...(blocks as Partial<StoredBookAnalysis>) };
      await guard.done(tx as never, db.stored);
      return true;
    },
  );
  const fields = new AnalysisWriteFields(
    prisma as unknown as PrismaService,
    { saveGuarded } as unknown as BookAnalysisService,
  );
  const run = () => readAnalysisData(db.row.data);
  const codeOf = async (promise: Promise<unknown>) => {
    const error: unknown = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse() as Record<string, unknown>;
  };
  return { db, fields, run, saveGuarded, written, codeOf, tx };
}

const EDITED = [{ ...ANNA, description: 'edited by the editor' }];

describe('AnalysisWriteFields.accept (F07-1b)', () => {
  const proposal = (stored: StoredBookAnalysis, value: unknown = [ANNA, BORIS]) =>
    item('characters', { hash: blockPrint(targetValue(stored, 'characters')), value });

  it('the run wrote another block after the proposal: Accept succeeds, the hash is of this block only', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const h = harness(runData([proposal(stored)]), stored, (db) => {
      db.stored = { ...db.stored, style: [{ device: 'Repetition', explanation: 'x' }] };
    });
    await h.fields.accept(ROW, 0);
    expect(h.db.stored.characters).toEqual([ANNA, BORIS]);
    expect(h.db.stored.style).toHaveLength(1);
    expect(h.run().items[0].outcome).toBe('accepted');
  });

  it('the editor changed this block after the proposal: 409 ANALYSIS_BLOCK_CHANGED with the current content, nothing is written', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const h = harness(runData([proposal(stored)]), {
      ...stored,
      characters: [{ ...ANNA, description: 'edited again' }],
    });
    const body = await h.codeOf(h.fields.accept(ROW, 0));
    expect(body).toMatchObject({
      code: 'ANALYSIS_BLOCK_CHANGED',
      current: [{ ...ANNA, description: 'edited again' }],
    });
    expect(h.saveGuarded).not.toHaveBeenCalled();
    expect(h.run().items[0].outcome).toBe('proposed');
  });

  it('the editor changed this block between the read and the lock: allow refuses with 409, the block stays', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const h = harness(runData([proposal(stored)]), stored, (db) => {
      db.stored = { ...db.stored, characters: [{ ...ANNA, description: 'raced' }] };
    });
    const body = await h.codeOf(h.fields.accept(ROW, 0));
    expect(body.code).toBe('ANALYSIS_BLOCK_CHANGED');
    expect(h.db.stored.characters).toEqual([{ ...ANNA, description: 'raced' }]);
    expect(h.run().items[0].outcome).toBe('proposed');
  });

  it('a block that is not a proposal, a regenerating one and a run that is not ready are refused', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const written = harness(runData([proposal(stored)]), stored);
    written.db.row.data = analysisDataJson(
      runData([{ ...proposal(stored), outcome: 'written' }]),
    ) as unknown;
    expect((await written.codeOf(written.fields.accept(ROW, 0))).code).toBe(
      'ANALYSIS_ITEM_NOT_PROPOSED',
    );
    const regen = harness(
      runData([
        {
          ...proposal(stored),
          regen: { operationId: 'op2', remark: null, pending: null, previous: null },
        },
      ]),
      stored,
    );
    expect((await regen.codeOf(regen.fields.accept(ROW, 0))).code).toBe(
      'ANALYSIS_REGEN_IN_PROGRESS',
    );
    const building = harness(runData([proposal(stored)]), stored, undefined, 'building');
    expect((await building.codeOf(building.fields.accept(ROW, 0))).code).toBe(
      'ANALYSIS_ITEM_NOT_PROPOSED',
    );
    expect(building.saveGuarded).not.toHaveBeenCalled();
  });

  it('themeKeys of the run links are poured into the accepted characters and quotations by key and print, only the themes of the analysis', async () => {
    const stored = {
      ...EMPTY_BOOK_ANALYSIS,
      characters: EDITED,
      keyQuotes: [{ ...QUOTE, interpretation: 'edited' }],
      themes: [theme('loss'), theme('home')],
    };
    const h = harness(
      runData([
        proposal(stored),
        item('keyQuotes', {
          hash: blockPrint(targetValue(stored, 'keyQuotes')),
          value: [QUOTE],
        }),
      ]),
      stored,
    );
    await h.fields.accept(ROW, 0);
    await h.fields.accept(ROW, 1);
    // `gone` - ключа темы нет в анализе: не вливается.
    expect(h.db.stored.characters).toEqual([
      { ...ANNA, themeKeys: ['loss', 'home'] },
      { ...BORIS, themeKeys: ['home'] },
    ]);
    expect(h.db.stored.keyQuotes).toEqual([{ ...QUOTE, themeKeys: ['loss'] }]);
  });

  it('the themeKeys limit of the import is kept when the links are poured into an accepted block', async () => {
    const max = BOOK_ANALYSIS_LIMITS.themeKeys;
    const keys = Array.from({ length: max + 3 }, (_, i) => `t${i}`);
    const stored = {
      ...EMPTY_BOOK_ANALYSIS,
      characters: EDITED,
      themes: keys.map(theme),
    };
    const h = harness(
      runData([proposal(stored, [ANNA])], { characters: { anna: keys }, keyQuotes: {} }),
      stored,
    );
    await h.fields.accept(ROW, 0);
    const poured = (h.db.stored.characters ?? [])[0].themeKeys ?? [];
    expect(poured).toHaveLength(max);
    expect(poured).toEqual(keys.slice(0, max));
  });

  it('a block of links (themeKeys already merged into the saved block) is written as it is', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED, themes: [theme('loss')] };
    const value = [{ ...ANNA, description: 'edited by the editor', themeKeys: ['loss'] }];
    const h = harness(
      runData([{ ...proposal(stored, value), links: true, step: 3 }], {
        characters: { anna: ['loss', 'other'] },
        keyQuotes: {},
      }),
      stored,
    );
    await h.fields.accept(ROW, 0);
    expect(h.written[0]).toEqual({ language: 'en', characters: value });
  });

  it('a facts subfield is written into the saved facts, the other subfields stay', async () => {
    const stored = {
      ...EMPTY_BOOK_ANALYSIS,
      facts: { settingPlace: 'Saved town', narrator: 'Saved' },
    };
    const h = harness(
      runData([
        item('facts.settingPlace', {
          hash: blockPrint('Saved town'),
          value: 'A small river town',
        }),
      ]),
      stored,
    );
    await h.fields.accept(ROW, 0);
    expect(h.written[0]).toEqual({
      language: 'en',
      facts: { settingPlace: 'A small river town', narrator: 'Saved' },
    });
  });

  it('the analysis refuses the references of the merged object: 409 ANALYSIS_WRITE_REFUSED with the errors, the proposal stays', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const h = harness(runData([proposal(stored)]), stored);
    h.saveGuarded.mockRejectedValueOnce(
      new BadRequestException({ message: ['keyQuotes.0.speakerKey: unknown character'] }),
    );
    const body = await h.codeOf(h.fields.accept(ROW, 0));
    expect(body).toMatchObject({
      code: 'ANALYSIS_WRITE_REFUSED',
      errors: ['keyQuotes.0.speakerKey: unknown character'],
    });
    expect(h.run().items[0].outcome).toBe('proposed');
  });

  it('the body depends on the other blocks and they changed between the read and the lock: replanned, not written blind', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED, themes: [theme('loss')] };
    const h = harness(runData([proposal(stored)], LINKS), stored, (db, call) => {
      if (call === 1) db.stored = { ...db.stored, themes: [theme('loss'), theme('home')] };
    });
    await h.fields.accept(ROW, 0);
    expect(h.saveGuarded).toHaveBeenCalledTimes(2);
    expect(h.db.stored.characters).toEqual([
      { ...ANNA, themeKeys: ['loss', 'home'] },
      { ...BORIS, themeKeys: ['home'] },
    ]);
  });
});

describe('AnalysisWriteFields.discardItem (F07-1b)', () => {
  it('a proposal becomes discarded, the block of the analysis is not touched', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const h = harness(
      runData([item('characters', { hash: blockPrint(EDITED), value: [ANNA] })]),
      stored,
    );
    await h.fields.discardItem(ROW, 0);
    expect(h.run().items[0].outcome).toBe('discarded');
    expect(h.db.stored.characters).toEqual(EDITED);
    expect(h.saveGuarded).not.toHaveBeenCalled();
    // Повторный «Discard» - не успех: блок уже не предложение.
    expect((await h.codeOf(h.fields.discardItem(ROW, 0))).code).toBe('ANALYSIS_ITEM_NOT_PROPOSED');
  });

  it('not a proposal, a regenerating block and a run that is not ready are refused', async () => {
    const written = harness(
      runData([item('characters', { outcome: 'written' })]),
      EMPTY_BOOK_ANALYSIS,
    );
    expect((await written.codeOf(written.fields.discardItem(ROW, 0))).code).toBe(
      'ANALYSIS_ITEM_NOT_PROPOSED',
    );
    const regen = harness(
      runData([
        item('characters', {
          regen: { operationId: 'op2', remark: null, pending: null, previous: null },
        }),
      ]),
      EMPTY_BOOK_ANALYSIS,
    );
    expect((await regen.codeOf(regen.fields.discardItem(ROW, 0))).code).toBe(
      'ANALYSIS_REGEN_IN_PROGRESS',
    );
    const building = harness(
      runData([item('characters', {})]),
      EMPTY_BOOK_ANALYSIS,
      undefined,
      'building',
    );
    expect((await building.codeOf(building.fields.discardItem(ROW, 0))).code).toBe(
      'ANALYSIS_ITEM_NOT_PROPOSED',
    );
  });
});

describe('regeneration of a block: the gate and the decision (F07-1b)', () => {
  const regen = { operationId: 'op2', remark: 'shorter', pending: null, previous: null };

  it('the regen gate writes only while the block carries its operation; the ready row is written by status', async () => {
    const waiting = item('characters', { outcome: 'waiting', value: [ANNA], regen });
    const h = harness(runData([waiting]), EMPTY_BOOK_ANALYSIS);
    expect(await h.fields.read(ROW, analysisRegenGate('op2', 0))).not.toBeNull();
    expect(await h.fields.read(ROW, analysisRegenGate('other', 0))).toBeNull();
    expect(await h.fields.read(ROW, analysisRegenGate('op2', 1))).toBeNull();
    // Отмена: отметку сняли - перегенерация ничего не пишет.
    await h.fields.mutate(ROW, analysisReadyGate, (data) => ({
      ...data,
      items: [{ ...data.items[0], regen: null }],
    }));
    expect(await h.fields.read(ROW, analysisRegenGate('op2', 0))).toBeNull();
    expect(h.tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(h.tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'd1', status: 'ready' } }),
    );
  });

  it('a regenerated block that is already in the analysis (even written by the run itself) is changed only by a proposal, the links poured back, the saved block untouched', async () => {
    const stored = {
      ...EMPTY_BOOK_ANALYSIS,
      characters: [{ ...ANNA, themeKeys: ['loss'] }],
      themes: [theme('loss'), theme('home')],
    };
    const data = runData(
      [item('characters', { outcome: 'waiting', value: [{ ...ANNA, description: 'new' }], regen })],
      LINKS,
      { characters: true },
      { characters: blockPrint(stored.characters) },
    );
    const h = harness(data, stored);
    await expect(h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 1, 0)).resolves.toBe(
      'settled',
    );
    const [result] = h.run().items;
    expect(result.outcome).toBe('proposed');
    expect(result.hash).toBe(blockPrint(stored.characters));
    expect(result.value).toEqual([{ ...ANNA, description: 'new', themeKeys: ['loss', 'home'] }]);
    expect(h.db.stored.characters).toEqual(stored.characters);
    expect(h.saveGuarded).not.toHaveBeenCalled();
  });

  it('a regenerated block that is empty in the analysis (the previous answer failed the import) and owned by the run is written, keys kept and the links poured', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, themes: [theme('loss'), theme('home')] };
    const data = runData(
      [item('characters', { outcome: 'waiting', value: [ANNA, BORIS], regen, pendingDropped: [] })],
      LINKS,
      { characters: true },
      { characters: blockPrint(null) },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 1, 0);
    expect(h.db.stored.characters).toEqual([
      { ...ANNA, themeKeys: ['loss', 'home'] },
      { ...BORIS, themeKeys: ['home'] },
    ]);
    expect(h.run().items[0].outcome).toBe('written');
    // Записанный итог перегенерации - в `merged` хода (/fix 2, блокер 4).
    expect(h.run().merged.characters).toEqual(h.db.stored.characters);
  });

  it('a regenerated block the editor changed is a proposal with the print of the block as it is now', async () => {
    const stored = {
      ...EMPTY_BOOK_ANALYSIS,
      characters: EDITED,
      themes: [theme('loss')],
    };
    const data = runData(
      [item('characters', { outcome: 'waiting', value: [ANNA], regen })],
      LINKS,
      { characters: true },
      { characters: blockPrint([ANNA]) },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 1, 0);
    const [result] = h.run().items;
    expect(result.outcome).toBe('proposed');
    expect(result.hash).toBe(blockPrint(EDITED));
    expect(result.value).toEqual([{ ...ANNA, themeKeys: ['loss'] }]);
    expect(h.db.stored.characters).toEqual(EDITED);
    expect(h.saveGuarded).not.toHaveBeenCalled();
  });

  it('a character the new answer dropped while the saved quotations still point at him: the result is a proposal flagged IMPORT_INVALID with the path of the dangling reference, the saved block stays', async () => {
    const stored = {
      ...EMPTY_BOOK_ANALYSIS,
      characters: [ANNA, BORIS],
      keyQuotes: [{ ...QUOTE, speakerKey: 'boris' }],
    };
    const data = runData(
      [item('characters', { outcome: 'waiting', value: [ANNA], regen })],
      null,
      { characters: true },
      { characters: blockPrint(stored.characters) },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 1, 0);
    const [result] = h.run().items;
    expect(result.outcome).toBe('proposed');
    expect(result.verdict).toBe('flags');
    expect(result.remarks.map((r) => r.code)).toEqual(['IMPORT_INVALID']);
    expect(result.remarks[0].where).toContain('keyQuotes');
    expect(result.value).toEqual([ANNA]);
    expect(h.db.stored.characters).toEqual([ANNA, BORIS]);
    expect(h.saveGuarded).not.toHaveBeenCalled();
  });

  it('a regenerated block without dangling references is a clean proposal: no flag', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: [ANNA, BORIS] };
    const data = runData(
      [item('characters', { outcome: 'waiting', value: [ANNA, BORIS], regen })],
      null,
      { characters: true },
      { characters: blockPrint(stored.characters) },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 1, 0);
    expect(h.run().items[0]).toMatchObject({ outcome: 'proposed', verdict: 'ok', remarks: [] });
  });

  it('planStep with `only` plans that block alone and pours the links; without it the other waiting blocks of the step go too', () => {
    const state = {
      stored: { ...EMPTY_BOOK_ANALYSIS, themes: [theme('loss'), theme('home')] },
      published: false,
    };
    const data = runData(
      [
        item('characters', { outcome: 'waiting', value: [ANNA] }),
        item('facts.narrator', { outcome: 'waiting', value: 'Third person' }),
      ],
      LINKS,
      { characters: true, 'facts.narrator': true },
      {
        characters: blockPrint(null),
        'facts.narrator': blockPrint(null),
      },
    );
    const only = planStep(data, 1, state, 'en', null, 0);
    expect(only.writes).toEqual([0]);
    expect(only.dto).toEqual({
      language: 'en',
      characters: [{ ...ANNA, themeKeys: ['loss', 'home'] }],
    });
    const whole = planStep(data, 1, state, 'en');
    expect(whole.writes).toEqual([0, 1]);
    // Шаг хода связей не вливает: их вливает шаг 3 отдельным элементом.
    expect(whole.dto).toMatchObject({ characters: [ANNA] });
  });
});

describe('withThemeLinks', () => {
  it('no links or not a list - the value as it is; the limit cuts the tail and says so', () => {
    const themeKeys = new Set(['a', 'b']);
    const value = [ANNA];
    expect(withThemeLinks('characters', value, null, themeKeys, [])).toBe(value);
    expect(withThemeLinks('style', value, LINKS, themeKeys, [])).toBe(value);
    expect(withThemeLinks('characters', 'text', LINKS, themeKeys, [])).toBe('text');
    const max = BOOK_ANALYSIS_LIMITS.themeKeys;
    const many = Array.from({ length: max + 2 }, (_, i) => `k${i}`);
    const cut: Parameters<typeof withThemeLinks>[4] = [];
    const out = withThemeLinks(
      'characters',
      [ANNA],
      { characters: { anna: many }, keyQuotes: {} },
      new Set(many),
      cut,
    ) as Array<{ themeKeys: string[] }>;
    expect(out[0].themeKeys).toHaveLength(max);
    expect(cut).toEqual([expect.objectContaining({ code: 'LIMIT_OUT' })]);
  });
});

describe('Accept of a theme pours its key into characters and quotations (F07-1b, decision Б)', () => {
  const THEMES = [theme('loss'), theme('home')];
  const themeProposal = (stored: StoredBookAnalysis) =>
    item('themes', { step: 3, hash: blockPrint(targetValue(stored, 'themes')), value: THEMES });

  it('blocks the run still owns get the keys with the same write; written blocks stay', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: [ANNA, BORIS], keyQuotes: [QUOTE] };
    const data = runData(
      [themeProposal(stored)],
      LINKS,
      { characters: true, keyQuotes: true },
      {
        characters: blockPrint(stored.characters),
        keyQuotes: blockPrint(stored.keyQuotes),
      },
    );
    const h = harness(data, stored);
    await h.fields.accept(ROW, 0);
    expect(h.saveGuarded).toHaveBeenCalledTimes(1);
    expect(Object.keys(h.written[0]).sort()).toEqual([
      'characters',
      'keyQuotes',
      'language',
      'themes',
    ]);
    expect(h.db.stored.characters).toEqual([
      { ...ANNA, themeKeys: ['loss', 'home'] },
      { ...BORIS, themeKeys: ['home'] },
    ]);
    expect(h.db.stored.keyQuotes).toEqual([{ ...QUOTE, themeKeys: ['loss'] }]);
    // Записанное ходом - снова его: отпечаток после записи, следующий шаг вправе писать блок.
    expect(h.run().written.characters).toBe(blockPrint(h.db.stored.characters));
    expect(h.run().items.map((i) => [i.target, i.links, i.outcome])).toEqual([
      ['themes', false, 'accepted'],
    ]);
  });

  it('blocks the run does not own (the editor wrote them): new proposals of the links with the print of the block and the limit of themeKeys', async () => {
    const max = BOOK_ANALYSIS_LIMITS.themeKeys;
    const keys = Array.from({ length: max + 2 }, (_, i) => `t${i}`);
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED, keyQuotes: [QUOTE] };
    const data = {
      ...runData([
        item('themes', { step: 3, hash: blockPrint(null), value: keys.map(theme) }),
        item('keyQuotes', { step: 3, links: true, outcome: 'none', value: null }),
      ]),
      themeLinks: { characters: { anna: keys }, keyQuotes: { [quotePrint(QUOTE.text)]: ['t0'] } },
    };
    const h = harness(data, stored);
    await h.fields.accept(ROW, 0);
    expect(Object.keys(h.written[0]).sort()).toEqual(['language', 'themes']);
    expect(h.db.stored.characters).toEqual(EDITED);
    const items = h.run().items;
    // Снятое \`none\` того же блока переиспользуется, новое - в конец.
    expect(items.map((i) => [i.target, i.links, i.outcome])).toEqual([
      ['themes', false, 'accepted'],
      ['keyQuotes', true, 'proposed'],
      ['characters', true, 'proposed'],
    ]);
    expect(items[1]).toMatchObject({
      hash: blockPrint([QUOTE]),
      value: [{ ...QUOTE, themeKeys: ['t0'] }],
    });
    expect(items[2].hash).toBe(blockPrint(EDITED));
    const poured = (items[2].value as Array<{ themeKeys: string[] }>)[0].themeKeys;
    expect(poured).toEqual(keys.slice(0, max));
    // Предложение связей принимается тем же «Accept» со сверкой хэша.
    await h.fields.accept(ROW, 2);
    expect((h.db.stored.characters ?? [])[0].themeKeys).toEqual(keys.slice(0, max));
  });

  it('the editor changed the block after the theme proposal of links: its Accept is 409', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const h = harness(runData([themeProposal(stored)], LINKS), stored);
    await h.fields.accept(ROW, 0);
    const links = h.run().items.findIndex((i) => i.links);
    h.db.stored = { ...h.db.stored, characters: [{ ...ANNA, description: 'again' }] };
    expect((await h.codeOf(h.fields.accept(ROW, links))).code).toBe('ANALYSIS_BLOCK_CHANGED');
  });
});

describe('Accept of a block and then of its links (F07-1b, blocker 1)', () => {
  it('the links proposal follows the block the run itself accepted: its print is renewed, its Accept passes', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED, themes: [theme('loss')] };
    const linksValue = [{ ...EDITED[0], themeKeys: ['loss'] }];
    const h = harness(
      runData(
        [
          item('characters', { hash: blockPrint(EDITED), value: [ANNA, BORIS] }),
          item('characters', { step: 3, links: true, hash: blockPrint(EDITED), value: linksValue }),
        ],
        { characters: { anna: ['loss'], boris: ['loss'] }, keyQuotes: {} },
      ),
      stored,
    );
    await h.fields.accept(ROW, 0);
    // Ключи уже влиты «Accept» героев (А3): предложению связей нечего добавить - снято, не 409.
    expect(h.run().items.map((i) => i.outcome)).toEqual(['accepted', 'none']);
    expect(h.db.stored.characters).toEqual([
      { ...ANNA, themeKeys: ['loss'] },
      { ...BORIS, themeKeys: ['loss'] },
    ]);
  });

  it('keys the block accept could not pour (the theme is still a proposal) come back as a links proposal on the accepted block when the theme is accepted, and it is accepted', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const h = harness(
      runData(
        [
          item('characters', { hash: blockPrint(EDITED), value: [ANNA] }),
          item('characters', { step: 3, links: true, hash: blockPrint(EDITED), value: EDITED }),
          item('themes', { step: 3, hash: blockPrint(null), value: [theme('loss')] }),
        ],
        { characters: { anna: ['loss'] }, keyQuotes: {} },
      ),
      stored,
    );
    await h.fields.accept(ROW, 0);
    expect(h.run().items.map((i) => i.outcome)).toEqual(['accepted', 'none', 'proposed']);
    await h.fields.accept(ROW, 2);
    const links = h.run().items[1];
    expect(links).toMatchObject({ outcome: 'proposed', hash: blockPrint([ANNA]) });
    await h.fields.accept(ROW, 1);
    expect(h.db.stored.characters).toEqual([{ ...ANNA, themeKeys: ['loss'] }]);
  });
});

describe('409 after the attempts are spent (F07-1b, blocker 8)', () => {
  it('ANALYSIS_BLOCK_CHANGED carries the content of the block now, not null', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED, themes: [theme('loss')] };
    const h = harness(
      runData([item('characters', { hash: blockPrint(EDITED), value: [ANNA] })], {
        characters: { anna: ['t1', 't2', 't3', 't4'] },
        keyQuotes: {},
      }),
      stored,
      (db, call) => {
        // Темы меняются перед каждым замком: тело записи не сходится ни в одной попытке.
        db.stored = { ...db.stored, themes: [theme(`t${call}`)] };
      },
    );
    const body = await h.codeOf(h.fields.accept(ROW, 0));
    expect(body).toMatchObject({ code: 'ANALYSIS_BLOCK_CHANGED', current: EDITED });
  });
});

describe('a regenerated proposal enters merged only by Accept (/fix 2, blocker 4)', () => {
  const drop = {
    step: 1 as const,
    path: 'characters.0.quote',
    text: 'new drop',
    chapter: 1,
    reason: 'NOT_FOUND' as const,
  };
  const regenerated = () => ({
    ...runData([
      item('characters', { hash: blockPrint(EDITED), value: [BORIS], pendingDropped: [drop] }),
    ]),
    merged: { characters: [ANNA] },
    droppedQuotes: [{ ...drop, text: 'old drop' }],
  });

  it('Discard of the regenerated proposal: merged and the dropped quotations stay as before the regeneration', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const h = harness(regenerated(), stored);
    await h.fields.discardItem(ROW, 0);
    expect(h.run().merged.characters).toEqual([ANNA]);
    expect(h.run().droppedQuotes.map((d) => d.text)).toEqual(['old drop']);
  });

  it('Accept of the regenerated proposal: the block goes into merged, its dropped quotations replace the old ones', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const h = harness(regenerated(), stored);
    await h.fields.accept(ROW, 0);
    expect(h.run().merged.characters).toEqual([BORIS]);
    expect(h.run().droppedQuotes.map((d) => d.text)).toEqual(['new drop']);
    expect(h.run().items[0].pendingDropped).toBeNull();
  });
});

describe('a write of the run into an owned block and the cut themeKeys (/fix 3, blockers 1, 3, 4)', () => {
  const step = (n: 1 | 2 | 3) => ({
    step: n,
    verdict: 'ok' as const,
    remarks: [],
    attempt: 1 as const,
    outcome: 'done' as const,
    failedReason: null,
    authorModel: 'm',
    review: null,
    source: 'text' as const,
    dropped: [],
  });
  const withSteps = (data: AnalysisWriteData): AnalysisWriteData => ({
    ...data,
    steps: [step(1), step(2), step(3)],
  });

  it('Accept of a theme writes the owned characters: every proposal of the characters gets the print of the written block - the plain one and the links (blocker 1)', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: [ANNA] };
    const data = runData(
      [
        item('themes', { step: 3, hash: blockPrint(null), value: [theme('loss')] }),
        // Итог перегенерации героев, предложение над тем же блоком.
        item('characters', { hash: blockPrint([ANNA]), value: [ANNA, BORIS] }),
      ],
      { characters: { anna: ['loss'] }, keyQuotes: {} },
      { characters: true },
      { characters: blockPrint([ANNA]) },
    );
    const h = harness(data, stored);
    await h.fields.accept(ROW, 0);
    expect(h.db.stored.characters).toEqual([{ ...ANNA, themeKeys: ['loss'] }]);
    expect(h.run().items[1].hash).toBe(blockPrint(h.db.stored.characters));
    // Не 409: ход сам изменил блок, предложение принимается.
    await h.fields.accept(ROW, 1);
    expect(h.run().items[1].outcome).toBe('accepted');
  });

  it('a regenerated result written into an empty owned block: the other proposals of that unit get the print of the written block, the links are rebuilt on it (blocker 1)', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, themes: [theme('loss')] };
    const regen = { operationId: 'op2', remark: null, pending: null, previous: null };
    const data = runData(
      [
        item('characters', { outcome: 'waiting', value: [ANNA], regen, pendingDropped: [] }),
        item('characters', { step: 3, links: true, hash: blockPrint(null), value: [] }),
      ],
      { characters: { anna: ['loss'] }, keyQuotes: {} },
      { characters: true },
      { characters: blockPrint(null) },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 1, 0);
    const [written, links] = h.run().items;
    expect(written.outcome).toBe('written');
    // Связи уже влиты записью перегенерации: предложению связей нечего добавить.
    expect(links.outcome).toBe('none');
    // В merged - фактически записанное, с влитыми themeKeys (blocker 4).
    expect(h.run().merged.characters).toEqual([{ ...ANNA, themeKeys: ['loss'] }]);
  });

  it('Accept of characters: merged gets the block as written, with the poured themeKeys (blocker 4)', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED, themes: [theme('loss')] };
    const h = harness(
      runData(
        [item('characters', { hash: blockPrint(EDITED), value: [ANNA], pendingDropped: [] })],
        {
          characters: { anna: ['loss'] },
          keyQuotes: {},
        },
      ),
      stored,
    );
    await h.fields.accept(ROW, 0);
    expect(h.run().merged.characters).toEqual([{ ...ANNA, themeKeys: ['loss'] }]);
  });

  it('themeKeys cut by the limit at Accept go into steps[].dropped of the themes step as LIMIT_OUT, replaced by code and path, not added again (blocker 3)', async () => {
    const max = BOOK_ANALYSIS_LIMITS.themeKeys;
    const keys = Array.from({ length: max + 2 }, (_, i) => `t${i}`);
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED, themes: keys.map(theme) };
    const proposal = () => item('characters', { hash: blockPrint(EDITED), value: [ANNA] });
    const h = harness(
      withSteps(runData([proposal(), proposal()], { characters: { anna: keys }, keyQuotes: {} })),
      stored,
    );
    await h.fields.accept(ROW, 0);
    const dropped = () => h.run().steps.find((s) => s.step === 3)?.dropped ?? [];
    expect(dropped()).toEqual([
      expect.objectContaining({ code: 'LIMIT_OUT', path: 'characters.anna.themeKeys' }),
    ]);
    // Второе предложение над тем же блоком: та же обрезка - замена, а не вторая строка.
    h.db.stored = { ...h.db.stored, characters: EDITED };
    await h.fields.accept(ROW, 1);
    expect(dropped()).toHaveLength(1);
  });
});
