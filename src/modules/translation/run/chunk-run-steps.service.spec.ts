import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { nextSplit } from '../chunking/chapter-chunks';
import { chapterFingerprint } from '../source-fingerprint';
import { pickBoundary } from '../translate/split.stage';
import { checkChunk, ChunkStore, translateChunk } from '../translate/chunk-steps';
import { TRANSLATE_STAGE } from '../translate/translate.constants';
import { AssemblyRunStepsService } from './assembly-run-steps.service';
import { ChunkRunStepsService } from './chunk-run-steps.service';
import { LanguageRow, RunStepSupportService } from './run-step-support.service';
import { CHUNK_STATUS_UNEXPECTED, RUN_TX_OPTIONS } from './translation-run.constants';

jest.mock('../chunking/chapter-chunks', () => ({
  ...jest.requireActual<Record<string, unknown>>('../chunking/chapter-chunks'),
  nextSplit: jest.fn(),
}));
jest.mock('../translate/split.stage', () => ({
  ...jest.requireActual<Record<string, unknown>>('../translate/split.stage'),
  pickBoundary: jest.fn(),
}));
jest.mock('../translate/chunk-steps', () => ({
  ...jest.requireActual<Record<string, unknown>>('../translate/chunk-steps'),
  translateChunk: jest.fn(),
  checkChunk: jest.fn(),
}));

/**
 * Шаги главы и куска на подменённых базе, общих шагах и шагах куска: устаревшая глава, выбор
 * шага по статусу куска (переведённый кусок второй раз не переводится и не оплачивается),
 * запись в кусок условием статуса с прибавкой стоимости, флаг со счётчиком языка, находки.
 */

const ctx = { renewLease: jest.fn().mockResolvedValue(undefined) } as unknown as LlmTaskContext;
const lang = {
  id: 'l1',
  glossaryId: 'g1',
  splitPicks: {},
  run: {
    id: 'r1',
    bookVersionId: 'v1',
    dossierId: 'd1',
    operationId: 'op1',
    stageModels: null,
    operation: { settingsSnapshot: null },
  },
} as unknown as LanguageRow;
const CONTENT = '<p>One.</p>';
const translateMock = translateChunk as jest.Mock;
const checkMock = checkChunk as jest.Mock;

function setup(
  chapter: { content: string } | null,
  chunks: unknown[],
  nextChapter: unknown = null,
) {
  const tx = {
    translationChunk: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    translationRunLanguage: { update: jest.fn().mockResolvedValue({}) },
    bookGlossary: { update: jest.fn().mockResolvedValue({}) },
    bookDossier: { findUnique: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const db = {
    chapter: {
      findUnique: jest.fn().mockResolvedValue(chapter),
      findFirst: jest.fn().mockResolvedValue(nextChapter),
    },
    translationChunk: {
      findMany: jest.fn().mockResolvedValue(chunks),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'c1', rawResponse: null }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    translationRunLanguage: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const support = {
    pauseStale: jest.fn().mockResolvedValue({ kind: 'continue' }),
    pauseNoProvider: jest.fn().mockResolvedValue({ kind: 'continue' }),
    stopRun: jest.fn().mockResolvedValue({ kind: 'continue' }),
    isStale: jest.fn().mockResolvedValue(false),
    contextOf: jest.fn().mockResolvedValue({ dossier: null, glossary: null }),
  };
  const assembly = { assemblyStep: jest.fn().mockResolvedValue({ kind: 'continue' }) };
  const steps = new ChunkRunStepsService(
    db as unknown as PrismaService,
    {} as LlmService,
    support as unknown as RunStepSupportService,
    assembly as unknown as AssemblyRunStepsService,
  );
  return { steps, db, tx, support, assembly };
}

const chunk = (status: string, patch: Record<string, unknown> = {}) => ({
  id: 'c1',
  status,
  costUsd: null,
  chapterFingerprint: chapterFingerprint(CONTENT),
  ...patch,
});

/** Хранилище, которое шаг передал общему шагу куска. */
function storeOf(mock: jest.Mock): ChunkStore {
  return (mock.mock.calls[0] as unknown[])[2] as ChunkStore;
}

const splitMock = nextSplit as jest.Mock;
const pickMock = pickBoundary as jest.Mock;

beforeEach(() => {
  splitMock.mockReset();
  pickMock.mockReset();
  translateMock.mockReset().mockResolvedValue({ kind: 'continue' });
  checkMock.mockReset().mockResolvedValue({ kind: 'continue' });
});

describe('ChunkRunStepsService: выбор шага главы', () => {
  it('главу удалили - пауза устаревшего исходника', async () => {
    const { steps, support } = setup(null, []);
    await steps.chapterStep(lang, 1, ctx);
    expect(support.pauseStale).toHaveBeenCalledTimes(1);
  });

  it('главу правили после нарезки - пауза, модель не зовётся', async () => {
    const { steps, support } = setup({ content: CONTENT }, [
      chunk('pending', { chapterFingerprint: 'other' }),
    ]);
    await steps.chapterStep(lang, 1, ctx);
    expect(support.pauseStale).toHaveBeenCalledTimes(1);
    expect(translateMock).not.toHaveBeenCalled();
  });

  it('нет кусков и исходник устарел до нарезки - пауза, кусков не пишет', async () => {
    const { steps, support, db } = setup({ content: CONTENT }, []);
    support.isStale.mockResolvedValue(true);
    await steps.chapterStep(lang, 1, ctx);
    expect(support.pauseStale).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.update).not.toHaveBeenCalled();
  });

  it('все куски закрыты, глав больше нет - сборка глав', async () => {
    const { steps, assembly } = setup({ content: CONTENT }, [chunk('done'), chunk('flagged')]);
    await steps.chapterStep(lang, 1, ctx);
    expect(assembly.assemblyStep).toHaveBeenCalledTimes(1);
  });

  it('все куски закрыты, глава есть - язык переходит к следующей', async () => {
    const { steps, db, assembly } = setup({ content: CONTENT }, [chunk('done')], { number: 2 });
    await steps.chapterStep(lang, 1, ctx);
    expect(db.translationRunLanguage.update).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { chapterNumber: 2, splitPicks: {} },
    });
    expect(assembly.assemblyStep).not.toHaveBeenCalled();
  });

  it('неожиданный статус куска - пауза STEP_FAILED, а не платный вызов', async () => {
    const { steps, support } = setup({ content: CONTENT }, [chunk('weird')]);
    await steps.chapterStep(lang, 1, ctx);
    expect(support.stopRun).toHaveBeenCalledTimes(1);
    expect(support.stopRun).toHaveBeenCalledWith(lang, 'STEP_FAILED', {
      reason: CHUNK_STATUS_UNEXPECTED,
    });
    expect(translateMock).not.toHaveBeenCalled();
    expect(checkMock).not.toHaveBeenCalled();
  });
});

describe('ChunkRunStepsService: перевод и проверка куска', () => {
  it('кусок pending - перевод, проверка не зовётся', async () => {
    const { steps } = setup({ content: CONTENT }, [chunk('pending')]);
    await steps.chapterStep(lang, 1, ctx);
    expect(translateMock).toHaveBeenCalledTimes(1);
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('кусок уже переведён (повтор после падения) - только проверка, перевод не оплачивается', async () => {
    const { steps } = setup({ content: CONTENT }, [chunk('translated')]);
    await steps.chapterStep(lang, 1, ctx);
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(translateMock).not.toHaveBeenCalled();
  });

  it('все модели этапа отказали по политике - пауза этапа с его моделями', async () => {
    const { steps, support } = setup({ content: CONTENT }, [chunk('pending')]);
    const models = { model: 'm', fallbacks: [] };
    translateMock.mockResolvedValue({ kind: 'no_provider', stage: TRANSLATE_STAGE, models });
    await steps.chapterStep(lang, 1, ctx);
    expect(support.pauseNoProvider).toHaveBeenCalledTimes(1);
    expect(support.pauseNoProvider).toHaveBeenCalledWith(lang, TRANSLATE_STAGE, models);
  });

  it('запись шага - условием статуса, стоимость прибавляется к уже оплаченной', async () => {
    const paid = new Prisma.Decimal('0.5');
    const { steps, db } = setup({ content: CONTENT }, [chunk('pending', { costUsd: paid })]);
    await steps.chapterStep(lang, 1, ctx);
    await storeOf(translateMock).write('pending', {
      status: 'translated',
      costUsd: new Prisma.Decimal('0.25'),
      attempt: true,
    });
    expect(db.translationChunk.updateMany).toHaveBeenCalledTimes(1);
    expect(db.translationChunk.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: 'pending' },
      data: {
        status: 'translated',
        costUsd: { increment: new Prisma.Decimal('0.25') },
        attempts: { increment: 1 },
      },
    });
  });

  it('флаг куска - вместе со счётчиком флагов языка одной транзакцией', async () => {
    const { steps, tx } = setup({ content: CONTENT }, [chunk('translated')]);
    await steps.chapterStep(lang, 1, ctx);
    await storeOf(checkMock).flag('translated', 'CHECK_FAILED', {});
    expect(tx.translationChunk.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationChunk.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: 'translated' },
      data: { status: 'flagged', flagReason: 'CHECK_FAILED' },
    });
    expect(tx.translationRunLanguage.update).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { flaggedChunks: { increment: 1 } },
    });
  });

  it('флаг повтором шага (кусок уже не в статусе) - счётчик второй раз не растёт', async () => {
    const { steps, tx } = setup({ content: CONTENT }, [chunk('translated')]);
    tx.translationChunk.updateMany.mockResolvedValue({ count: 0 });
    await steps.chapterStep(lang, 1, ctx);
    await storeOf(checkMock).flag('translated', 'CHECK_FAILED', {});
    expect(tx.translationRunLanguage.update).not.toHaveBeenCalled();
  });

  it('кусок проверен - находки под замком глоссария, кусок checked → done той же транзакцией', async () => {
    const { steps, tx, db } = setup({ content: CONTENT }, [chunk('checked')]);
    await steps.chapterStep(lang, 1, ctx);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.translationChunk.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationChunk.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: 'checked' },
      data: { status: 'done' },
    });
    expect(translateMock).not.toHaveBeenCalled();
    expect(checkMock).not.toHaveBeenCalled();
  });
});

describe('ChunkRunStepsService: запись и находки куска (полные поля)', () => {
  it('запись шага переносит ответ, блоки, модель, вызов и вердикт', async () => {
    const { steps, db } = setup({ content: CONTENT }, [chunk('pending')]);
    await steps.chapterStep(lang, 1, ctx);
    await storeOf(translateMock).write('pending', {
      rawResponse: { a: 1 },
      blocks: [{ n: 1, text: 'x' }],
      model: 'm/x',
      callId: 'call1',
      verdict: { seed: 7, failures: 1, remarks: ['r'], attempts: [] },
    });
    expect(db.translationChunk.updateMany).toHaveBeenCalledTimes(1);
    expect(db.translationChunk.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: 'pending' },
      data: {
        rawResponse: { a: 1 },
        blocks: [{ n: 1, text: 'x' }],
        model: 'm/x',
        callId: 'call1',
        verdict: { seed: 7, failures: 1, remarks: ['r'], attempts: [] },
      },
    });
  });

  it('новая находка уходит в глоссарий языка, известное написание не дублируется', async () => {
    const { steps, db, tx } = setup({ content: CONTENT }, [chunk('checked')]);
    db.translationChunk.findUniqueOrThrow.mockResolvedValue({
      id: 'c1',
      rawResponse: {
        glossaryFindings: [
          { source: 'Old Mill', target: 'Viejo Molino', kind: 'place', note: '' },
          { source: 'Known One', target: 'Conocido', kind: 'person', note: '' },
        ],
      },
    });
    tx.$queryRaw.mockResolvedValue([
      {
        data: {
          entries: [{ key: 'k', source: 'known one', target: 'Conocido', kind: 'person' }],
        },
        history: [],
      },
    ]);
    await steps.chapterStep(lang, 1, ctx);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), RUN_TX_OPTIONS);
    expect(tx.bookGlossary.update).toHaveBeenCalledTimes(1);
    expect(tx.bookGlossary.update.mock.calls[0][0].where).toEqual({ id: 'g1' });
    expect(tx.translationChunk.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationChunk.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: 'checked' },
      data: { status: 'done' },
    });
    const data = tx.bookGlossary.update.mock.calls[0][0].data as {
      data: { entries: Array<{ source: string }> };
      history: Array<{ chunkId: string }>;
    };
    expect(data.data.entries.map((e) => e.source)).toEqual(['known one', 'Old Mill']);
    expect(data.history).toEqual([expect.objectContaining({ chunkId: 'c1' })]);
  });

  it('все находки уже известны - глоссарий не переписывается, кусок всё равно done', async () => {
    const { steps, db, tx } = setup({ content: CONTENT }, [chunk('checked')]);
    db.translationChunk.findUniqueOrThrow.mockResolvedValue({
      id: 'c1',
      rawResponse: {
        glossaryFindings: [{ source: 'Known One', target: 'Otro', kind: 'person', note: '' }],
      },
    });
    tx.$queryRaw.mockResolvedValue([
      {
        data: {
          entries: [{ key: 'k', source: 'known one', target: 'Conocido', kind: 'person' }],
        },
        history: [],
      },
    ]);
    await steps.chapterStep(lang, 1, ctx);
    expect(tx.bookGlossary.update).not.toHaveBeenCalled();
    expect(tx.translationChunk.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationChunk.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: 'checked' },
      data: { status: 'done' },
    });
  });

  it('флаг куска - транзакция с опциями запуска', async () => {
    const { steps, db } = setup({ content: CONTENT }, [chunk('translated')]);
    await steps.chapterStep(lang, 1, ctx);
    await storeOf(checkMock).flag('translated', 'CHECK_FAILED', {});
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), RUN_TX_OPTIONS);
  });
});

describe('ChunkRunStepsService: нарезка главы', () => {
  const started = { ...lang, splitPicks: { '0': 1 } } as unknown as LanguageRow;

  it('спорный стык - выбор модели дописывается к прежним в язык, куски не пишутся', async () => {
    const { steps, db } = setup({ content: CONTENT }, []);
    const window = { candidates: [] };
    splitMock.mockResolvedValue({ open: { key: '3', window } });
    pickMock.mockResolvedValue(4);
    await expect(steps.chapterStep(started, 1, ctx)).resolves.toEqual({ kind: 'continue' });
    expect(splitMock).toHaveBeenCalledTimes(1);
    expect(pickMock).toHaveBeenCalledTimes(1);
    expect(pickMock).toHaveBeenCalledWith({}, 'op1', window, ctx, {});
    expect(db.translationRunLanguage.update).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { splitPicks: { '0': 1, '3': 4 } },
    });
    expect(db.translationChunk.createMany).not.toHaveBeenCalled();
  });

  it('нарезка с одного шага - исходник сверяется один раз, куски с отпечатком главы', async () => {
    const { steps, db, support } = setup({ content: CONTENT }, []);
    splitMock.mockResolvedValue({ chunks: [{ firstBlock: 0, lastBlock: 0, words: 1 }] });
    await steps.chapterStep(lang, 1, ctx);
    expect(support.isStale).toHaveBeenCalledTimes(1);
    expect(db.translationChunk.createMany).toHaveBeenCalledTimes(1);
    expect(db.translationChunk.createMany).toHaveBeenCalledWith({
      data: [
        {
          runLanguageId: 'l1',
          chapterNumber: 1,
          chunkIndex: 0,
          firstBlock: 0,
          lastBlock: 0,
          words: 1,
          chapterFingerprint: chapterFingerprint(CONTENT),
        },
      ],
      skipDuplicates: true,
    });
  });

  it('нарезка шла несколько шагов, исходник тот же - сверка перед записью, куски пишутся', async () => {
    const { steps, db, support } = setup({ content: CONTENT }, []);
    splitMock.mockResolvedValue({ chunks: [{ firstBlock: 0, lastBlock: 0, words: 1 }] });
    await steps.chapterStep(started, 1, ctx);
    expect(support.isStale).toHaveBeenCalledTimes(1);
    expect(support.pauseStale).not.toHaveBeenCalled();
    expect(db.translationChunk.createMany).toHaveBeenCalledTimes(1);
  });

  it('нарезка шла несколько шагов и исходник правили - пауза, куски не пишутся', async () => {
    const { steps, db, support } = setup({ content: CONTENT }, []);
    splitMock.mockResolvedValue({ chunks: [{ firstBlock: 0, lastBlock: 0, words: 1 }] });
    support.isStale.mockResolvedValue(true);
    await steps.chapterStep(started, 1, ctx);
    expect(support.pauseStale).toHaveBeenCalledTimes(1);
    expect(support.pauseStale).toHaveBeenCalledWith(started);
    expect(db.translationChunk.createMany).not.toHaveBeenCalled();
  });

  it('глава без блоков - один пустой кусок', async () => {
    const { steps, db } = setup({ content: '' }, []);
    splitMock.mockResolvedValue({ chunks: [] });
    await steps.chapterStep(lang, 1, ctx);
    expect(db.translationChunk.createMany).toHaveBeenCalledTimes(1);
    expect(db.translationChunk.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ chunkIndex: 0, firstBlock: 0, lastBlock: 0, words: 0 })],
      skipDuplicates: true,
    });
  });
});
