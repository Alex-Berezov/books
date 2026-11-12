import { BadRequestException } from '@nestjs/common';
import { EMPTY_BOOK_ANALYSIS, StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import type {
  BookAnalysisService,
  BookAnalysisWriteGuard,
} from '../../book-analysis/book-analysis.service';
import type { UpdateBookAnalysisDto } from '../../book-analysis/dto/update-book-analysis.dto';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  ANALYSIS_TARGETS,
  analysisDataJson,
  AnalysisWriteData,
  blockPrint,
  emptyAnalysisData,
  readAnalysisData,
  targetValue,
} from './analysis-write.data';
import { analysisRunGate, AnalysisWriteFields, PLAN_ATTEMPTS } from './analysis-write.fields';
import { StepRecord, withoutInvalid, withStep } from './analysis-write.handler';
import { quotePrint } from './analysis-write.steps';

/**
 * Запись шага под замком (`features/F07-analysis-autofill/tech.md` §5; `L-019`): решение без
 * замка сверяется под замком вместе со значениями, разошлось - пересборка; отказ проверки ссылок
 * (К4) - блок пути ошибки предложением, годные - повторной записью; строка хода берётся
 * `FOR UPDATE`, данные пишутся условием `building` - отменённый ход ничего не пишет.
 */

const OP = 'op1';
const ANNA = { key: 'anna', name: 'Anna', role: 'main' as const, description: 'd' };
const QUOTE = { text: 'The bell rang.', chapter: 1, interpretation: 'i' };

function startData(stored: StoredBookAnalysis): AnalysisWriteData {
  const owns: AnalysisWriteData['owns'] = {};
  const written: AnalysisWriteData['written'] = {};
  for (const target of ANALYSIS_TARGETS) {
    const value = targetValue(stored, target);
    owns[target] = value === null;
    written[target] = blockPrint(value);
  }
  return emptyAnalysisData(owns, written);
}

const record = (step: 1 | 2 | 3, blocks: Record<string, unknown>): StepRecord => ({
  step: {
    step,
    verdict: 'ok',
    remarks: [],
    attempt: 1,
    outcome: 'done',
    failedReason: null,
    authorModel: 'z-ai/glm-5.3',
    review: { kind: 'answered', model: 'openai/gpt-6-luna' },
    source: 'text',
    dropped: [],
  },
  draft: { blocks, themeLinks: null, droppedQuotes: [], fixes: [] },
  invalid: new Set(),
  review: { kind: 'answered', model: 'openai/gpt-6-luna' },
});

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
  raws: string[];
}

/**
 * Подменённая база: строка хода, анализ версии и запись `saveGuarded` тем же порядком, что сервис
 * анализа (`allow` под замком → запись поверх → `done` с перечитанным). `onSave` - вмешательство
 * между чтением без замка и замком (редактор, отмена, отказ ссылок).
 */
function harness(
  data: AnalysisWriteData,
  stored: StoredBookAnalysis = EMPTY_BOOK_ANALYSIS,
  onSave: (db: Db, call: number, dto: UpdateBookAnalysisDto) => void = () => undefined,
  afterAllow: (db: Db) => void = () => undefined,
) {
  const db: Db = {
    row: {
      id: 'd1',
      bookVersionId: 'v1',
      kind: 'analysis_write',
      status: 'building',
      operationId: OP,
      data: JSON.parse(JSON.stringify(analysisDataJson(data))) as unknown,
    },
    stored,
    published: false,
    raws: [],
  };
  const tx = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      db.raws.push(strings.join('?'));
      return Promise.resolve([]);
    }),
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
  const saveGuarded = jest.fn(
    async (_id: string, dto: UpdateBookAnalysisDto, guard: BookAnalysisWriteGuard) => {
      calls += 1;
      onSave(db, calls, dto);
      if (!(await guard.allow(tx as never, db.stored))) return false;
      afterAllow(db);
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
  const settle = (step: 1 | 2 | 3) =>
    fields.settleStep({ id: 'd1', bookVersionId: 'v1', language: 'en' }, analysisRunGate(OP), step);
  const run = () => readAnalysisData(db.row.data);
  return { db, fields, settle, run, saveGuarded, tx, prisma };
}

const outcomes = (data: AnalysisWriteData) => data.items.map((i) => [i.target, i.outcome]);

describe('AnalysisWriteFields.settleStep', () => {
  it('the row is taken FOR UPDATE and the run data is written only while building (L-019)', async () => {
    const h = harness(withStep(startData(EMPTY_BOOK_ANALYSIS), record(1, { characters: [ANNA] })));
    await expect(h.settle(1)).resolves.toBe('settled');
    expect(h.db.raws.some((r) => r.includes('"ContentDraft"') && r.includes('FOR UPDATE'))).toBe(
      true,
    );
    expect(h.tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(h.tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'd1', status: 'building', operationId: OP } }),
    );
    expect(outcomes(h.run())).toEqual([['characters', 'written']]);
    expect(h.db.stored.characters).toEqual([ANNA]);
  });

  it('a block the step writes notes the model text on the version; proposals only do not (T184)', async () => {
    const h = harness(withStep(startData(EMPTY_BOOK_ANALYSIS), record(1, { characters: [ANNA] })));
    await h.settle(1);
    expect(h.tx.bookVersion.update).toHaveBeenCalledTimes(1);
    expect(h.tx.bookVersion.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { analysisAutoTextAt: expect.any(Date) as Date },
    });

    const refused = harness(
      withStep(startData(EMPTY_BOOK_ANALYSIS), record(1, { characters: [ANNA] })),
      EMPTY_BOOK_ANALYSIS,
      () => {
        throw new BadRequestException(['characters.0.name: broken']);
      },
    );
    await refused.settle(1);
    expect(outcomes(refused.run())).toEqual([['characters', 'proposed']]);
    expect(refused.tx.bookVersion.update).not.toHaveBeenCalled();
  });

  it('cancelled between the decision and the write: nothing of the run is written - gone', async () => {
    const h = harness(
      withStep(startData(EMPTY_BOOK_ANALYSIS), record(1, { characters: [ANNA] })),
      EMPTY_BOOK_ANALYSIS,
      () => undefined,
      (db) => {
        db.row.status = 'failed';
      },
    );
    await expect(h.settle(1)).resolves.toBe('gone');
    expect(outcomes(h.run())).toEqual([['characters', 'waiting']]);
  });

  it('a cancelled run before the lock: no write at all', async () => {
    const h = harness(
      withStep(startData(EMPTY_BOOK_ANALYSIS), record(1, { characters: [ANNA] })),
      EMPTY_BOOK_ANALYSIS,
      (db) => {
        db.row.status = 'failed';
      },
    );
    await expect(h.settle(1)).resolves.toBe('gone');
    expect(h.db.stored.characters).toBeNull();
  });

  it('the editor saved the block between the read and the lock: allow refuses, the replan proposes it', async () => {
    const edited = [{ ...ANNA, description: 'edited' }];
    const h = harness(
      withStep(
        startData(EMPTY_BOOK_ANALYSIS),
        record(1, { facts: { settingPlace: 'Town' }, characters: [ANNA] }),
      ),
      EMPTY_BOOK_ANALYSIS,
      (db, call) => {
        if (call === 1) db.stored = { ...db.stored, characters: edited };
      },
    );
    await expect(h.settle(1)).resolves.toBe('settled');
    expect(h.saveGuarded).toHaveBeenCalledTimes(2);
    const run = h.run();
    expect(outcomes(run)).toEqual([
      ['facts.settingPlace', 'written'],
      ['characters', 'proposed'],
    ]);
    expect(run.items[1].hash).toBe(blockPrint(edited));
    expect(h.db.stored.characters).toEqual(edited);
  });

  it('same partition, other value: the themeKeys proposal is rebuilt from the blocks read under the lock', async () => {
    const stored: StoredBookAnalysis = { ...EMPTY_BOOK_ANALYSIS, characters: [ANNA] };
    const themes = [{ key: 'loss', title: 'Loss', interpretation: 'i' }];
    let data = withStep(startData(stored), {
      ...record(3, { themes }),
      draft: {
        blocks: { themes },
        themeLinks: { characters: { anna: ['loss'] }, keyQuotes: {} },
        droppedQuotes: [],
        fixes: [],
      },
    });
    data = { ...data, owns: { ...data.owns, characters: false } };
    const edited = [{ ...ANNA, description: 'edited' }];
    const h = harness(data, stored, (db, call) => {
      if (call === 1) db.stored = { ...db.stored, characters: edited };
    });
    await expect(h.settle(3)).resolves.toBe('settled');
    expect(h.saveGuarded).toHaveBeenCalledTimes(2);
    const links = h.run().items.find((i) => i.links);
    expect(links).toMatchObject({
      outcome: 'proposed',
      value: [{ ...ANNA, description: 'edited', themeKeys: ['loss'] }],
      hash: blockPrint(edited),
    });
  });

  it('К4: the refs check refuses - the block of the error path is a proposal with the path, the good block is written', async () => {
    const h = harness(
      withStep(
        startData(EMPTY_BOOK_ANALYSIS),
        record(2, {
          keyQuotes: [{ ...QUOTE, speakerKey: 'ghost' }],
          style: [{ device: 'd', explanation: 'e' }],
        }),
      ),
      EMPTY_BOOK_ANALYSIS,
      (_db, _call, dto) => {
        if (dto.keyQuotes) {
          throw new BadRequestException(['keyQuotes.0.speakerKey: unknown character key "ghost"']);
        }
      },
    );
    await expect(h.settle(2)).resolves.toBe('settled');
    expect(h.saveGuarded).toHaveBeenCalledTimes(2);
    const run = h.run();
    expect(outcomes(run)).toEqual([
      ['keyQuotes', 'proposed'],
      ['style', 'written'],
    ]);
    expect(run.items[0].remarks).toEqual([
      expect.objectContaining({ code: 'IMPORT_INVALID', where: 'keyQuotes.0.speakerKey' }),
    ]);
    expect(run.items[1].remarks).toEqual([]);
    expect(h.db.stored.style).toEqual([{ device: 'd', explanation: 'e' }]);
    expect(h.db.stored.keyQuotes).toBeNull();
  });

  it('К4: a second refusal - everything is a proposal, nothing is written', async () => {
    const h = harness(
      withStep(
        startData(EMPTY_BOOK_ANALYSIS),
        record(2, { keyQuotes: [QUOTE], style: [{ device: 'd', explanation: 'e' }] }),
      ),
      EMPTY_BOOK_ANALYSIS,
      (_db, call) => {
        throw new BadRequestException([
          call === 1 ? 'keyQuotes.0.speakerKey: unknown' : 'style.0.device: broken',
        ]);
      },
    );
    await expect(h.settle(2)).resolves.toBe('settled');
    expect(h.saveGuarded).toHaveBeenCalledTimes(2);
    expect(outcomes(h.run())).toEqual([
      ['keyQuotes', 'proposed'],
      ['style', 'proposed'],
    ]);
    expect(h.run().items[1].remarks.map((r) => r.code)).toEqual(['IMPORT_INVALID']);
  });

  it('К4: an error path outside the write - everything is a proposal at once', async () => {
    const h = harness(
      withStep(
        startData(EMPTY_BOOK_ANALYSIS),
        record(2, { style: [{ device: 'd', explanation: 'e' }] }),
      ),
      EMPTY_BOOK_ANALYSIS,
      () => {
        throw new BadRequestException(['characters.0.relations.0.to: unknown character key "x"']);
      },
    );
    await expect(h.settle(2)).resolves.toBe('settled');
    expect(h.saveGuarded).toHaveBeenCalledTimes(1);
    expect(outcomes(h.run())).toEqual([['style', 'proposed']]);
  });

  it(`the blocks change on every attempt: after ${PLAN_ATTEMPTS} attempts everything is a proposal`, async () => {
    const h = harness(
      withStep(startData(EMPTY_BOOK_ANALYSIS), record(1, { characters: [ANNA] })),
      EMPTY_BOOK_ANALYSIS,
      (db, call) => {
        db.stored = { ...db.stored, characters: [{ ...ANNA, name: `${call}` }] };
      },
    );
    // Блок меняют до каждого замка: ни одна сверка не сходится.
    h.tx.bookAnalysis.findUnique.mockImplementation(() =>
      Promise.resolve({ ...h.db.stored, characters: null }),
    );
    await expect(h.settle(1)).resolves.toBe('settled');
    expect(h.saveGuarded).toHaveBeenCalledTimes(PLAN_ATTEMPTS);
    expect(outcomes(h.run())).toEqual([['characters', 'proposed']]);
  });
});

describe('IMPORT_INVALID on facts (А2)', () => {
  const FACTS = {
    settingPlace: 'Town',
    settingTime: '1900s',
    narrator: 'third person',
    structure: 'three chapters',
  };
  const invalidOn = (where: string) => ({
    code: 'IMPORT_INVALID' as const,
    where,
    note: 'bad',
    by: 'code' as const,
  });

  it('an error on facts.narrator takes out only that subfield: the other 3 are written', async () => {
    const remarks = [invalidOn('facts.narrator')];
    const { valid, invalid } = withoutInvalid({ facts: FACTS, characters: [ANNA] }, remarks);
    expect(valid).toEqual({
      facts: { settingPlace: 'Town', settingTime: '1900s', structure: 'three chapters' },
      characters: [ANNA],
    });
    const base = record(1, valid);
    const rec: StepRecord = {
      ...base,
      step: { ...base.step, verdict: 'flags', remarks },
      invalid,
    };
    const h = harness(withStep(startData(EMPTY_BOOK_ANALYSIS), rec));
    await expect(h.settle(1)).resolves.toBe('settled');
    expect(outcomes(h.run())).toEqual([
      ['facts.settingPlace', 'written'],
      ['facts.settingTime', 'written'],
      ['facts.narrator', 'none'],
      ['facts.structure', 'written'],
      ['characters', 'written'],
    ]);
    expect(h.run().items.find((i) => i.target === 'facts.narrator')?.failedReason).toBe(
      'IMPORT_INVALID',
    );
    expect(h.db.stored.facts).toMatchObject({
      settingPlace: 'Town',
      settingTime: '1900s',
      structure: 'three chapters',
    });
    expect(h.db.stored.facts?.narrator ?? null).toBeNull();
  });

  it('an error on facts without a subfield takes out the whole facts; other blocks - by the block', () => {
    const whole = withoutInvalid({ facts: FACTS, characters: [ANNA] }, [invalidOn('facts')]);
    expect(whole.valid).toEqual({ characters: [ANNA] });
    const cast = withoutInvalid({ facts: FACTS, characters: [ANNA] }, [
      invalidOn('characters[0].relations[0].key'),
    ]);
    expect(cast.valid).toEqual({ facts: FACTS });
  });
});

describe('AnalysisWriteFields.mutate', () => {
  it('fn = null - "not written" is its own outcome, not a success', async () => {
    const h = harness(startData(EMPTY_BOOK_ANALYSIS));
    const row = { id: 'd1', bookVersionId: 'v1' };
    await expect(h.fields.mutate(row, analysisRunGate(OP), () => null)).resolves.toMatchObject({
      written: false,
    });
    await expect(h.fields.mutate(row, analysisRunGate(OP), (d) => d)).resolves.toMatchObject({
      written: true,
    });
    h.db.row.status = 'failed';
    await expect(h.fields.mutate(row, analysisRunGate(OP), (d) => d)).resolves.toBeNull();
  });
});

describe('AnalysisWriteFields.markCore', () => {
  const CORE: StoredBookAnalysis = {
    ...EMPTY_BOOK_ANALYSIS,
    characters: [
      { key: 'a', name: 'A', role: 'main', description: 'd' },
      { key: 'b', name: 'B', role: 'secondary', description: 'd' },
    ],
    keyQuotes: ['1', '2', '3'].map((text) => ({ text, interpretation: 'i' })),
    mainIdea: 'Idea.',
    themes: [
      { key: 'x', title: 'X', interpretation: 'i' },
      { key: 'y', title: 'Y', interpretation: 'i' },
    ],
  };
  const NO_THEMES: StoredBookAnalysis = { ...CORE, themes: null };

  /**
   * Б3: анализ меняется между чтением без замка и замком - флаг ставится по анализу под замком,
   * прочитанному через `tx` той же транзакции, что запись флага, а не по чтению до неё.
   */
  it.each([
    [
      'the editor removed the themes after the read without the lock: CORE_MISSING',
      CORE,
      NO_THEMES,
      ['CORE_MISSING'],
      'flags',
    ],
    ['the themes came after the read without the lock: no CORE_MISSING', NO_THEMES, CORE, [], 'ok'],
  ] as const)('%s', async (_name, before, underLock, codes, verdict) => {
    const h = harness(withStep(startData(EMPTY_BOOK_ANALYSIS), record(3, {})), underLock);
    h.prisma.bookAnalysis = { findUnique: jest.fn(() => Promise.resolve({ ...before })) };
    await expect(
      h.fields.markCore({ id: 'd1', bookVersionId: 'v1' }, analysisRunGate(OP)),
    ).resolves.toBe(true);
    const step3 = h.run().steps.find((s) => s.step === 3);
    expect(step3?.remarks.map((r) => r.code)).toEqual(codes);
    expect(step3?.verdict).toBe(verdict);
    expect(h.prisma.bookAnalysis.findUnique).not.toHaveBeenCalled();
    expect(h.tx.bookAnalysis.findUnique).toHaveBeenCalledTimes(1);
  });

  it('the run is gone under the lock: null, nothing is written', async () => {
    const h = harness(withStep(startData(EMPTY_BOOK_ANALYSIS), record(3, {})), CORE);
    h.db.row.status = 'failed';
    await expect(
      h.fields.markCore({ id: 'd1', bookVersionId: 'v1' }, analysisRunGate(OP)),
    ).resolves.toBeNull();
    expect(h.tx.contentDraft.updateMany).not.toHaveBeenCalled();
  });
});

describe('themeKeys limit', () => {
  it('LIMIT_OUT: themeKeys over the import limit after the merge are cut with the reason', async () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const stored: StoredBookAnalysis = {
      ...EMPTY_BOOK_ANALYSIS,
      characters: [{ ...ANNA, themeKeys: many }],
      keyQuotes: [QUOTE],
    };
    const themes = ['x', 'y', 'z', ...many].map((key) => ({
      key,
      title: key,
      interpretation: 'i',
    }));
    const data = withStep(startData(stored), {
      ...record(3, { themes }),
      draft: {
        blocks: { themes },
        themeLinks: {
          characters: { anna: ['x', 'y', 'z'] },
          keyQuotes: { [quotePrint(QUOTE.text)]: ['x'] },
        },
        droppedQuotes: [],
        fixes: [],
      },
    });
    const h = harness({ ...data, owns: { ...data.owns, characters: false } }, stored);
    await h.settle(3);
    const run = h.run();
    const links = run.items.find((i) => i.links && i.target === 'characters');
    expect((links?.value as Array<{ themeKeys: string[] }>)[0].themeKeys).toEqual([...many, 'x']);
    expect(run.steps[0].dropped).toEqual([
      expect.objectContaining({ code: 'LIMIT_OUT', path: 'characters.anna.themeKeys' }),
    ]);
  });
});
