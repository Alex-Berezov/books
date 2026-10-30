import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { CREATE_FROM_RUN_REJECTIONS } from '../../book-version/create-from-run';
import { DRAFT_DELETED, NO_CHAPTERS_WRITTEN } from '../draft/draft.constants';
import { TranslationDraftService } from '../draft/translation-draft.service';
import {
  METADATA_ATTEMPTS_MAX,
  METADATA_INVALID,
  METADATA_STAGE,
  METADATA_TOO_LONG,
} from '../metadata/metadata.constants';
import { checkMetadata, MetadataResult } from '../metadata/metadata-check';
import { callMetadata, metadataInputOf, metadataSourceFields } from '../metadata/metadata-step';
import { MetadataDraftRunStepsService } from './metadata-draft-run-steps.service';
import { LanguageRow, RunStepSupportService } from './run-step-support.service';

jest.mock('../metadata/metadata-step', () => ({
  metadataSourceFields: jest.fn().mockResolvedValue({ title: 'T', chapterTitles: [] }),
  metadataInputOf: jest.fn().mockReturnValue({ input: {}, source: {} }),
  callMetadata: jest.fn(),
}));
jest.mock('../metadata/metadata-check', () => ({ checkMetadata: jest.fn() }));

/**
 * Этап `metadata` и черновик на подменённых базе, вызове модели, черновиках и общих шагах:
 * оплаченный ответ пишется в язык до решения, принятый ответ второй раз не оплачивается,
 * отказы закрывают язык своим кодом, нет моделей по политике - пауза этапа.
 */

const metadata = { chapterTitles: [] } as unknown as MetadataResult;
const done = { kind: 'done' } as const;
const callMock = callMetadata as jest.Mock;
const checkMock = checkMetadata as jest.Mock;
const fieldsMock = metadataSourceFields as jest.Mock;
const inputMock = metadataInputOf as jest.Mock;

function lang(patch: Record<string, unknown> = {}): LanguageRow {
  return {
    id: 'l1',
    bookVersionId: null,
    draftCreatedAt: null,
    metadata: null,
    run: {
      id: 'r1',
      operationId: 'op1',
      bookVersionId: 'v1',
      sourceLanguage: 'en',
      stageModels: null,
      operation: { settingsSnapshot: null },
    },
    ...patch,
  } as unknown as LanguageRow;
}

function setup() {
  const db = {
    translationRunLanguage: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const support = {
    failLanguage: jest.fn().mockResolvedValue(done),
    finishLanguage: jest.fn().mockResolvedValue(done),
    pauseStale: jest.fn().mockResolvedValue({ kind: 'continue' }),
    pauseNoProvider: jest.fn().mockResolvedValue({ kind: 'continue' }),
    isStale: jest.fn().mockResolvedValue(false),
    contextOf: jest.fn().mockResolvedValue({ dossier: null, glossary: null }),
  };
  const drafts = {
    nextToWrite: jest.fn().mockResolvedValue({ chapterNumber: 1 }),
    createDraft: jest.fn(),
    writeChapter: jest.fn().mockResolvedValue('written'),
  };
  const ctx = { renewLease: jest.fn().mockResolvedValue(undefined) };
  const steps = new MetadataDraftRunStepsService(
    db as unknown as PrismaService,
    {} as LlmService,
    support as unknown as RunStepSupportService,
    drafts as unknown as TranslationDraftService,
  );
  return { steps, db, support, drafts, ctx: ctx as unknown as LlmTaskContext, lease: ctx };
}

/** Состояние `metadata`, записанное в язык. */
function writtenState(db: ReturnType<typeof setup>['db']) {
  const call = db.translationRunLanguage.updateMany.mock.calls[0] as [
    { data: { metadata: { attempts: Array<{ outcome: string; costUsd: string }> } } },
  ];
  return call[0].data.metadata;
}

beforeEach(() => {
  callMock.mockReset();
  checkMock.mockReset();
  fieldsMock.mockReset().mockResolvedValue({ title: 'T', chapterTitles: [] });
  inputMock.mockReset().mockReturnValue({ input: {}, source: {} });
});

describe('MetadataDraftRunStepsService: этап metadata', () => {
  it('исчерпанные попытки - failed METADATA_INVALID, модель не зовётся', async () => {
    const { steps, support, ctx } = setup();
    const attempts = Array.from({ length: METADATA_ATTEMPTS_MAX }, () => ({
      model: 'm',
      costUsd: '0',
      outcome: 'fail',
      remarks: [],
    }));
    await steps.metadataStep(lang({ metadata: { attempts, result: null } }), ctx);
    expect(support.failLanguage).toHaveBeenCalledTimes(1);
    expect(support.failLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1' }),
      METADATA_INVALID,
    );
    expect(callMock).not.toHaveBeenCalled();
  });

  it('ответ уже принят - черновик, модель второй раз не оплачивается', async () => {
    const { steps, drafts, ctx } = setup();
    drafts.createDraft.mockResolvedValue({ kind: 'created', versionId: 'v2' });
    await steps.metadataStep(lang({ metadata: { attempts: [], result: metadata } }), ctx);
    expect(callMock).not.toHaveBeenCalled();
    expect(drafts.createDraft).toHaveBeenCalledTimes(1);
  });

  it('исходник устарел - пауза до вызова модели', async () => {
    const { steps, support, ctx } = setup();
    support.isStale.mockResolvedValue(true);
    await steps.metadataStep(lang(), ctx);
    expect(support.pauseStale).toHaveBeenCalledTimes(1);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('вход не влезает в контекст - failed METADATA_TOO_LONG', async () => {
    const { steps, support, db, ctx } = setup();
    callMock.mockResolvedValue({ kind: 'too_long' });
    await steps.metadataStep(lang(), ctx);
    expect(support.failLanguage).toHaveBeenCalledTimes(1);
    expect(support.failLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1' }),
      METADATA_TOO_LONG,
    );
    expect(db.translationRunLanguage.updateMany).not.toHaveBeenCalled();
  });

  it('все модели отказали по политике - пауза этапа metadata с его моделями', async () => {
    const { steps, support, ctx } = setup();
    const models = { model: 'm', fallbacks: [] };
    callMock.mockResolvedValue({ kind: 'no_provider', models });
    await steps.metadataStep(lang(), ctx);
    expect(support.pauseNoProvider).toHaveBeenCalledTimes(1);
    expect(support.pauseNoProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1' }),
      METADATA_STAGE,
      models,
    );
  });

  it('ответ принят - пишется в язык после продления аренды, с ценой', async () => {
    const { steps, db, lease, ctx } = setup();
    callMock.mockResolvedValue({
      kind: 'answered',
      answer: {},
      model: 'm',
      costUsd: new Prisma.Decimal('0.1'),
    });
    checkMock.mockReturnValue({ ok: true, result: metadata });
    const result = await steps.metadataStep(lang(), ctx);
    expect(result).toEqual({ kind: 'continue' });
    expect(lease.renewLease).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    const state = writtenState(db);
    expect(state.attempts).toEqual([{ model: 'm', costUsd: '0.1', outcome: 'pass', remarks: [] }]);
  });

  it('ответ не по форме - попытка с ценой записана, затем failed METADATA_INVALID', async () => {
    const { steps, db, support, ctx } = setup();
    callMock.mockResolvedValue({ kind: 'invalid', costUsd: new Prisma.Decimal('0.2') });
    await steps.metadataStep(lang(), ctx);
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(writtenState(db).attempts).toEqual([
      { model: '', costUsd: '0.2', outcome: 'invalid', remarks: [] },
    ]);
    expect(support.failLanguage).toHaveBeenCalledTimes(1);
    expect(support.failLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1' }),
      METADATA_INVALID,
    );
  });

  it('проверка ответа не прошла - попытка fail с замечаниями записана, язык идёт на повтор', async () => {
    const { steps, db, support, ctx } = setup();
    callMock.mockResolvedValue({
      kind: 'answered',
      answer: {},
      model: 'm',
      costUsd: new Prisma.Decimal('0.3'),
    });
    checkMock.mockReturnValue({ ok: false, remarks: ['title too long'] });
    const result = await steps.metadataStep(lang(), ctx);
    expect(result).toEqual({ kind: 'continue' });
    expect(support.failLanguage).not.toHaveBeenCalled();
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1', status: { in: ['pending', 'running'] } },
      data: {
        metadata: {
          attempts: [{ model: 'm', costUsd: '0.3', outcome: 'fail', remarks: ['title too long'] }],
          result: null,
        },
      },
    });
  });

  it('повтор после fail - замечания последней попытки уходят во вход модели', async () => {
    const { steps, ctx } = setup();
    callMock.mockResolvedValue({ kind: 'invalid', costUsd: new Prisma.Decimal('0') });
    const attempts = [{ model: 'm', costUsd: '0.3', outcome: 'fail', remarks: ['title too long'] }];
    await steps.metadataStep(lang({ language: 'de', metadata: { attempts, result: null } }), ctx);
    expect(inputMock).toHaveBeenCalledTimes(1);
    expect(inputMock).toHaveBeenCalledWith(
      { title: 'T', chapterTitles: [], targetLanguage: 'de' },
      { dossier: null, glossary: null },
      ['title too long'],
    );
  });

  it('ответ принят - в язык пишется отпечаток названия, описания и автора исходника', async () => {
    const { steps, db, ctx } = setup();
    fieldsMock.mockResolvedValueOnce({
      title: 'T',
      description: 'D',
      author: 'A',
      chapterTitles: [],
    });
    callMock.mockResolvedValue({
      kind: 'answered',
      answer: {},
      model: 'm',
      costUsd: new Prisma.Decimal('0.1'),
    });
    checkMock.mockReturnValue({ ok: true, result: metadata });
    await steps.metadataStep(lang(), ctx);
    const expected = createHash('sha256')
      .update(JSON.stringify(['T', 'D', 'A']))
      .digest('hex');
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    const state = writtenState(db) as unknown as { sourceHash?: string; result: unknown };
    expect(state.sourceHash).toBe(expected);
    expect(state.result).toBe(metadata);
  });

  it('полей исходника нет - пауза, модель не зовётся, в язык ничего не пишется', async () => {
    const { steps, support, db, ctx } = setup();
    fieldsMock.mockResolvedValueOnce(null);
    const row = lang();
    await steps.metadataStep(row, ctx);
    expect(fieldsMock).toHaveBeenCalledTimes(1);
    expect(fieldsMock).toHaveBeenCalledWith(db, 'v1', 'en');
    expect(support.pauseStale).toHaveBeenCalledTimes(1);
    expect(support.pauseStale).toHaveBeenCalledWith(row);
    expect(callMock).not.toHaveBeenCalled();
    expect(db.translationRunLanguage.updateMany).not.toHaveBeenCalled();
  });
});

describe('MetadataDraftRunStepsService: черновик', () => {
  it('удалённый черновик - failed DRAFT_DELETED', async () => {
    const { steps, support, ctx } = setup();
    await steps.draftStep(lang({ draftCreatedAt: new Date() }), ctx, metadata);
    expect(support.failLanguage).toHaveBeenCalledTimes(1);
    expect(support.failLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1' }),
      DRAFT_DELETED,
    );
  });

  it('нечего писать - failed NO_CHAPTERS_WRITTEN, черновик не создаётся', async () => {
    const { steps, support, drafts, ctx } = setup();
    drafts.nextToWrite.mockResolvedValue(null);
    await steps.draftStep(lang(), ctx, metadata);
    expect(support.failLanguage).toHaveBeenCalledTimes(1);
    expect(support.failLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1' }),
      NO_CHAPTERS_WRITTEN,
    );
    expect(drafts.createDraft).not.toHaveBeenCalled();
  });

  it('исходник устарел до создания версии - пауза', async () => {
    const { steps, support, drafts, ctx } = setup();
    support.isStale.mockResolvedValue(true);
    await steps.draftStep(lang(), ctx, metadata);
    expect(support.pauseStale).toHaveBeenCalledTimes(1);
    expect(drafts.createDraft).not.toHaveBeenCalled();
  });

  it('отказ создания версии - failed с кодом и текстом сервиса', async () => {
    const { steps, support, drafts, ctx } = setup();
    drafts.createDraft.mockResolvedValue({
      kind: 'rejected',
      code: 'CREATE_REJECTED',
      text: 'why',
    });
    await steps.draftStep(lang(), ctx, metadata);
    expect(support.failLanguage).toHaveBeenCalledTimes(1);
    expect(support.failLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1' }),
      'CREATE_REJECTED',
      'why',
    );
  });

  it('VERSION_EXISTS после потерянной аренды, версия своя - шаг продолжается', async () => {
    const { steps, support, drafts, db, ctx } = setup();
    drafts.createDraft.mockResolvedValue({
      kind: 'rejected',
      code: CREATE_FROM_RUN_REJECTIONS.VERSION_EXISTS,
      text: null,
    });
    db.translationRunLanguage.findUnique.mockResolvedValue({ bookVersionId: 'v2' });
    await expect(steps.draftStep(lang(), ctx, metadata)).resolves.toEqual({ kind: 'continue' });
    expect(support.failLanguage).not.toHaveBeenCalled();
  });

  it('поля исходника правили после ответа - ответ снимается, попытки остаются', async () => {
    const { steps, drafts, db, ctx } = setup();
    drafts.createDraft.mockResolvedValue({ kind: 'fields_changed' });
    const attempts = [{ model: 'm', costUsd: '0.1', outcome: 'pass', remarks: [] }];
    await steps.draftStep(lang({ metadata: { attempts, result: metadata } }), ctx, metadata);
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    const state = writtenState(db) as unknown as { attempts: unknown[]; result: unknown };
    expect(state.result).toBeNull();
    expect(state.attempts).toEqual(attempts);
  });

  it('версия есть, глав не осталось - язык доделан', async () => {
    const { steps, support, drafts, ctx } = setup();
    drafts.nextToWrite.mockResolvedValue(null);
    await steps.draftStep(lang({ bookVersionId: 'v1' }), ctx, metadata);
    expect(support.finishLanguage).toHaveBeenCalledTimes(1);
  });

  it('создание версии: язык, принятый ответ и отпечаток из состояния языка', async () => {
    const { steps, drafts, lease, ctx } = setup();
    drafts.createDraft.mockResolvedValue({ kind: 'created', versionId: 'v2' });
    const row = lang({ metadata: { attempts: [], result: metadata, sourceHash: 'h1' } });
    await expect(steps.draftStep(row, ctx, metadata)).resolves.toEqual({ kind: 'continue' });
    expect(lease.renewLease).toHaveBeenCalledTimes(1);
    expect(drafts.createDraft).toHaveBeenCalledTimes(1);
    expect(drafts.createDraft).toHaveBeenCalledWith(row, metadata, 'h1');
  });

  it('ответ принят до 6c, отпечатка нет - createDraft без него', async () => {
    const { steps, drafts, ctx } = setup();
    drafts.createDraft.mockResolvedValue({ kind: 'created', versionId: 'v2' });
    const row = lang({ metadata: { attempts: [], result: metadata } });
    await steps.draftStep(row, ctx, metadata);
    expect(drafts.createDraft).toHaveBeenCalledTimes(1);
    expect(drafts.createDraft).toHaveBeenCalledWith(row, metadata, undefined);
  });

  it('исходник удалили под замком создания - failed DRAFT_DELETED', async () => {
    const { steps, support, drafts, ctx } = setup();
    drafts.createDraft.mockResolvedValue({ kind: 'deleted' });
    const row = lang();
    await steps.draftStep(row, ctx, metadata);
    expect(support.failLanguage).toHaveBeenCalledTimes(1);
    expect(support.failLanguage).toHaveBeenCalledWith(row, DRAFT_DELETED);
  });

  it('VERSION_EXISTS, своей версии у языка нет - failed с кодом и текстом', async () => {
    const { steps, support, drafts, db, ctx } = setup();
    drafts.createDraft.mockResolvedValue({
      kind: 'rejected',
      code: CREATE_FROM_RUN_REJECTIONS.VERSION_EXISTS,
      text: 'exists',
    });
    const row = lang();
    await steps.draftStep(row, ctx, metadata);
    expect(db.translationRunLanguage.findUnique).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.findUnique).toHaveBeenCalledWith({
      where: { id: 'l1' },
      select: { bookVersionId: true },
    });
    expect(support.failLanguage).toHaveBeenCalledTimes(1);
    expect(support.failLanguage).toHaveBeenCalledWith(
      row,
      CREATE_FROM_RUN_REJECTIONS.VERSION_EXISTS,
      'exists',
    );
  });

  it('запись главы: язык с версией, следующая глава, названия глав и продление аренды', async () => {
    const { steps, drafts, lease, ctx } = setup();
    const titles = [{ number: 1, title: 'Один' }];
    const accepted = { chapterTitles: titles } as unknown as MetadataResult;
    const next = { chapterNumber: 1 };
    drafts.nextToWrite.mockResolvedValue(next);
    const row = lang({ bookVersionId: 'v9' });
    await expect(steps.draftStep(row, ctx, accepted)).resolves.toEqual({ kind: 'continue' });
    expect(drafts.nextToWrite).toHaveBeenCalledTimes(1);
    expect(drafts.nextToWrite).toHaveBeenCalledWith('l1');
    expect(drafts.writeChapter).toHaveBeenCalledTimes(1);
    expect(drafts.writeChapter).toHaveBeenCalledWith(
      { ...row, bookVersionId: 'v9' },
      next,
      titles,
      expect.any(Function),
    );
    const renew = (drafts.writeChapter.mock.calls[0] as unknown[])[3] as () => Promise<void>;
    expect(lease.renewLease).not.toHaveBeenCalled();
    await renew();
    expect(lease.renewLease).toHaveBeenCalledTimes(1);
  });

  it('черновик удалили посреди записи главы - failed DRAFT_DELETED', async () => {
    const { steps, support, drafts, ctx } = setup();
    drafts.writeChapter.mockResolvedValue('draft_deleted');
    await steps.draftStep(lang({ bookVersionId: 'v1' }), ctx, metadata);
    expect(support.failLanguage).toHaveBeenCalledTimes(1);
    expect(support.failLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1' }),
      DRAFT_DELETED,
    );
  });
});
