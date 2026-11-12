import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../../prisma/prisma.service';
import { AutoTextReadService } from './auto-text-read.service';

/** `T184`: отметка «прочитано» вкладок Summary и Analysis. */
describe('AutoTextReadService (T184)', () => {
  const LANDED = new Date(Date.now() - 60_000);

  function setup(
    version: Record<string, Date | string | null> | null,
    building: { id: string } | null = null,
  ) {
    const calls: string[] = [];
    let row = version ? { ...version } : null;
    const tx = {
      $queryRaw: jest.fn((sql: TemplateStringsArray) => {
        calls.push(sql.join('?').includes('FOR NO KEY UPDATE') ? 'lock-version' : 'sql');
        return Promise.resolve([]);
      }),
      bookVersion: {
        findUnique: jest.fn(() => {
          calls.push('read');
          return Promise.resolve(row ? { ...row } : null);
        }),
        update: jest.fn((args: { data: Record<string, Date | string | null> }) => {
          calls.push('update');
          row = { ...row, ...args.data };
          return Promise.resolve(row);
        }),
      },
      contentDraft: { findFirst: jest.fn(() => Promise.resolve(building)) },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    return {
      service: new AutoTextReadService(prisma as unknown as PrismaService),
      tx,
      calls,
      row: () => row,
    };
  }

  const blank = {
    summaryAutoTextAt: null,
    summaryReadAt: null,
    summaryReadById: null,
    analysisAutoTextAt: null,
    analysisReadAt: null,
    analysisReadById: null,
  };

  it('marks the summary read by the user under the version row lock', async () => {
    const h = setup({ ...blank, summaryAutoTextAt: LANDED });
    const state = await h.service.mark('v1', 'summary', 'admin-1', LANDED.toISOString());
    expect(h.calls.slice(0, 2)).toEqual(['lock-version', 'read']);
    expect(h.tx.contentDraft.findFirst).toHaveBeenCalledTimes(1);
    expect(h.tx.contentDraft.findFirst).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', kind: 'summary_write', status: 'building' },
      select: { id: true },
    });
    expect(state).toMatchObject({ autoTextAt: LANDED, readById: 'admin-1', read: true });
    expect(h.row()?.summaryReadAt).toBeInstanceOf(Date);
    expect(h.row()?.analysisReadAt).toBeNull();
  });

  it('409 AUTO_TEXT_RUN_BUILDING while a run of the kind is building; nothing is written', async () => {
    const h = setup({ ...blank, analysisAutoTextAt: LANDED }, { id: 'd1' });
    const error: unknown = await h.service
      .mark('v1', 'analysis', 'admin-1', LANDED.toISOString())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'AUTO_TEXT_RUN_BUILDING',
    });
    expect(h.tx.contentDraft.findFirst).toHaveBeenCalledTimes(1);
    expect(h.tx.contentDraft.findFirst).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', kind: 'analysis_write', status: 'building' },
      select: { id: true },
    });
    expect(h.tx.bookVersion.update).not.toHaveBeenCalled();
  });

  it('409 AUTO_TEXT_NONE without model text in the fields', async () => {
    const h = setup(blank);
    const error: unknown = await h.service
      .mark('v1', 'summary', 'admin-1', LANDED.toISOString())
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'AUTO_TEXT_NONE' });
    expect(h.tx.bookVersion.update).not.toHaveBeenCalled();
  });

  it('409 AUTO_TEXT_CHANGED when newer model text landed than the editor saw; nothing is written', async () => {
    const h = setup({ ...blank, summaryAutoTextAt: LANDED });
    for (const shift of [-1000, 1000]) {
      const seen = new Date(LANDED.getTime() + shift).toISOString();
      const error: unknown = await h.service
        .mark('v1', 'summary', 'admin-1', seen)
        .catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'AUTO_TEXT_CHANGED',
        current: { autoTextAt: LANDED, read: false },
      });
    }
    expect(h.tx.bookVersion.update).not.toHaveBeenCalled();
  });

  it('the mark is never earlier than the model text it marks (clock of another instance ahead)', async () => {
    const ahead = new Date(Date.now() + 60_000);
    const h = setup({ ...blank, analysisAutoTextAt: ahead });
    const state = await h.service.mark('v1', 'analysis', 'admin-1', ahead.toISOString());
    expect(state.read).toBe(true);
    expect((h.row()?.analysisReadAt as Date).getTime()).toBe(ahead.getTime());
    expect(h.row()).toMatchObject({
      analysisReadById: 'admin-1',
      summaryReadAt: null,
      summaryReadById: null,
    });
  });

  it('404 for a version that does not exist', async () => {
    const h = setup(null);
    await expect(h.service.state('v1', 'summary')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.unmark('v1', 'summary')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('state is unread when the model text is newer than the mark', async () => {
    const h = setup({
      ...blank,
      analysisAutoTextAt: LANDED,
      analysisReadAt: new Date(LANDED.getTime() - 1),
      analysisReadById: 'admin-1',
    });
    await expect(h.service.state('v1', 'analysis')).resolves.toMatchObject({ read: false });
  });

  it('unmark clears the mark of its kind only', async () => {
    const h = setup({
      ...blank,
      summaryAutoTextAt: LANDED,
      summaryReadAt: LANDED,
      summaryReadById: 'admin-1',
      analysisReadAt: LANDED,
      analysisReadById: 'admin-2',
    });
    await h.service.unmark('v1', 'summary');
    expect(h.calls[0]).toBe('lock-version');
    expect(h.row()).toMatchObject({
      summaryReadAt: null,
      summaryReadById: null,
      analysisReadAt: LANDED,
      analysisReadById: 'admin-2',
    });
  });
});
