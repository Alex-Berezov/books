import { autoTextLanded, LandingData, noteAutoText, saveNotingAutoText } from './auto-text-landing';

/** `T184`: запись данных хода, после которой текст модели лежит в полях версии. */
describe('autoTextLanded (T184)', () => {
  const data = (outcomes: string[], written: unknown = { full: null }): LandingData => ({
    items: outcomes.map((outcome) => ({ outcome })),
    written,
  });

  it('an item that became written or accepted lands the text', () => {
    expect(autoTextLanded(data(['waiting']), data(['written']))).toBe(true);
    expect(autoTextLanded(data(['proposed']), data(['accepted']))).toBe(true);
  });

  it('a proposal, a discard or a failure does not land anything', () => {
    expect(autoTextLanded(data(['waiting']), data(['proposed']))).toBe(false);
    expect(autoTextLanded(data(['proposed']), data(['discarded']))).toBe(false);
    expect(autoTextLanded(data(['waiting']), data(['none']))).toBe(false);
  });

  it('items that stay written or accepted with the same prints land nothing', () => {
    expect(
      autoTextLanded(
        data(['written', 'accepted'], { full: 'a', sections: { 1: 'b' } }),
        data(['written', 'accepted'], { sections: { 1: 'b' }, full: 'a' }),
      ),
    ).toBe(false);
  });

  it('a written item written again (regeneration) changes the print and lands the text', () => {
    expect(autoTextLanded(data(['written'], { full: 'a' }), data(['written'], { full: 'b' }))).toBe(
      true,
    );
  });

  it('noteAutoText locks the version row first, then takes the time and writes its kind', async () => {
    const calls: string[] = [];
    const update = jest.fn((args: { data: Record<string, Date> }) => {
      calls.push(`update:${Object.keys(args.data).join()}`);
      return Promise.resolve({});
    });
    const queryRaw = jest.fn((sql: TemplateStringsArray) => {
      calls.push(sql.join('?').includes('FOR NO KEY UPDATE') ? 'lock-version' : 'sql');
      return Promise.resolve([]);
    });
    const findUnique = jest.fn(() => {
      calls.push('read-marks');
      return Promise.resolve({
        summaryReadAt: null,
        analysisReadAt: null,
        summaryAutoTextAt: null,
        analysisAutoTextAt: null,
      });
    });
    const tx = { bookVersion: { update, findUnique }, $queryRaw: queryRaw } as never;
    const before = Date.now();
    await noteAutoText(tx, 'v1', 'summary');
    await noteAutoText(tx, 'v1', 'analysis');
    expect(calls).toEqual([
      'lock-version',
      'read-marks',
      'update:summaryAutoTextAt',
      'lock-version',
      'read-marks',
      'update:analysisAutoTextAt',
    ]);
    expect(update).toHaveBeenCalledTimes(2);
    const at = (update.mock.calls[0][0] as { data: { summaryAutoTextAt: Date } }).data
      .summaryAutoTextAt;
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it.each([
    ['summary', { summaryReadAt: 'read' }],
    ['analysis', { analysisReadAt: 'read' }],
    ['summary', { summaryAutoTextAt: 'prev' }],
    ['analysis', { analysisAutoTextAt: 'prev' }],
  ] as const)(
    '%s: a landing is strictly later than the mark and the previous landing of its kind (%j)',
    async (kind, marks) => {
      const ahead = new Date(Date.now() + 60_000);
      const other = new Date(Date.now() + 120_000);
      const row: Record<string, Date | null> = {
        summaryReadAt: null,
        analysisReadAt: null,
        summaryAutoTextAt: null,
        analysisAutoTextAt: null,
      };
      for (const key of Object.keys(marks)) row[key] = ahead;
      // Чужой вид всегда ещё дальше вперёд: взят не тот столбец - время уедет за него.
      const foreign = kind === 'summary' ? 'analysis' : 'summary';
      row[`${foreign}ReadAt`] = other;
      row[`${foreign}AutoTextAt`] = other;
      const update = jest.fn().mockResolvedValue({});
      const findUnique = jest.fn().mockResolvedValue(row);
      const tx = {
        bookVersion: { update, findUnique },
        $queryRaw: jest.fn().mockResolvedValue([]),
      };
      await noteAutoText(tx as never, 'v1', kind);
      const data = (update.mock.calls[0][0] as { data: Record<string, Date> }).data;
      expect(data[`${kind}AutoTextAt`].getTime()).toBe(ahead.getTime() + 1);
    },
  );

  describe('saveNotingAutoText: every write of a run goes through it', () => {
    const harness = (prevData: LandingData | null) => {
      const calls: string[] = [];
      const tx = {
        contentDraft: {
          findUnique: jest.fn(() => {
            calls.push('read-prev');
            return Promise.resolve(prevData ? { bookVersionId: 'v1', data: prevData } : null);
          }),
        },
        bookVersion: {
          update: jest.fn(() => {
            calls.push('note');
            return Promise.resolve({});
          }),
        },
        $queryRaw: jest.fn(() => Promise.resolve([])),
      };
      Object.assign(tx.bookVersion, {
        findUnique: jest.fn(() =>
          Promise.resolve({
            summaryReadAt: null,
            analysisReadAt: null,
            summaryAutoTextAt: null,
            analysisAutoTextAt: null,
          }),
        ),
      });
      const write = jest.fn(() => {
        calls.push('write');
        return Promise.resolve();
      });
      return { tx, write, calls };
    };
    const asIs = (raw: unknown) => raw as LandingData;

    it('reads the previous data before the write and notes landed text after it', async () => {
      const h = harness(data(['proposed']));
      await saveNotingAutoText(h.tx as never, 'd1', 'summary', data(['accepted']), asIs, h.write);
      expect(h.calls).toEqual(['read-prev', 'write', 'note']);
      expect(h.tx.contentDraft.findUnique).toHaveBeenCalledTimes(1);
      expect(h.tx.contentDraft.findUnique).toHaveBeenCalledWith({
        where: { id: 'd1' },
        select: { bookVersionId: true, data: true },
      });
    });

    it('a write that lands nothing notes nothing; a write that throws notes nothing', async () => {
      const h = harness(data(['waiting']));
      await saveNotingAutoText(h.tx as never, 'd1', 'analysis', data(['proposed']), asIs, h.write);
      expect(h.calls).toEqual(['read-prev', 'write']);

      const failed = harness(data(['proposed']));
      const gone = new Error('gone');
      await expect(
        saveNotingAutoText(failed.tx as never, 'd1', 'analysis', data(['accepted']), asIs, () =>
          Promise.reject(gone),
        ),
      ).rejects.toBe(gone);
      expect(failed.tx.bookVersion.update).not.toHaveBeenCalled();
    });
  });
});
