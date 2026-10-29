import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { assembleTranslatedChapter } from '../assemble/chapter-assembly';
import { addChapterFindings } from '../assemble/chapter-findings';
import { CHECK_SEMANTIC_STAGE } from '../check/check.constants';
import { callIndependent } from '../check/independent-call';
import { SEAM_FINDING_CODES } from '../check/seam-check';
import { AssemblyRunStepsService } from './assembly-run-steps.service';
import { FinalCheckRunStepsService } from './final-check-run-steps.service';
import { LanguageRow, RunStepSupportService } from './run-step-support.service';

jest.mock('../check/independent-call', () => ({
  ...jest.requireActual<Record<string, unknown>>('../check/independent-call'),
  callIndependent: jest.fn(),
}));
jest.mock('../assemble/chapter-input', () => ({
  ...jest.requireActual<Record<string, unknown>>('../assemble/chapter-input'),
  chapterAssemblyInput: jest.fn().mockResolvedValue({
    content: '<p>One.</p><p>Two.</p>',
    chunks: [
      { firstBlock: 0, lastBlock: 0, blocks: [{ n: 0, text: 'Uno.' }], model: 'a' },
      { firstBlock: 1, lastBlock: 1, blocks: [{ n: 1, text: 'Dos.' }], model: 'a' },
    ],
  }),
}));
jest.mock('../assemble/chapter-assembly', () => ({
  ...jest.requireActual<Record<string, unknown>>('../assemble/chapter-assembly'),
  assembleTranslatedChapter: jest.fn(),
}));
jest.mock('../assemble/chapter-findings', () => ({
  ...jest.requireActual<Record<string, unknown>>('../assemble/chapter-findings'),
  addChapterFindings: jest.fn().mockResolvedValue(undefined),
}));

/**
 * Сборка глав на подменённых базе и вызове модели: порядок (глава со стыками раньше следующей,
 * после последней - итоговая проверка, перед первой - сверка исходника), оплаченный ответ стыка
 * пишется находкой главы, нет моделей по политике - пауза этапа `check_semantic`.
 */

const callMock = callIndependent as jest.Mock;
const findingsMock = addChapterFindings as jest.Mock;
const lang = {
  id: 'l1',
  language: 'es',
  run: {
    id: 'r1',
    bookVersionId: 'v1',
    operationId: 'op1',
    sourceLanguage: 'en',
    stageModels: null,
    operation: { settingsSnapshot: null },
  },
} as unknown as LanguageRow;
const pendingRow = { id: 'ch1', chapterNumber: 1, findings: [], flagReason: null };

function setup(nextChapter: unknown, last: number | null = null, pending: unknown = null) {
  const tx = {
    translationChapter: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    translationRunLanguage: { update: jest.fn().mockResolvedValue({}) },
  };
  const db = {
    translationChapter: {
      findFirst: jest.fn().mockResolvedValue(pending),
      aggregate: jest.fn().mockResolvedValue({ _max: { chapterNumber: last } }),
    },
    chapter: { findFirst: jest.fn().mockResolvedValue(nextChapter) },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const support = {
    isStale: jest.fn().mockResolvedValue(false),
    pauseStale: jest.fn().mockResolvedValue({ kind: 'continue' }),
    pauseNoProvider: jest.fn().mockResolvedValue({ kind: 'continue' }),
  };
  const finalCheck = { finalCheckStep: jest.fn().mockResolvedValue({ kind: 'continue' }) };
  const ctx = { renewLease: jest.fn().mockResolvedValue(undefined) };
  const steps = new AssemblyRunStepsService(
    db as unknown as PrismaService,
    {} as LlmService,
    support as unknown as RunStepSupportService,
    finalCheck as unknown as FinalCheckRunStepsService,
  );
  return { steps, db, tx, support, finalCheck, ctx: ctx as unknown as LlmTaskContext, lease: ctx };
}

beforeEach(() => {
  callMock.mockReset();
  findingsMock.mockClear();
});

describe('AssemblyRunStepsService: порядок', () => {
  it('все главы собраны - итоговая проверка', async () => {
    const { steps, finalCheck, ctx } = setup(null, 3);
    await steps.assemblyStep(lang, ctx);
    expect(finalCheck.finalCheckStep).toHaveBeenCalledTimes(1);
  });

  it('перед первой главой исходник сверяется: устарел - пауза', async () => {
    const { steps, support, finalCheck, ctx } = setup({ number: 1 }, null);
    support.isStale.mockResolvedValue(true);
    await steps.assemblyStep(lang, ctx);
    expect(support.pauseStale).toHaveBeenCalledTimes(1);
    expect(finalCheck.finalCheckStep).not.toHaveBeenCalled();
  });
});

describe('AssemblyRunStepsService: стыки моделью', () => {
  it('все модели отказали по политике - пауза этапа check_semantic, находка не пишется', async () => {
    const { steps, support, ctx } = setup(null, null, pendingRow);
    const models = { model: 'm', fallbacks: [] };
    callMock.mockResolvedValue({ kind: 'no_provider', models });
    await steps.assemblyStep(lang, ctx);
    expect(support.pauseNoProvider).toHaveBeenCalledTimes(1);
    expect(support.pauseNoProvider).toHaveBeenCalledWith(lang, CHECK_SEMANTIC_STAGE, models);
    expect(findingsMock).not.toHaveBeenCalled();
  });

  it('ответ стыка - находка главы с моделью и ценой после продления аренды', async () => {
    const { steps, tx, lease, ctx } = setup(null, null, pendingRow);
    callMock.mockResolvedValue({
      kind: 'answered',
      answer: { verdict: 'pass', problems: [] },
      model: 'checker/b',
      costUsd: new Prisma.Decimal('0.02'),
    });
    await steps.assemblyStep(lang, ctx);
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(lease.renewLease).toHaveBeenCalledTimes(1);
    expect(findingsMock).toHaveBeenCalledTimes(1);
    expect(findingsMock).toHaveBeenCalledWith(
      tx,
      'l1',
      pendingRow,
      [{ code: SEAM_FINDING_CODES.SEAM_CHECKED, seam: 1, model: 'checker/b', costUsd: '0.02' }],
      { where: { status: 'pending' }, flagFrom: [] },
    );
  });
});

describe('AssemblyRunStepsService: сборка главы', () => {
  const assembleMock = assembleTranslatedChapter as jest.Mock;
  const flagged = { status: 'flagged', flagReason: 'CHAPTER_TOO_LONG', length: 9, findings: [] };

  beforeEach(() => assembleMock.mockReset());

  it('глава из нескольких кусков собрана - pending до стыков, флага нет', async () => {
    assembleMock.mockReturnValue({
      status: 'assembled',
      flagReason: null,
      length: 5,
      seamIndex: 2,
      findings: [],
    });
    const { steps, tx, ctx } = setup({ number: 1 }, null);
    await steps.assemblyStep(lang, ctx);
    expect(tx.translationChapter.createMany).toHaveBeenCalledTimes(1);
    expect(tx.translationChapter.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ chapterNumber: 1, status: 'pending', seamIndex: 2 })],
      skipDuplicates: true,
    });
    expect(tx.translationRunLanguage.update).not.toHaveBeenCalled();
  });

  it('глава с флагом - счётчик флагов глав языка той же транзакцией', async () => {
    assembleMock.mockReturnValue(flagged);
    const { steps, tx, ctx } = setup({ number: 1 }, null);
    await steps.assemblyStep(lang, ctx);
    expect(tx.translationChapter.createMany).toHaveBeenCalledTimes(1);
    expect(tx.translationChapter.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ status: 'flagged', seamIndex: null })],
      skipDuplicates: true,
    });
    expect(tx.translationRunLanguage.update).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { flaggedChapters: { increment: 1 } },
    });
  });

  it('повтор шага: строка главы уже есть - флаг второй раз не считается', async () => {
    assembleMock.mockReturnValue(flagged);
    const { steps, tx, ctx } = setup({ number: 1 }, null);
    tx.translationChapter.createMany.mockResolvedValue({ count: 0 });
    await steps.assemblyStep(lang, ctx);
    expect(tx.translationRunLanguage.update).not.toHaveBeenCalled();
  });
});
