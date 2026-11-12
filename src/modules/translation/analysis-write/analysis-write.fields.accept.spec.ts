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
  proposalPrint,
  readAnalysisData,
  targetValue,
  ThemeLinks,
} from './analysis-write.data';
import {
  analysisReadyGate,
  analysisRegenGate,
  analysisRunGate,
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
  row: {
    id: string;
    bookVersionId: string;
    kind: string;
    status: string;
    operationId: string;
    data: unknown;
  };
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
      bookVersionId: 'v1',
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
      update: jest.fn(() => Promise.resolve({})),
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

  it('Accept notes the model text on the version in the same transaction; a refused Accept does not (T184)', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };
    const h = harness(runData([proposal(stored)]), stored);
    await h.fields.accept(ROW, 0);
    expect(h.tx.bookVersion.update).toHaveBeenCalledTimes(1);
    expect(h.tx.bookVersion.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { analysisAutoTextAt: expect.any(Date) as Date },
    });

    const refused = harness(runData([proposal(stored)]), {
      ...stored,
      characters: [{ ...ANNA, description: 'edited again' }],
    });
    await refused.codeOf(refused.fields.accept(ROW, 0));
    expect(refused.tx.bookVersion.update).not.toHaveBeenCalled();
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

  describe('the print of the proposal the editor saw (T174, p.2)', () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED };

    it('the same proposal is accepted; without a print there is no check', async () => {
      const shown = proposal(stored);
      const h = harness(runData([shown]), stored);
      await h.fields.accept(ROW, 0, proposalPrint(shown));
      expect(h.run().items[0].outcome).toBe('accepted');
      const old = harness(runData([proposal(stored)]), stored);
      await old.fields.accept(ROW, 0);
      expect(old.run().items[0].outcome).toBe('accepted');
    });

    it('another proposal at the read: 409 ANALYSIS_PROPOSAL_CHANGED, nothing is written', async () => {
      const h = harness(runData([proposal(stored, [ANNA])]), stored);
      const body = await h.codeOf(h.fields.accept(ROW, 0, proposalPrint(proposal(stored))));
      expect(body.code).toBe('ANALYSIS_PROPOSAL_CHANGED');
      expect(h.saveGuarded).not.toHaveBeenCalled();
      expect(h.run().items[0].outcome).toBe('proposed');
    });

    it('the proposal changes between the read and the lock: allow refuses, the block stays', async () => {
      // Источник уже сохранён: тело записи то же, пересборка не сработает, поймать может только
      // сверка под замком.
      const source = { title: 'T', url: 'https://example.org/a' };
      const withSource = { ...stored, sources: [source] } as StoredBookAnalysis;
      const shown = proposal(withSource);
      const h = harness(runData([shown]), withSource, (db) => {
        const pendingSources = [source] as never;
        db.row.data = JSON.parse(
          JSON.stringify(analysisDataJson(runData([{ ...shown, pendingSources }]))),
        ) as unknown;
      });
      const body = await h.codeOf(h.fields.accept(ROW, 0, proposalPrint(shown)));
      expect(body.code).toBe('ANALYSIS_PROPOSAL_CHANGED');
      expect(h.db.stored.characters).toEqual(EDITED);
      expect(h.written).toHaveLength(0);
    });

    it('new theme links with the same text are another proposal', () => {
      expect(proposalPrint(proposal(stored))).not.toBe(
        proposalPrint({ ...proposal(stored), pendingLinks: LINKS }),
      );
    });

    it('new sources with the same text are another proposal', () => {
      const source = { title: 'T', url: 'https://example.org/a' };
      expect(proposalPrint(proposal(stored))).not.toBe(
        proposalPrint({ ...proposal(stored), pendingSources: [source] as never }),
      );
    });

    it('not a proposal and a regenerating block keep their own codes, a stale print does not hide them', async () => {
      const decided = harness(
        runData([item('characters', { hash: 'h', outcome: 'accepted' })]),
        stored,
      );
      expect((await decided.codeOf(decided.fields.accept(ROW, 0, 'stale'))).code).toBe(
        'ANALYSIS_ITEM_NOT_PROPOSED',
      );
      const regen = { operationId: 'op2', remark: null, pending: null, previous: null };
      const busy = harness(runData([{ ...proposal(stored), regen }]), stored);
      expect((await busy.codeOf(busy.fields.accept(ROW, 0, 'stale'))).code).toBe(
        'ANALYSIS_REGEN_IN_PROGRESS',
      );
    });
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

describe('F07-2b: regeneration of the blocks of steps 3-5 in the decision and Accept', () => {
  const regen = { operationId: 'op2', remark: null, pending: null, previous: null };
  const SRC = (n: number) => ({ title: `Source ${n}`, url: `https://s.example/${n}` });
  const stepOf = (n: 1 | 2 | 3 | 4 | 5) => ({
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
  const steps = (data: AnalysisWriteData): AnalysisWriteData => ({
    ...data,
    steps: ([1, 2, 3, 4, 5] as const).map(stepOf),
  });
  const dropped = (data: AnalysisWriteData, n: number) =>
    data.steps.find((s) => s.step === n)?.dropped ?? [];

  it('themeKeys cut at a regeneration that is written go to the themes step, not to the step of the block', async () => {
    const max = BOOK_ANALYSIS_LIMITS.themeKeys;
    const keys = Array.from({ length: max + 1 }, (_, i) => `t${i}`);
    const stored = { ...EMPTY_BOOK_ANALYSIS, themes: keys.map(theme) };
    const data = steps(
      runData(
        [item('characters', { outcome: 'waiting', value: [ANNA], regen, pendingDropped: [] })],
        { characters: { anna: keys }, keyQuotes: {} },
        { characters: true },
        { characters: blockPrint(null) },
      ),
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 1, 0);
    expect(h.run().items[0].outcome).toBe('written');
    expect(dropped(h.run(), 3)).toEqual([
      expect.objectContaining({ code: 'LIMIT_OUT', path: 'characters.anna.themeKeys' }),
    ]);
    expect(dropped(h.run(), 1)).toEqual([]);
  });

  it('a regenerated proposal records no LIMIT_OUT - the cut is recorded by its Accept', async () => {
    const max = BOOK_ANALYSIS_LIMITS.themeKeys;
    const keys = Array.from({ length: max + 1 }, (_, i) => `t${i}`);
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: EDITED, themes: keys.map(theme) };
    const data = steps(
      runData(
        [item('characters', { outcome: 'waiting', value: [ANNA], regen, pendingDropped: [] })],
        { characters: { anna: keys }, keyQuotes: {} },
      ),
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 1, 0);
    expect(h.run().items[0].outcome).toBe('proposed');
    expect(dropped(h.run(), 3)).toEqual([]);
    expect(dropped(h.run(), 1)).toEqual([]);
  });

  it('regenerated themes written into an empty owned block: their links go into the owned characters by the same write and join the links of the run', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: [ANNA] };
    const newLinks = { characters: { anna: ['sin'] }, keyQuotes: {} };
    const data = runData(
      [
        item('themes', {
          step: 3,
          outcome: 'waiting',
          value: [theme('sin')],
          regen,
          pendingDropped: [],
          pendingLinks: newLinks,
        }),
      ],
      { characters: { anna: ['old'] }, keyQuotes: {} },
      { themes: true, characters: true },
      { themes: blockPrint(null), characters: blockPrint([ANNA]) },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 3, 0);
    expect(h.saveGuarded).toHaveBeenCalledTimes(1);
    expect(h.db.stored.themes).toEqual([theme('sin')]);
    expect(h.db.stored.characters).toEqual([{ ...ANNA, themeKeys: ['sin'] }]);
    expect(h.run().themeLinks).toEqual({ characters: { anna: ['old', 'sin'] }, keyQuotes: {} });
    expect(h.run().written.characters).toBe(blockPrint(h.db.stored.characters));
    expect(h.run().items[0]).toMatchObject({ outcome: 'written', pendingLinks: null });
  });

  it('regenerated themes as a proposal keep the links of the run until Accept; Accept pours the new links and joins them to the links of the run', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: [ANNA], themes: [theme('old')] };
    const newLinks = { characters: { anna: ['sin'] }, keyQuotes: {} };
    const oldLinks = { characters: { anna: ['old'] }, keyQuotes: {} };
    const data = runData(
      [
        item('themes', {
          step: 3,
          outcome: 'waiting',
          value: [theme('sin')],
          regen,
          pendingDropped: [],
          pendingLinks: newLinks,
        }),
      ],
      oldLinks,
      { characters: true },
      { characters: blockPrint([ANNA]) },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 3, 0);
    expect(h.run().items[0].outcome).toBe('proposed');
    expect(h.run().themeLinks).toEqual(oldLinks);
    expect(h.saveGuarded).not.toHaveBeenCalled();
    await h.fields.mutate(ROW, analysisReadyGate, (d) => ({
      ...d,
      items: [{ ...d.items[0], regen: null }],
    }));
    await h.fields.accept(ROW, 0);
    expect(h.db.stored.themes).toEqual([theme('sin')]);
    expect(h.db.stored.characters).toEqual([{ ...ANNA, themeKeys: ['sin'] }]);
    expect(h.run().themeLinks).toEqual({ characters: { anna: ['old', 'sin'] }, keyQuotes: {} });
  });

  it('a regenerated step 5 block written into an empty owned block: its sources are added to the saved ones by url in the same write', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, sources: [SRC(0)] };
    const data = runData(
      [
        item('context', {
          step: 5,
          outcome: 'waiting',
          value: 'New paragraph.',
          regen,
          pendingDropped: [],
          pendingSources: [SRC(0), SRC(1)],
        }),
      ],
      null,
      { context: true, sources: true },
      { context: blockPrint(null), sources: blockPrint([SRC(0)]) },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 5, 0);
    expect(h.saveGuarded).toHaveBeenCalledTimes(1);
    expect(h.written[0]).toMatchObject({ context: 'New paragraph.', sources: [SRC(0), SRC(1)] });
    expect(h.run().written.sources).toBe(blockPrint([SRC(0), SRC(1)]));
    expect(h.run().items[0]).toMatchObject({ outcome: 'written', pendingSources: null });
  });

  it('the run may write the block but not the sources (the editor changed them): the block and its sources go as one proposal', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, sources: [SRC(9)] };
    const data = runData(
      [
        item('context', {
          step: 5,
          outcome: 'waiting',
          value: 'New paragraph.',
          regen,
          pendingDropped: [],
          pendingSources: [SRC(1)],
        }),
      ],
      null,
      { context: true, sources: true },
      { context: blockPrint(null), sources: blockPrint([SRC(0)]) },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 5, 0);
    expect(h.saveGuarded).not.toHaveBeenCalled();
    expect(h.run().items[0]).toMatchObject({
      outcome: 'proposed',
    });
  });

  it('Accept of a step 5 proposal writes the sources with it; the editor changed the sources - their edit is kept and the new one added; a neighbour proposal is not broken by the first Accept', async () => {
    const stored = {
      ...EMPTY_BOOK_ANALYSIS,
      context: 'Old.',
      reception: 'Old.',
      sources: [SRC(0)],
    };
    const proposal = (target: 'context' | 'reception', n: number) =>
      item(target, {
        step: 5,
        hash: blockPrint('Old.'),
        value: `New ${target}.`,
        pendingDropped: [],
        pendingSources: [SRC(n)],
      });
    const h = harness(runData([proposal('context', 1), proposal('reception', 2)], null), stored);
    await h.fields.accept(ROW, 0);
    expect(h.db.stored.sources).toEqual([SRC(0), SRC(1)]);
    expect(h.db.stored.context).toBe('New context.');
    // Соседнее предложение: источники дополнил «Accept» хода, а не редактор - не 409.
    await h.fields.accept(ROW, 1);
    expect(h.db.stored.sources).toEqual([SRC(0), SRC(1), SRC(2)]);

    // Источники правил редактор: объединение только добавляет - его правка остаётся (круг 3, B).
    const edited = harness(runData([proposal('context', 1)], null), {
      ...stored,
      sources: [SRC(7)],
    });
    await edited.fields.accept(ROW, 0);
    expect(edited.db.stored.sources).toEqual([SRC(7), SRC(1)]);
  });
});

describe('F07-2b, /fix 1: links, sources and their prints after a write', () => {
  const regen = { operationId: 'op2', remark: null, pending: null, previous: null };
  const SRC = (n: number) => ({ title: `Source ${n}`, url: `https://s.example/${n}` });

  it('regenerated themes with empty links of the answer do not wipe the links of the run (merge, not replace)', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, themes: [theme('loss')] };
    const data = runData(
      [
        item('themes', {
          step: 3,
          outcome: 'waiting',
          value: [theme('loss')],
          regen,
          pendingDropped: [],
          pendingLinks: { characters: {}, keyQuotes: {} },
        }),
      ],
      LINKS,
      { themes: true },
      { themes: blockPrint(null) },
    );
    const h = harness(data, { ...stored, themes: undefined } as unknown as StoredBookAnalysis);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 3, 0);
    expect(h.run().items[0].outcome).toBe('written');
    expect(h.run().themeLinks).toEqual(LINKS);
  });

  it('two waiting step 5 blocks decided together (a break before the decision): the sources of both are written, not the last only', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, sources: [SRC(0)] };
    const waiting = (target: 'context' | 'reception', n: number) =>
      item(target, {
        step: 5,
        outcome: 'waiting',
        value: `New ${target}.`,
        pendingDropped: [],
        pendingSources: [SRC(n)],
      });
    const data = runData(
      [waiting('context', 1), waiting('reception', 2)],
      null,
      { context: true, reception: true, sources: true },
      {
        context: blockPrint(null),
        reception: blockPrint(null),
        sources: blockPrint([SRC(0)]),
      },
    );
    const h = harness(data, stored, () => undefined, 'building');
    await h.fields.settleStep(ROW, analysisRunGate('op1'), 5);
    expect(h.db.stored.sources).toEqual([SRC(0), SRC(1), SRC(2)]);
  });

  it('Accept of a step 5 proposal while the run owns the sources: the run keeps them (written), a sources proposal follows the written block', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, context: 'Old.', sources: [SRC(0)] };
    const data = runData(
      [
        item('context', {
          step: 5,
          hash: blockPrint('Old.'),
          value: 'New.',
          pendingDropped: [],
          pendingSources: [SRC(1)],
        }),
        item('sources', { step: 5, hash: blockPrint([SRC(0)]), value: [SRC(0), SRC(3)] }),
      ],
      null,
      { sources: true },
      { sources: blockPrint([SRC(0)]) },
    );
    const h = harness(data, stored);
    await h.fields.accept(ROW, 0);
    expect(h.run().written.sources).toBe(blockPrint([SRC(0), SRC(1)]));
    expect(h.run().items[1].hash).toBe(blockPrint([SRC(0), SRC(1)]));
    await h.fields.accept(ROW, 1);
    expect(h.run().items[1].outcome).toBe('accepted');
  });

  it('Accept of the sources proposal: a regenerated step 5 proposal compares the sources with the written block, not 409 forever', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, context: 'Old.', sources: [SRC(0)] };
    const data = runData(
      [
        item('sources', { step: 5, hash: blockPrint([SRC(0)]), value: [SRC(0), SRC(3)] }),
        item('context', {
          step: 5,
          hash: blockPrint('Old.'),
          value: 'New.',
          pendingDropped: [],
          pendingSources: [SRC(1)],
        }),
      ],
      null,
    );
    const h = harness(data, stored);
    await h.fields.accept(ROW, 0);
    await h.fields.accept(ROW, 1);
    expect(h.db.stored.sources).toEqual([SRC(0), SRC(3), SRC(1)]);
  });
});

describe('F07-2b, /fix 3: the limit of the sources by the fact and one source of the theme links', () => {
  const regen = { operationId: 'op2', remark: null, pending: null, previous: null };
  const SRC = (n: number) => ({ title: `Source ${n}`, url: `https://s.example/${n}` });
  const full = (count: number) => Array.from({ length: count }, (_, i) => SRC(100 + i));
  const waiting = (pendingSources: Array<{ title: string; url: string }>) =>
    item('context', {
      step: 5,
      outcome: 'waiting',
      value: 'New.',
      regen,
      pendingDropped: [],
      pendingSources,
    });

  it('no saved sources at all (null): the regenerated block and its sources are written', async () => {
    const data = runData(
      [waiting([SRC(1)])],
      null,
      { context: true, sources: true },
      {
        context: blockPrint(null),
        sources: blockPrint(null),
      },
    );
    const h = harness(data, EMPTY_BOOK_ANALYSIS);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 5, 0);
    expect(h.saveGuarded).toHaveBeenCalledTimes(1);
    expect(h.db.stored).toMatchObject({ context: 'New.', sources: [SRC(1)] });
    expect(h.run().items[0].outcome).toBe('written');
  });

  it('every source of the block is already saved: the block is written though the run does not own the sources, the sources stay', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, sources: [SRC(7), SRC(1)] };
    const data = runData(
      [waiting([SRC(1)])],
      null,
      { context: true },
      {
        context: blockPrint(null),
      },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 5, 0);
    expect(h.written[0]).toEqual({ language: 'en', context: 'New.' });
    expect(h.db.stored.sources).toEqual([SRC(7), SRC(1)]);
  });

  it('the union does not fit the limit: the block is a proposal flagged LIMIT_OUT on the sources, its Accept is 409 ANALYSIS_WRITE_REFUSED', async () => {
    const saved = full(BOOK_ANALYSIS_LIMITS.sources);
    const stored = { ...EMPTY_BOOK_ANALYSIS, sources: saved };
    const data = runData(
      [waiting([SRC(1)])],
      null,
      { context: true, sources: true },
      {
        context: blockPrint(null),
        sources: blockPrint(saved),
      },
    );
    const h = harness(data, stored);
    await h.fields.settleStep(ROW, analysisRegenGate('op2', 0), 5, 0);
    expect(h.saveGuarded).not.toHaveBeenCalled();
    const proposal = h.run().items[0];
    expect(proposal).toMatchObject({ outcome: 'proposed', verdict: 'flags' });
    expect(proposal.remarks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'LIMIT_OUT', where: expect.stringMatching(/^sources/) }),
      ]),
    );
    await h.fields.mutate(ROW, analysisReadyGate, (d) => ({
      ...d,
      items: [{ ...d.items[0], regen: null }],
    }));
    expect((await h.codeOf(h.fields.accept(ROW, 0))).code).toBe('ANALYSIS_WRITE_REFUSED');
    expect(h.saveGuarded).not.toHaveBeenCalled();
  });

  it('another write of the sources before the Accept, the union still fits: Accept passes (no stale print)', async () => {
    const stored = {
      ...EMPTY_BOOK_ANALYSIS,
      context: 'Old.',
      reception: 'Old.',
      sources: [SRC(0)],
    };
    const proposal = (target: 'context' | 'reception', n: number) =>
      item(target, {
        step: 5,
        hash: blockPrint('Old.'),
        value: `New ${target}.`,
        pendingDropped: [],
        pendingSources: [SRC(n)],
      });
    const h = harness(runData([proposal('context', 1), proposal('reception', 2)], null), stored);
    // Редактор дописал источник руками между предложениями и «Accept».
    h.db.stored = { ...h.db.stored, sources: [SRC(0), SRC(9)] };
    await h.fields.accept(ROW, 1);
    expect(h.db.stored.sources).toEqual([SRC(0), SRC(9), SRC(2)]);
  });

  it('the sources fill up between the read and the lock: the body is rebuilt and the Accept is 409 ANALYSIS_WRITE_REFUSED, nothing is written', async () => {
    const saved = full(BOOK_ANALYSIS_LIMITS.sources - 1);
    const stored = { ...EMPTY_BOOK_ANALYSIS, context: 'Old.', sources: saved };
    const proposal = item('context', {
      step: 5,
      hash: blockPrint('Old.'),
      value: 'New.',
      pendingDropped: [],
      pendingSources: [SRC(1)],
    });
    const h = harness(runData([proposal], null), stored, (db, call) => {
      // Редактор занял последнее место, пока «Accept» шёл к замку.
      if (call === 1) db.stored = { ...db.stored, sources: [...saved, SRC(50)] };
    });
    expect((await h.codeOf(h.fields.accept(ROW, 0))).code).toBe('ANALYSIS_WRITE_REFUSED');
    expect(h.written).toEqual([]);
    expect(h.db.stored.context).toBe('Old.');
  });

  it('a neighbour proposal whose union no longer fits after an Accept: its Accept is 409 ANALYSIS_WRITE_REFUSED, nothing is written', async () => {
    const saved = full(BOOK_ANALYSIS_LIMITS.sources - 1);
    const stored = { ...EMPTY_BOOK_ANALYSIS, context: 'Old.', reception: 'Old.', sources: saved };
    const proposal = (target: 'context' | 'reception', n: number) =>
      item(target, {
        step: 5,
        hash: blockPrint('Old.'),
        value: `New ${target}.`,
        pendingDropped: [],
        pendingSources: [SRC(n)],
      });
    const h = harness(runData([proposal('context', 1), proposal('reception', 2)], null), stored);
    await h.fields.accept(ROW, 0);
    expect(h.db.stored.sources).toHaveLength(BOOK_ANALYSIS_LIMITS.sources);
    expect((await h.codeOf(h.fields.accept(ROW, 1))).code).toBe('ANALYSIS_WRITE_REFUSED');
    expect(h.db.stored.reception).toBe('Old.');
  });

  it('Accept of regenerated themes pours the links of the run too, not only those of the answer, into the characters the run owns', async () => {
    const stored = { ...EMPTY_BOOK_ANALYSIS, characters: [ANNA, BORIS], themes: [theme('love')] };
    const data = runData(
      [
        item('themes', {
          step: 3,
          hash: blockPrint([theme('love')]),
          value: [theme('love'), theme('war')],
          pendingDropped: [],
          // Ответ связал только Бориса; связь Анны с «love» - у хода.
          pendingLinks: { characters: { boris: ['war'] }, keyQuotes: {} },
        }),
      ],
      { characters: { anna: ['love'] }, keyQuotes: {} },
      { characters: true },
      { characters: blockPrint([ANNA, BORIS]) },
    );
    const h = harness(data, stored);
    await h.fields.accept(ROW, 0);
    expect(h.db.stored.characters).toEqual([
      { ...ANNA, themeKeys: ['love'] },
      { ...BORIS, themeKeys: ['war'] },
    ]);
  });
});
