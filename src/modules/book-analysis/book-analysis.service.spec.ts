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
import { getSupportedLanguages } from '../../shared/language/language.util';
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
    bookVersion: { findUnique: jest.Mock; findMany: jest.Mock };
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
        findMany: jest.fn().mockResolvedValue([]),
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

    // F03-3: номера глав и анализ читаются одним обходом, а не друг за другом.
    it('номера глав запрашиваются, не дожидаясь чтения анализа', async () => {
      let resolveRow: (value: unknown) => void = () => undefined;
      prisma.bookAnalysis.findUnique.mockReturnValue(
        new Promise((resolve) => {
          resolveRow = resolve;
        }),
      );
      prisma.chapter.findMany.mockResolvedValue([{ number: 3 }]);

      const pending = service.getByVersion('v1', undefined, null);
      await new Promise((resolve) => setImmediate(resolve));
      expect(prisma.chapter.findMany).toHaveBeenCalledTimes(1);

      resolveRow(row());
      await expect(pending).resolves.toMatchObject({ chapterNumbers: [3] });
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
      bookVersion: {
        language: 'en',
        status: 'published',
        book: { id: 'bk', slug: 'b', versions: [{ slug: `s-${id}`, language: 'en' }] },
      },
      ...over,
    });
    const owner = (slug: string, language: string, bookId: string) => ({ slug, language, bookId });

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
          bookVersion: { select: { book: { select: { versions: { where: unknown } } } } };
        };
      };
      expect(args.where).toEqual(settledClaimBlockWhere(now, GeoBlockScope.TEXT_READER));
      expect(args.take).toBe(CLAIM_CLOSURES_BATCH);
      expect(args.select.book.select.versions.where).toEqual({ status: 'published' });
      expect(args.select.bookVersion.select.book.select.versions.where).toEqual({
        status: 'published',
      });
      expect(args.select.reasonRu).toBeUndefined();
    });

    it('владельцы слагов - один запрос на порцию, только опубликованные, по языку asc, как getOverview', async () => {
      prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
        versionBlock('1'),
        versionBlock('2'),
      ]);
      await service.listClaimClosures();
      expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(1);
      const args = prisma.bookVersion.findMany.mock.calls[0][0] as {
        where: { status: string; slug: { in: string[] }; language: { in: string[] } };
        orderBy: unknown;
      };
      expect(args.where.status).toBe('published');
      expect([...args.where.slug.in].sort()).toEqual(['b', 's-1', 's-2']);
      expect(args.where.language.in).toEqual(getSupportedLanguages());
      expect(args.orderBy).toEqual({ language: 'asc' });
    });

    it('блок на книгу - элемент на каждую опубликованную версию; блок версии - её язык; черновик и книга без опубликованных версий не попадают', async () => {
      const expiresAt = new Date('2026-12-01T00:00:00Z');
      const hamlet = {
        id: 'bk1',
        slug: 'hamlet',
        versions: [
          { slug: 'hamlet-en', language: 'en' },
          { slug: null, language: 'ru' },
        ],
      };
      prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
        versionBlock('1', {
          scope: GeoBlockScope.ENTIRE_BOOK,
          countryCode: 'de',
          book: hamlet,
          bookVersion: null,
        }),
        versionBlock('2', {
          countryCode: null,
          expiresAt,
          bookVersion: { language: 'ru', status: 'published', book: hamlet },
        }),
        versionBlock('3', {
          scope: GeoBlockScope.LANGUAGE_EDITION,
          bookVersion: {
            language: 'fr',
            status: 'draft',
            book: { id: 'bk3', slug: 'y', versions: [] },
          },
        }),
        versionBlock('4', {
          scope: GeoBlockScope.ENTIRE_BOOK,
          book: { id: 'bk4', slug: 'secret-book', versions: [] },
          bookVersion: null,
        }),
      ]);
      prisma.bookVersion.findMany.mockResolvedValue([owner('hamlet-en', 'en', 'bk1')]);
      // ru-версия без слага открывается и по слагу en-версии своей книги (запасной поиск getOverview).
      await expect(service.listClaimClosures()).resolves.toEqual({
        items: [
          { slugs: ['hamlet', 'hamlet-en'], language: 'en', countryCode: 'DE', expiresAt: null },
          { slugs: ['hamlet', 'hamlet-en'], language: 'ru', countryCode: 'DE', expiresAt: null },
          { slugs: ['hamlet', 'hamlet-en'], language: 'ru', countryCode: null, expiresAt },
        ],
      });
    });

    // F03-2f: адрес отдаётся книге, которой его отдаёт getOverview: версия в языке адреса, затем
    // версия в любом языке, затем Book.slug. Чужой адрес не закрывается.
    it('Book.slug, которым в этом языке владеет версия другой книги, не отдаётся', async () => {
      prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
        versionBlock('1', {
          scope: GeoBlockScope.ENTIRE_BOOK,
          book: {
            id: 'bkA',
            slug: 'hamlet',
            versions: [
              { slug: 'hamlet-en', language: 'en' },
              { slug: null, language: 'ru' },
            ],
          },
          bookVersion: null,
        }),
      ]);
      prisma.bookVersion.findMany.mockResolvedValue([
        owner('hamlet-en', 'en', 'bkA'),
        owner('hamlet', 'ru', 'bkB'),
      ]);
      await expect(service.listClaimClosures()).resolves.toEqual({
        items: [
          { slugs: ['hamlet-en'], language: 'en', countryCode: 'GB', expiresAt: null },
          { slugs: ['hamlet-en'], language: 'ru', countryCode: 'GB', expiresAt: null },
        ],
      });
    });

    it('Book.slug, которым владеет версия другой книги в другом языке, не отдаётся (запасной поиск)', async () => {
      prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
        versionBlock('1', {
          bookVersion: {
            language: 'ru',
            status: 'published',
            book: { id: 'bkA', slug: 'hamlet', versions: [{ slug: null, language: 'ru' }] },
          },
        }),
      ]);
      prisma.bookVersion.findMany.mockResolvedValue([owner('hamlet', 'fr', 'bkB')]);
      // Адресов у ru-версии не осталось: /ru/book/hamlet открывает книгу B - элемента нет.
      await expect(service.listClaimClosures()).resolves.toEqual({ items: [] });
    });

    it('свой слаг в языке адреса важнее чужого в другом языке', async () => {
      prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
        versionBlock('1', {
          bookVersion: {
            language: 'en',
            status: 'published',
            book: { id: 'bkA', slug: 'a', versions: [{ slug: 'hamlet', language: 'en' }] },
          },
        }),
      ]);
      prisma.bookVersion.findMany.mockResolvedValue([
        owner('hamlet', 'es', 'bkB'),
        owner('hamlet', 'en', 'bkA'),
      ]);
      await expect(service.listClaimClosures()).resolves.toEqual({
        items: [{ slugs: ['a', 'hamlet'], language: 'en', countryCode: 'GB', expiresAt: null }],
      });
    });

    it('слаг версии своей книги в другом языке закрывает и эту версию, пока его не держит чужая версия языка адреса', async () => {
      const book = {
        id: 'bkA',
        slug: 'a',
        versions: [
          { slug: 'a-en', language: 'en' },
          { slug: 'a-ru', language: 'ru' },
        ],
      };
      prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([
        versionBlock('1', { bookVersion: { language: 'ru', status: 'published', book } }),
      ]);
      prisma.bookVersion.findMany.mockResolvedValue([
        owner('a-en', 'en', 'bkA'),
        owner('a-en', 'ru', 'bkB'),
        owner('a-ru', 'ru', 'bkA'),
      ]);
      await expect(service.listClaimClosures()).resolves.toEqual({
        items: [{ slugs: ['a', 'a-ru'], language: 'ru', countryCode: 'GB', expiresAt: null }],
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
      // Владельцы слагов - своим запросом на каждую порцию, по слагам именно этой порции.
      expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(2);
      const ownersOfSecond = prisma.bookVersion.findMany.mock.calls[1][0] as {
        where: { slug: { in: string[] } };
      };
      expect([...ownersOfSecond.where.slug.in].sort()).toEqual(['b', 's-last']);
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

    // F03-3: номера глав для ответа читаются после коммита и вне замка — замок их не защищает
    // и не должен ждать их чтения.
    it('ответ сохранения несёт номера глав версии, прочитанные после коммита транзакции', async () => {
      tx.bookAnalysis.create.mockResolvedValue(row());
      let committed = false;
      prisma.$transaction.mockImplementation(async (cb: (client: typeof tx) => unknown) => {
        const result = await cb(tx);
        committed = true;
        return result;
      });
      const readAfterCommit: boolean[] = [];
      prisma.chapter.findMany.mockImplementation(() => {
        readAfterCommit.push(committed);
        return Promise.resolve([{ number: 1 }, { number: 4 }]);
      });

      const res = await service.saveForVersion('v1', dto({ mainIdea: 'Idea' }), false);

      expect(res.analysis?.chapterNumbers).toEqual([1, 4]);
      // Ссылок на главы в теле нет - запрос глав один, за номерами для ответа, и не через `tx`.
      expect(tx.chapter.findMany).not.toHaveBeenCalled();
      expect(prisma.chapter.findMany).toHaveBeenCalledTimes(1);
      expect(readAfterCommit).toEqual([true]);
      expect(prisma.chapter.findMany).toHaveBeenCalledWith({
        where: { bookVersionId: 'v1' },
        select: { number: true },
        orderBy: { number: 'asc' },
        take: CHAPTER_NUMBERS_LIMIT,
      });
    });

    // F03-3: сбой чтения глав после коммита - отказ наружу, а не пустой список: «неизвестно» не равно
    // «глав нет» (ссылки на главы пропали бы молча). Запись при этом уже сохранена, повтор PUT
    // безопасен - слияние того же тела даёт ту же запись.
    it('сбой чтения глав после коммита - отказ наружу, запись не откатывается', async () => {
      tx.bookAnalysis.create.mockResolvedValue(row());
      prisma.chapter.findMany.mockRejectedValue(new Error('pool exhausted'));

      await expect(service.saveForVersion('v1', dto({ mainIdea: 'Idea' }), false)).rejects.toThrow(
        'pool exhausted',
      );
      expect(tx.bookAnalysis.create).toHaveBeenCalledTimes(1);
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
