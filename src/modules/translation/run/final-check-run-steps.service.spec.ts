import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { addChapterFindings } from '../assemble/chapter-findings';
import { callIndependent } from '../check/independent-call';
import { finalCodeCheck } from '../final-check/final-check-code';
import { FINAL_CHECK_STAGE, FINAL_FINDING_CODES } from '../final-check/final-check.constants';
import { FinalCheckRunStepsService } from './final-check-run-steps.service';
import { MetadataDraftRunStepsService } from './metadata-draft-run-steps.service';
import { LanguageRow, RunStepSupportService } from './run-step-support.service';

jest.mock('../final-check/final-check-code', () => ({
  ...jest.requireActual<Record<string, unknown>>('../final-check/final-check-code'),
  finalCodeCheck: jest.fn(),
}));
jest.mock('../check/independent-call', () => ({
  ...jest.requireActual<Record<string, unknown>>('../check/independent-call'),
  callIndependent: jest.fn(),
}));
jest.mock('../assemble/chapter-input', () => ({
  ...jest.requireActual<Record<string, unknown>>('../assemble/chapter-input'),
  chapterAssemblyInput: jest.fn().mockResolvedValue({
    content: '<p>One.</p>',
    chunks: [{ blocks: [{ n: 0, text: 'Uno.' }], model: 'translator/a' }],
  }),
}));
jest.mock('../assemble/chapter-assembly', () => ({
  ...jest.requireActual<Record<string, unknown>>('../assemble/chapter-assembly'),
  assembleTranslatedChapter: jest.fn().mockReturnValue({ status: 'assembled', content: 'Uno.' }),
}));
jest.mock('../final-check/final-check.prompts', () => ({
  ...jest.requireActual<Record<string, unknown>>('../final-check/final-check.prompts'),
  finalCheckInputOf: jest.fn().mockReturnValue({ blocks: [0] }),
  finalCheckRequest: jest.fn().mockReturnValue({}),
}));
jest.mock('../assemble/chapter-findings', () => ({
  ...jest.requireActual<Record<string, unknown>>('../assemble/chapter-findings'),
  addChapterFindings: jest.fn().mockResolvedValue(undefined),
}));

/**
 * Итоговая проверка на подменённых базе и вызове модели: выбор шага (пропуск, кодом, моделью,
 * затем `metadata`), оплаченный ответ пишется в состояние языка вместе с находкой главы, нет
 * моделей по политике - пауза этапа.
 */

const callMock = callIndependent as jest.Mock;
const findingsMock = addChapterFindings as jest.Mock;
const CODE_DONE = { code: { missing: [] }, chapters: [], done: false };

const lang = (finalCheck: unknown, metadata: unknown = null) =>
  ({
    id: 'l1',
    finalCheck,
    metadata,
    glossaryId: 'g1',
    run: {
      id: 'r1',
      operationId: 'op1',
      bookVersionId: 'v1',
      sourceLanguage: 'en',
      stageModels: null,
      operation: { settingsSnapshot: null },
    },
  }) as unknown as LanguageRow;

const chapterRow = { id: 'ch1', chapterNumber: 1, findings: [], flagReason: null };

function setup(row: unknown = null) {
  const tx = {
    translationRunLanguage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: jest.fn().mockResolvedValue([{ finalCheck: null }]),
  };
  const db = {
    chapter: { findMany: jest.fn().mockResolvedValue([{ number: 1, content: '<p>One.</p>' }]) },
    translationChunk: { findMany: jest.fn().mockResolvedValue([]) },
    translationChapter: {
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([{ ...chapterRow, status: 'flagged' }]),
    },
    translationRunLanguage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const support = {
    pauseStale: jest.fn().mockResolvedValue({ kind: 'continue' }),
    pauseNoProvider: jest.fn().mockResolvedValue({ kind: 'continue' }),
    contextOf: jest.fn().mockResolvedValue({ dossier: null, glossary: null }),
  };
  const metadataDraft = { metadataStep: jest.fn().mockResolvedValue({ kind: 'continue' }) };
  const ctx = { renewLease: jest.fn().mockResolvedValue(undefined) };
  const steps = new FinalCheckRunStepsService(
    db as unknown as PrismaService,
    {} as LlmService,
    support as unknown as RunStepSupportService,
    metadataDraft as unknown as MetadataDraftRunStepsService,
  );
  return { steps, db, tx, support, metadataDraft, ctx: ctx as unknown as LlmTaskContext };
}

beforeEach(() => {
  callMock.mockReset();
  findingsMock.mockClear();
});

describe('FinalCheckRunStepsService: выбор шага', () => {
  it('проверка закончена - сразу этап metadata', async () => {
    const { steps, metadataDraft, ctx } = setup();
    await steps.finalCheckStep(lang({ ...CODE_DONE, done: true }), ctx);
    expect(metadataDraft.metadataStep).toHaveBeenCalledTimes(1);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('язык с начатым metadata без итоговой проверки её не догоняет', async () => {
    const { steps, metadataDraft, ctx } = setup();
    await steps.finalCheckStep(lang(null, { attempts: [], result: null }), ctx);
    expect(metadataDraft.metadataStep).toHaveBeenCalledTimes(1);
  });

  it('глав для модели не осталось - состояние done условием «язык не закрыт»', async () => {
    const { steps, db, metadataDraft, ctx } = setup(null);
    await expect(steps.finalCheckStep(lang(CODE_DONE), ctx)).resolves.toEqual({
      kind: 'continue',
    });
    expect(metadataDraft.metadataStep).not.toHaveBeenCalled();
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1', status: { in: ['pending', 'running'] } },
      data: { finalCheck: { ...CODE_DONE, done: true } },
    });
  });
});

describe('FinalCheckRunStepsService: проверка моделью', () => {
  it('все модели отказали по политике - пауза этапа, состояние не пишется', async () => {
    const { steps, support, tx, ctx } = setup(chapterRow);
    const models = { model: 'm', fallbacks: [] };
    callMock.mockResolvedValue({ kind: 'no_provider', models });
    await steps.finalCheckStep(lang(CODE_DONE), ctx);
    expect(support.pauseNoProvider).toHaveBeenCalledTimes(1);
    expect(support.pauseNoProvider).toHaveBeenCalledWith(
      expect.anything(),
      FINAL_CHECK_STAGE,
      models,
    );
    expect(tx.translationRunLanguage.updateMany).not.toHaveBeenCalled();
  });

  it('ответ модели - глава в состоянии языка с ценой и находка главы одной транзакцией', async () => {
    const { steps, tx, ctx } = setup(chapterRow);
    callMock.mockResolvedValue({
      kind: 'answered',
      answer: { verdict: 'pass', issues: [] },
      model: 'checker/b',
      costUsd: new Prisma.Decimal('0.03'),
    });
    await steps.finalCheckStep(lang(CODE_DONE), ctx);
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    const written = (tx.translationRunLanguage.updateMany.mock.calls[0] as unknown[])[0] as {
      data: { finalCheck: { chapters: unknown[] } };
    };
    expect(written.data.finalCheck.chapters).toEqual([
      { number: 1, model: 'checker/b', costUsd: '0.03', outcome: 'pass' },
    ]);
    expect(findingsMock).toHaveBeenCalledTimes(1);
    expect(findingsMock).toHaveBeenCalledWith(
      tx,
      'l1',
      chapterRow,
      [{ code: FINAL_FINDING_CODES.FINAL_CHECKED, model: 'checker/b', costUsd: '0.03' }],
      { where: { status: 'assembled' } },
    );
  });
});

describe('FinalCheckRunStepsService: проверка кодом', () => {
  const codeMock = finalCodeCheck as jest.Mock;
  const found = [{ code: FINAL_FINDING_CODES.CHAPTER_EMPTY }];

  beforeEach(() => {
    codeMock.mockReset().mockReturnValue({ missing: [2], findings: new Map([[1, found]]) });
  });

  it('состояние языка и находки глав - одной транзакцией под замком строки языка', async () => {
    const { steps, tx, ctx } = setup();
    const lease = ctx as unknown as { renewLease: jest.Mock };
    await expect(steps.finalCheckStep(lang(null), ctx)).resolves.toEqual({ kind: 'continue' });
    expect(codeMock).toHaveBeenCalledTimes(1);
    expect(lease.renewLease).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1', status: { in: ['pending', 'running'] } },
      data: { finalCheck: { code: { missing: [2] }, chapters: [], done: false } },
    });
    expect(findingsMock).toHaveBeenCalledTimes(1);
    expect(findingsMock).toHaveBeenCalledWith(
      tx,
      'l1',
      expect.objectContaining({ id: 'ch1' }),
      found,
    );
  });

  it('повтор после потерянной аренды: проверка кодом уже записана - находки второй раз не пишутся', async () => {
    const { steps, tx, ctx } = setup();
    tx.$queryRaw.mockResolvedValue([
      { finalCheck: { code: { missing: [] }, chapters: [], done: false } },
    ]);
    await steps.finalCheckStep(lang(null), ctx);
    expect(tx.translationRunLanguage.updateMany).not.toHaveBeenCalled();
    expect(findingsMock).not.toHaveBeenCalled();
  });

  it('язык уже закрыт - находки не пишутся', async () => {
    const { steps, tx, ctx } = setup();
    tx.translationRunLanguage.updateMany.mockResolvedValue({ count: 0 });
    await steps.finalCheckStep(lang(null), ctx);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(findingsMock).not.toHaveBeenCalled();
  });
});
