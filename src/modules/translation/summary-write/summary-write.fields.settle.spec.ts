import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { BookSummaryService } from '../../book-summary/book-summary.service';
import {
  BookSummarySectionsService,
  SectionWriteGuard,
} from '../../book-summary/book-summary-sections.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { runGate, SummaryWriteFields } from './summary-write.fields';

/**
 * Запись хода в поле под замком (`F06-2`, решение арбитра `F06 | F06-2`, круг 3): решение под
 * замком перепроверяет, что текст ещё ждёт; строка версии берётся `FOR UPDATE`; отказ записи
 * сервиса пересказа - конечный исход «не записано», а не исключение шага.
 */
describe('SummaryWriteFields.settle', () => {
  const sectionItem = (outcome: string) => ({
    target: 'section',
    number: 1,
    title: 'Chapter 1',
    readerChapter: 1,
    text: 'Anna.',
    attempt: 1,
    verdict: 'ok',
    remarks: [],
    review: null,
    outcome,
    failedReason: null,
    authorModel: 'm',
    chapters: [1],
    fieldHash: null,
    fieldMode: null,
    fieldBase: null,
    regenFailedReason: null,
    regen: null,
  });
  const row = (outcome: string) => ({
    id: 'd1',
    bookVersionId: 'v1',
    kind: 'summary_write',
    status: 'building',
    operationId: 'op1',
    data: {
      items: [sectionItem(outcome)],
      owns: { sections: true, full: true, brief: true },
      written: { full: null, brief: null, sections: {} },
      plannedSections: 1,
      pending: null,
    },
  });

  function setup(read: string, underLock: string) {
    const calls: string[] = [];
    const tx = {
      $queryRaw: jest.fn((sql: TemplateStringsArray) => {
        const text = sql.join('?');
        calls.push(
          text.includes('FOR NO KEY UPDATE') && text.includes('"BookVersion"')
            ? 'lock-version'
            : text.includes('pg_advisory_xact_lock')
              ? 'lock-summary'
              : `sql:${text}`,
        );
        return Promise.resolve([]);
      }),
      contentDraft: {
        findUnique: jest.fn(() => Promise.resolve(row(underLock))),
        update: jest.fn(() => Promise.resolve({})),
      },
      bookVersion: {
        findUnique: jest.fn(() => {
          calls.push('read-version');
          return Promise.resolve({ status: 'draft' });
        }),
      },
      bookSummary: { findUnique: jest.fn(() => Promise.resolve(null)) },
      bookSummarySection: { findMany: jest.fn(() => Promise.resolve([])) },
      chapter: { findFirst: jest.fn(() => Promise.resolve({ number: 1 })) },
    };
    const prisma = {
      contentDraft: { findUnique: jest.fn(() => Promise.resolve(row(read))) },
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    let decided: unknown = 'not called';
    const sections = {
      writeGuarded: jest.fn(async (_v: string, _dto: unknown, guard: SectionWriteGuard) => {
        decided = await guard.decide(tx as never);
        return decided !== null;
      }),
    };
    const fields = new SummaryWriteFields(
      prisma as unknown as PrismaService,
      {} as BookSummaryService,
      sections as unknown as BookSummarySectionsService,
    );
    return { fields, sections, calls, tx, decided: () => decided };
  }

  it('a waiting text is written; the version row is locked FOR NO KEY UPDATE before its status is read', async () => {
    const { fields, calls, decided } = setup('waiting', 'waiting');
    await fields.settle({ id: 'd1', bookVersionId: 'v1' }, runGate('op1'), 0);
    expect(decided()).toEqual({ kind: 'append' });
    // Строка версии - именно `FOR NO KEY UPDATE` по тексту запроса, до чтения статуса.
    expect(calls.slice(0, 2)).toEqual(['lock-version', 'read-version']);
  });

  it('a text decided between the read and the lock (Discard) is not written', async () => {
    const { fields, decided } = setup('waiting', 'discarded');
    await expect(fields.settle({ id: 'd1', bookVersionId: 'v1' }, runGate('op1'), 0)).resolves.toBe(
      'gone',
    );
    expect(decided()).toBeNull();
  });

  it('a refusal of the summary service (taken number, version gone, 200 sections) is the end «not written» with the reason in the text, not a thrown step', async () => {
    for (const error of [
      new ConflictException('taken'),
      new NotFoundException('gone'),
      new BadRequestException('at most 200 sections'),
    ]) {
      const { fields, sections, tx } = setup('waiting', 'waiting');
      sections.writeGuarded.mockRejectedValueOnce(error);
      await expect(
        fields.settle({ id: 'd1', bookVersionId: 'v1' }, runGate('op1'), 0),
      ).resolves.toBe('gone');
      expect(sections.writeGuarded).toHaveBeenCalledTimes(1);
      // Причина в тексте хода: он больше не «ждёт» и не пробуется на каждом шаге (круг 4).
      expect(tx.contentDraft.update).toHaveBeenCalledTimes(1);
      expect(tx.contentDraft.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            data: expect.objectContaining({
              items: [
                expect.objectContaining({ outcome: 'none', failedReason: 'SUMMARY_WRITE_REFUSED' }),
              ],
            }),
          },
        }),
      );
    }
  });

  it('any other error of the write goes up to the step (a database outage is retried, not «not written»)', async () => {
    const { fields, sections } = setup('waiting', 'waiting');
    sections.writeGuarded.mockRejectedValueOnce(new Error('connection lost'));
    await expect(
      fields.settle({ id: 'd1', bookVersionId: 'v1' }, runGate('op1'), 0),
    ).rejects.toThrow('connection lost');
  });
});
