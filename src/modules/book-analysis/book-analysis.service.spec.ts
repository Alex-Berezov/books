import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';
import {
  BookAnalysisService,
  CHAPTER_NUMBERS_LIMIT,
  CLAIM_CLOSURES_BATCH,
  CLAIM_CLOSURES_MAX_BATCHES,
} from './book-analysis.service';
import { settledClaimBlockWhere } from '../rights-claims/settled-claim-block';
import type { UpdateBookAnalysisDto } from './dto/update-book-analysis.dto';

/**
 * F03-1: ветки сервиса анализа без базы. Гонку замка и живой SQL держит
 * `test/book-analysis.e2e-spec.ts`; здесь — 404, блок окончённой претензии, ядро для читателя, `dryRun` без записи,
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
    rightsClaimAccessBlock: { findMany: jest.Mock };
  };
  let isModerator: jest.Mock;
  let assertSettledClaimAccess: jest.Mock;
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
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'published', language: 'en', bookId: 'b1' }),
      },
      bookAnalysis: analysisDelegate(),
      chapter: { findMany: jest.fn().mockResolvedValue([]) },
      rightsClaimAccessBlock: { findMany: jest.fn().mockResolvedValue([]) },
    };
    isModerator = jest.fn().mockResolvedValue(false);
    assertSettledClaimAccess = jest.fn().mockResolvedValue(undefined);
    service = new BookAnalysisService(
      prisma as unknown as PrismaService,
      { isModerator } as unknown as ModeratorRolesService,
      { assertSettledClaimAccess } as unknown as GeoBlockRuleService,
    );
  });

  describe('getByVersion', () => {
    it('нет версии — 404', async () => {
      prisma.bookVersion.findUnique.mockResolvedValue(null);
      await expect(service.getByVersion('v1', undefined, null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('черновик версии читателю — 404, претензия не спрашивается', async () => {
      prisma.bookVersion.findUnique.mockResolvedValue({ status: 'draft', language: 'en' });
      await expect(service.getByVersion('v1', undefined, 'GB')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(assertSettledClaimAccess).not.toHaveBeenCalled();
    });

    // Территориального гео нет (решение владельца 18.10.2026, А1); претензия закрывает после окончания спора.
    it('читатель проходит только проверку окончённой претензии (scope TEXT_READER)', async () => {
      prisma.bookAnalysis.findUnique.mockResolvedValue(row());
      const res = await service.getByVersion('v1', undefined, 'GB');
      expect(assertSettledClaimAccess).toHaveBeenCalledTimes(1);
      expect(assertSettledClaimAccess).toHaveBeenCalledWith({
        bookId: 'b1',
        bookVersionId: 'v1',
        countryCode: 'GB',
        scope: GeoBlockScope.TEXT_READER,
      });
      expect(res).toMatchObject({ language: 'en', hasCore: true, mainIdea: 'Idea' });
      expect(res).not.toHaveProperty('id');
      expect(res).not.toHaveProperty('bookVersionId');
    });

    // F03-2: ссылка «глава N» ставится только на существующую главу — номера только из выборки `number`.
    it('отдаёт номера глав версии по возрастанию, с пределом и без текста глав', async () => {
      prisma.bookAnalysis.findUnique.mockResolvedValue(row());
      prisma.chapter.findMany.mockResolvedValue([{ number: 1 }, { number: 2 }, { number: 5 }]);
      const res = await service.getByVersion('v1', undefined, null);
      expect(res?.chapterNumbers).toEqual([1, 2, 5]);
      expect(prisma.chapter.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.chapter.findMany).toHaveBeenCalledWith({
        where: { bookVersionId: 'v1' },
        select: { number: true },
        orderBy: { number: 'asc' },
        take: CHAPTER_NUMBERS_LIMIT,
      });
    });

    it('анализ без ядра читателю — null, редактору — запись', async () => {
      prisma.bookAnalysis.findUnique.mockResolvedValue(row({ hasCore: false }));
      await expect(service.getByVersion('v1', undefined, null)).resolves.toBeNull();

      assertSettledClaimAccess.mockClear();
      isModerator.mockResolvedValue(true);
      prisma.bookVersion.findUnique.mockResolvedValue({ status: 'draft', language: 'en' });
      const res = await service.getByVersion('v1', { userId: 'u', email: 'e' }, 'GB');
      expect(res).toMatchObject({ hasCore: false, mainIdea: 'Idea' });
      expect(assertSettledClaimAccess).not.toHaveBeenCalled();
    });
  });

  // F03-2, решение арбитра `F03 | F03-2`: middleware фронта закрывает анализ в стране блока по этому списку.
  describe('listClaimClosures', () => {
    const now = new Date('2026-10-18T12:00:00Z');
    const versionBlock = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      scope: GeoBlockScope.TEXT_READER,
      countryCode: 'GB',
      expiresAt: null,
      book: null,
      bookVersion: { slug: `s-${id}`, language: 'en', status: 'published', book: { slug: 'b' } },
      ...over,
    });

    it('условие - общее с ручкой и счётчиком; в выборке только опубликованные версии и без причины', async () => {
      jest.useFakeTimers({ now });
      try {
        await service.listClaimClosures();
      } finally {
        jest.useRealTimers();
      }
      expect(prisma.rightsClaimAccessBlock.findMany).toHaveBeenCalledTimes(1);
      const args = prisma.rightsClaimAccessBlock.findMany.mock.calls[0][0] as {
        where: unknown;
        take: number;
        select: {
          reasonRu?: unknown;
          book: { select: { versions: { where: unknown } } };
        };
      };
      expect(args.where).toEqual(settledClaimBlockWhere(now, GeoBlockScope.TEXT_READER));
      expect(args.take).toBe(CLAIM_CLOSURES_BATCH);
      expect(args.select.book.select.versions.where).toEqual({ status: 'published' });
      expect(args.select.reasonRu).toBeUndefined();
    });

    it('блок на книгу - все языки и слаги; блок версии - её язык; черновик и книга без опубликованных версий не попадают', async () => {
      const expiresAt = new Date('2026-12-01T00:00:00Z');
      prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
        versionBlock('1', {
          scope: GeoBlockScope.ENTIRE_BOOK,
          countryCode: 'de',
          book: { slug: 'hamlet', versions: [{ slug: 'hamlet-en' }, { slug: null }] },
          bookVersion: null,
        }),
        versionBlock('2', {
          countryCode: null,
          expiresAt,
          bookVersion: {
            slug: 'gamlet',
            language: 'ru',
            status: 'published',
            book: { slug: 'hamlet' },
          },
        }),
        versionBlock('3', {
          scope: GeoBlockScope.LANGUAGE_EDITION,
          bookVersion: { slug: 'x', language: 'fr', status: 'draft', book: { slug: 'y' } },
        }),
        versionBlock('4', {
          scope: GeoBlockScope.ENTIRE_BOOK,
          book: { slug: 'secret-book', versions: [] },
          bookVersion: null,
        }),
      ]);
      await expect(service.listClaimClosures()).resolves.toEqual({
        items: [
          { slugs: ['hamlet', 'hamlet-en'], language: null, countryCode: 'DE', expiresAt: null },
          { slugs: ['gamlet', 'hamlet'], language: 'ru', countryCode: null, expiresAt },
        ],
      });
    });

    // Обрезанный список middleware не отличил бы от полного (L-015): читается порциями до конца.
    it('список длиннее порции читается следующей порцией по курсору', async () => {
      const full = Array.from({ length: CLAIM_CLOSURES_BATCH }, (_, i) => versionBlock(`a${i}`));
      prisma.rightsClaimAccessBlock.findMany
        .mockResolvedValueOnce(full)
        .mockResolvedValueOnce([versionBlock('last')]);

      const res = await service.listClaimClosures();

      expect(res.items).toHaveLength(CLAIM_CLOSURES_BATCH + 1);
      expect(prisma.rightsClaimAccessBlock.findMany).toHaveBeenCalledTimes(2);
      // Порог по `id`, а не курсор Prisma: удалённая между порциями строка не обрывает список.
      const second = prisma.rightsClaimAccessBlock.findMany.mock.calls[1][0] as {
        where: { AND: unknown[] };
        cursor?: unknown;
      };
      expect(second.cursor).toBeUndefined();
      expect(second.where.AND[1]).toEqual({ id: { gt: `a${CLAIM_CLOSURES_BATCH - 1}` } });
    });

    it('за пределом порций есть строки - отказ 503, а не урезанный список', async () => {
      const full = Array.from({ length: CLAIM_CLOSURES_BATCH }, (_, i) => versionBlock(`a${i}`));
      prisma.rightsClaimAccessBlock.findMany.mockResolvedValue(full);

      await expect(service.listClaimClosures()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.rightsClaimAccessBlock.findMany).toHaveBeenCalledTimes(
        CLAIM_CLOSURES_MAX_BATCHES + 1,
      );
    });

    it('ровно предел полных порций и дальше пусто - полный список, не 503', async () => {
      const full = Array.from({ length: CLAIM_CLOSURES_BATCH }, (_, i) => versionBlock(`a${i}`));
      for (let i = 0; i < CLAIM_CLOSURES_MAX_BATCHES; i += 1) {
        prisma.rightsClaimAccessBlock.findMany.mockResolvedValueOnce(full);
      }
      prisma.rightsClaimAccessBlock.findMany.mockResolvedValueOnce([]);

      const res = await service.listClaimClosures();

      expect(res.items).toHaveLength(CLAIM_CLOSURES_BATCH * CLAIM_CLOSURES_MAX_BATCHES);
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

    // F03-2: ответ сохранения несёт номера глав - через `tx`, иначе запрос ушёл бы мимо транзакции.
    it('ответ сохранения несёт номера глав версии, прочитанные через tx', async () => {
      tx.bookAnalysis.create.mockResolvedValue(row());
      tx.chapter.findMany.mockResolvedValue([{ number: 1 }, { number: 4 }]);

      const res = await service.saveForVersion('v1', dto({ mainIdea: 'Idea' }), false);

      expect(res.analysis?.chapterNumbers).toEqual([1, 4]);
      // Ссылок на главы в теле нет - запрос глав один, за номерами для ответа.
      expect(tx.chapter.findMany).toHaveBeenCalledTimes(1);
      expect(tx.chapter.findMany).toHaveBeenCalledWith({
        where: { bookVersionId: 'v1' },
        select: { number: true },
        orderBy: { number: 'asc' },
        take: CHAPTER_NUMBERS_LIMIT,
      });
      expect(prisma.chapter.findMany).not.toHaveBeenCalled();
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
