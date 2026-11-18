import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  REPORT_TX_OPTIONS,
  reportFindings,
  TranslationRunReportService,
} from './translation-run-report.service';

describe('report findings', () => {
  it('only known fields of their type; a finding without a code and the paid cost are not sent out', () => {
    expect(
      reportFindings([
        { code: 'SEAM_BROKEN', seam: 2, problems: ['lost', 3], costUsd: '0.1', model: 'm' },
        { code: 'GLOSSARY_SOURCE_FORM', key: 'anna', fragment: 'x'.repeat(900), extra: { a: 1 } },
        { seam: 1 },
        'CHAPTER_EMPTY',
        { code: 'CHUNK_FLAGGED', chunkIndex: '1' },
      ]),
    ).toEqual([
      { code: 'SEAM_BROKEN', seam: 2, problems: ['lost'], model: 'm' },
      { code: 'GLOSSARY_SOURCE_FORM', key: 'anna', fragment: 'x'.repeat(500) },
      { code: 'CHUNK_FLAGGED' },
    ]);
    expect(reportFindings(null)).toEqual([]);
  });
});

describe('report snapshot', () => {
  it('reads in one RepeatableRead transaction with the module timeouts, not the Prisma defaults', async () => {
    const stop = new Error('stop after the options are seen');
    const $transaction = jest.fn().mockRejectedValue(stop);
    const prisma = {
      translationRun: {
        findUnique: jest.fn().mockResolvedValue({ id: 'r1', bookVersionId: 'v1' }),
      },
      $transaction,
    } as unknown as PrismaService;

    await expect(new TranslationRunReportService(prisma).report('r1')).rejects.toBe(stop);
    // Одна транзакция на все чтения - второй с умолчаниями Prisma быть не должно.
    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), REPORT_TX_OPTIONS);
    expect(REPORT_TX_OPTIONS).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 10_000,
      maxWait: 5_000,
    });
  });

  it('no run - 404 before any transaction', async () => {
    const $transaction = jest.fn();
    const prisma = {
      translationRun: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction,
    } as unknown as PrismaService;

    await expect(new TranslationRunReportService(prisma).report('r1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect($transaction).not.toHaveBeenCalled();
  });
});
