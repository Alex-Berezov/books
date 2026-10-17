import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';
import { BookAnalysisService } from './book-analysis.service';
import type { UpdateBookAnalysisDto } from './dto/update-book-analysis.dto';

/**
 * F03-1: ветки сервиса анализа без базы. Гонку замка и живой SQL держит
 * `test/book-analysis.e2e-spec.ts`; здесь — 404, гео, ядро для читателя, `dryRun` без записи,
 * границы транзакции (`L-020`) и выборка только упомянутых глав.
 */

interface AnalysisDelegate {
  findUnique: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
}

const analysisDelegate = (): AnalysisDelegate => ({
  findUnique: jest.fn().mockResolvedValue(null),
  create: jest.fn(),
  update: jest.fn(),
});

const row = (over: Record<string, unknown> = {}) => ({
  hasCore: true,
  createdAt: new Date('2026-10-17T00:00:00Z'),
  updatedAt: new Date('2026-10-17T00:00:00Z'),
  facts: null,
  mainIdea: 'Idea',
  themes: null,
  characters: null,
  symbols: null,
  keyQuotes: null,
  titleMeaning: null,
  endingMeaning: null,
  context: null,
  timeline: null,
  style: null,
  reception: null,
  adaptations: null,
  misreadings: null,
  discussionQuestions: null,
  faq: null,
  sources: null,
  ...over,
});

describe('BookAnalysisService', () => {
  let tx: {
    $queryRaw: jest.Mock;
    bookAnalysis: AnalysisDelegate;
    chapter: { findMany: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    bookVersion: { findUnique: jest.Mock };
    bookAnalysis: AnalysisDelegate;
    chapter: { findMany: jest.Mock };
  };
  let isModerator: jest.Mock;
  let assertAccess: jest.Mock;
  let service: BookAnalysisService;

  beforeEach(() => {
    // `tx` — отдельный объект: запись мимо `tx` прошла бы незамеченной (`L-016`).
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      bookAnalysis: analysisDelegate(),
      chapter: { findMany: jest.fn().mockResolvedValue([]) },
    };
    prisma = {
      $transaction: jest.fn((cb: (client: typeof tx) => unknown) => cb(tx)),
      bookVersion: {
        findUnique: jest.fn().mockResolvedValue({ status: 'published', language: 'en' }),
      },
      bookAnalysis: analysisDelegate(),
      chapter: { findMany: jest.fn().mockResolvedValue([]) },
    };
    isModerator = jest.fn().mockResolvedValue(false);
    assertAccess = jest.fn().mockResolvedValue(undefined);
    service = new BookAnalysisService(
      prisma as unknown as PrismaService,
      { isModerator } as unknown as ModeratorRolesService,
      { assertAccess } as unknown as GeoBlockRuleService,
    );
  });

  describe('getByVersion', () => {
    it('нет версии — 404', async () => {
      prisma.bookVersion.findUnique.mockResolvedValue(null);
      await expect(service.getByVersion('v1', undefined, null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('черновик версии читателю — 404, гео не спрашивается', async () => {
      prisma.bookVersion.findUnique.mockResolvedValue({ status: 'draft', language: 'en' });
      await expect(service.getByVersion('v1', undefined, 'GB')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(assertAccess).not.toHaveBeenCalled();
    });

    it('читатель проходит гео-проверку текста версии (А1, строгий вариант)', async () => {
      prisma.bookAnalysis.findUnique.mockResolvedValue(row());
      const res = await service.getByVersion('v1', undefined, 'GB');
      expect(assertAccess).toHaveBeenCalledTimes(1);
      expect(assertAccess).toHaveBeenCalledWith({
        bookVersionId: 'v1',
        countryCode: 'GB',
        scope: GeoBlockScope.TEXT_READER,
      });
      expect(res).toMatchObject({ language: 'en', hasCore: true, mainIdea: 'Idea' });
      expect(res).not.toHaveProperty('id');
      expect(res).not.toHaveProperty('bookVersionId');
    });

    it('анализ без ядра читателю — null, редактору — запись', async () => {
      prisma.bookAnalysis.findUnique.mockResolvedValue(row({ hasCore: false }));
      await expect(service.getByVersion('v1', undefined, null)).resolves.toBeNull();

      assertAccess.mockClear();
      isModerator.mockResolvedValue(true);
      prisma.bookVersion.findUnique.mockResolvedValue({ status: 'draft', language: 'en' });
      const res = await service.getByVersion('v1', { userId: 'u', email: 'e' }, 'GB');
      expect(res).toMatchObject({ hasCore: false, mainIdea: 'Idea' });
      expect(assertAccess).not.toHaveBeenCalled();
    });
  });

  describe('saveForVersion', () => {
    const dto = (over: Partial<UpdateBookAnalysisDto> = {}) =>
      ({ language: 'en', ...over }) as UpdateBookAnalysisDto;

    it('язык JSON не совпал с языком версии — 400 без чтения записи', async () => {
      await expect(
        service.saveForVersion('v1', dto({ language: 'ru' }), false),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('dryRun: без транзакции и без записи, отдаёт ядро и предупреждения', async () => {
      prisma.chapter.findMany.mockResolvedValue([{ number: 1 }]);
      const res = await service.saveForVersion(
        'v1',
        dto({ symbols: [{ title: 'S', interpretation: 'I', chapters: [1, 7, 7] }] }),
        true,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.bookAnalysis.create).not.toHaveBeenCalled();
      expect(prisma.bookAnalysis.update).not.toHaveBeenCalled();
      expect(res.analysis).toBeNull();
      expect(res.hasCore).toBe(false);
      // Ищутся только упомянутые номера, без предела выборки: на длинной версии не будет ложного «нет главы».
      expect(prisma.chapter.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.chapter.findMany).toHaveBeenCalledWith({
        where: { bookVersionId: 'v1', number: { in: [1, 7] } },
        select: { number: true },
      });
      expect(res.warnings.filter((w) => w.code === 'chapter_not_found').map((w) => w.path)).toEqual(
        ['symbols.0.chapters.1', 'symbols.0.chapters.2'],
      );
    });

    it('запись — в транзакции с явными границами, под замком, ядро пересчитано', async () => {
      tx.bookAnalysis.create.mockResolvedValue(row({ hasCore: false }));
      await service.saveForVersion('v1', dto({ mainIdea: 'Idea' }), false);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 30_000,
        maxWait: 10_000,
      });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.bookAnalysis.create).toHaveBeenCalledTimes(1);
      expect(tx.bookAnalysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ bookVersionId: 'v1', mainIdea: 'Idea', hasCore: false }),
        }),
      );
      expect(prisma.bookAnalysis.create).not.toHaveBeenCalled();
    });

    it('существующая запись с полным ядром — update по слитой записи и hasCore: true', async () => {
      tx.bookAnalysis.findUnique.mockResolvedValue(
        row({
          hasCore: false,
          mainIdea: 'Idea',
          themes: [
            { key: 'a', title: 'A', interpretation: 'x' },
            { key: 'b', title: 'B', interpretation: 'y' },
          ],
          characters: [
            { key: 'r', name: 'R', role: 'main', description: 'd' },
            { key: 's', name: 'S', role: 'secondary', description: 'd' },
          ],
        }),
      );
      tx.bookAnalysis.update.mockResolvedValue(row());
      const keyQuotes = ['1', '2', '3'].map((text) => ({ text, interpretation: 'i' }));
      const res = await service.saveForVersion('v1', dto({ keyQuotes }), false);
      expect(tx.bookAnalysis.create).not.toHaveBeenCalled();
      expect(tx.bookAnalysis.update).toHaveBeenCalledTimes(1);
      expect(tx.bookAnalysis.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { bookVersionId: 'v1' },
          data: expect.objectContaining({ hasCore: true, mainIdea: 'Idea', keyQuotes }),
        }),
      );
      expect(res.hasCore).toBe(true);
    });

    it('ссылка на неизвестную тему — 400 с путём, записи нет', async () => {
      const bad = dto({ characters: [{ key: 'r', name: 'R', role: 'main', themeKeys: ['x'] }] });
      await expect(service.saveForVersion('v1', bad, false)).rejects.toMatchObject({
        response: { message: ['characters.0.themeKeys.0: unknown theme key "x"'] },
      });
      expect(tx.bookAnalysis.create).not.toHaveBeenCalled();
    });

    it('версия удалена в окне правки (P2025 на update) — 404', async () => {
      tx.bookAnalysis.findUnique.mockResolvedValue(row());
      tx.bookAnalysis.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: 'test' }),
      );
      await expect(
        service.saveForVersion('v1', dto({ mainIdea: 'I' }), false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      [
        'P2002',
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
      ],
      ['обычная ошибка', new Error('connection lost')],
    ])('прочий отказ базы (%s) пробрасывается как есть, не 404', async (_name, err) => {
      tx.bookAnalysis.create.mockRejectedValue(err);
      await expect(service.saveForVersion('v1', dto({ mainIdea: 'I' }), false)).rejects.toBe(err);
    });

    it.each(['P2003', 'P2025'])('версия удалена в окне записи (%s) — 404', async (code) => {
      tx.bookAnalysis.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('gone', { code, clientVersion: 'test' }),
      );
      await expect(
        service.saveForVersion('v1', dto({ mainIdea: 'I' }), false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
