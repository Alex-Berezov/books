import { RightsIntakeService } from './rights-intake.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RightsIntakeStatus } from '@prisma/client';

interface PrismaStub {
  rightsIntake: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  $transaction: jest.Mock;
}

const createPrismaStub = (): PrismaStub => {
  const stub: PrismaStub = {
    rightsIntake: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  stub.$transaction.mockImplementation(async (callbackOrArray: unknown) => {
    if (Array.isArray(callbackOrArray)) {
      return Promise.all(callbackOrArray as Array<Promise<unknown>>);
    }
    if (typeof callbackOrArray === 'function') {
      const fn = callbackOrArray as (tx: Omit<PrismaStub, '$transaction'>) => Promise<unknown>;
      return fn(stub);
    }
    return callbackOrArray;
  });

  return stub;
};

describe('RightsIntakeService', () => {
  let service: RightsIntakeService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new RightsIntakeService(prisma as unknown as PrismaService);
  });

  function mockTransactionArray() {
    prisma.$transaction.mockImplementation(async (arr: unknown[]) =>
      Promise.all(arr as Array<Promise<unknown>>),
    );
  }

  describe('create', () => {
    it('creates intake with required fields', async () => {
      const mockIntake = { id: 'intake-1', candidateTitle: 'Test Book', workflowStatus: 'DRAFT' };
      prisma.rightsIntake.create.mockResolvedValue(mockIntake);

      const dto = {
        candidateTitle: 'Test Book',
        candidateAuthor: 'Test Author',
        targetLanguages: ['en', 'fr'],
        targetCountryCodes: ['US', 'FR'],
        plannedContentTypes: ['TEXT'],
      };
      const result = await service.create(dto, 'user-1');

      expect(prisma.rightsIntake.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          candidateTitle: 'Test Book',
          candidateAuthor: 'Test Author',
          workflowStatus: 'DRAFT',
          createdByUserId: 'user-1',
        }),
      });
      expect(result).toEqual(mockIntake);
    });
  });

  /**
   * WP-F.1 (исток Б1): при очевидной ссылке на Gutenberg агент получал `provider: UNKNOWN`
   * и `textType: UNKNOWN`, а правило манифеста «при нехватке данных — pending review»
   * превращало это в осторожный отчёт. Вывод из ссылки заполняет только пробелы: явный
   * выбор редактора приложение не переписывает.
   */
  describe('WP-F.1: нормализация источника по URL', () => {
    const baseDto = {
      candidateTitle: 'The Fall of the House of Usher',
      candidateAuthor: 'Edgar Allan Poe',
      targetLanguages: ['en'],
      targetCountryCodes: ['US'],
      plannedContentTypes: ['TEXT'],
    };

    const createdData = (): Record<string, unknown> =>
      prisma.rightsIntake.create.mock.calls[0][0].data as Record<string, unknown>;

    const updatedData = (): Record<string, unknown> =>
      prisma.rightsIntake.update.mock.calls[0][0].data as Record<string, unknown>;

    it('выводит провайдера и внешний ID из ссылки на Gutenberg', async () => {
      prisma.rightsIntake.create.mockResolvedValue({ id: 'i1' });

      await service.create(
        { ...baseDto, sourceUrl: 'https://www.gutenberg.org/ebooks/932' },
        'user-1',
      );

      expect(createdData().sourceProvider).toBe('PROJECT_GUTENBERG');
      expect(createdData().sourceExternalId).toBe('932');
    });

    it('ставит ORIGINAL_TEXT при совпадении языка источника и оригинала', async () => {
      prisma.rightsIntake.create.mockResolvedValue({ id: 'i1' });

      await service.create(
        {
          ...baseDto,
          sourceUrl: 'https://www.gutenberg.org/files/932/932-0.txt',
          sourceLanguage: 'en',
          originalLanguage: 'en',
        },
        'user-1',
      );

      expect(createdData().sourceTextType).toBe('ORIGINAL_TEXT');
    });

    it('не выводит ORIGINAL_TEXT, когда языки не совпадают', async () => {
      prisma.rightsIntake.create.mockResolvedValue({ id: 'i1' });

      await service.create(
        {
          ...baseDto,
          sourceUrl: 'https://www.gutenberg.org/ebooks/932',
          sourceLanguage: 'ru',
          originalLanguage: 'en',
        },
        'user-1',
      );

      expect(createdData().sourceTextType).toBe('UNKNOWN');
    });

    /**
     * WP-M.1: у незнакомой площадки провайдер остаётся `UNKNOWN`. `OTHER` был бы тем же
     * «неизвестно», но уже неотличимым от выбора редактора: `readiness` перестал бы
     * предупреждать `SOURCE_PROVIDER_UNKNOWN`, а фильтр `?sourceProvider=UNKNOWN` —
     * находить такие записи.
     */
    it('незнакомый домен не устанавливает провайдера и не выдумывает внешний ID', async () => {
      prisma.rightsIntake.create.mockResolvedValue({ id: 'i1' });

      await service.create({ ...baseDto, sourceUrl: 'https://example.com/ebooks/932' }, 'user-1');

      expect(createdData().sourceProvider).toBe('UNKNOWN');
      expect(createdData().sourceExternalId).toBeNull();
    });

    it('не выводит ORIGINAL_TEXT для незнакомого домена даже при совпадении языков', async () => {
      prisma.rightsIntake.create.mockResolvedValue({ id: 'i1' });

      await service.create(
        {
          ...baseDto,
          sourceUrl: 'https://example.com/book',
          sourceLanguage: 'en',
          originalLanguage: 'en',
        },
        'user-1',
      );

      expect(createdData().sourceTextType).toBe('UNKNOWN');
    });

    it('выводит источник и внешний ID из ссылки на Викитеку', async () => {
      prisma.rightsIntake.create.mockResolvedValue({ id: 'i1' });

      await service.create(
        {
          ...baseDto,
          sourceUrl:
            'https://ru.wikisource.org/wiki/%D0%9F%D1%80%D0%B5%D1%81%D1%82%D1%83%D0%BF%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5_%D0%B8_%D0%BD%D0%B0%D0%BA%D0%B0%D0%B7%D0%B0%D0%BD%D0%B8%D0%B5_(%D0%94%D0%BE%D1%81%D1%82%D0%BE%D0%B5%D0%B2%D1%81%D0%BA%D0%B8%D0%B9)',
          sourceLanguage: 'ru',
          originalLanguage: 'ru',
        },
        'user-1',
      );

      expect(createdData().sourceProvider).toBe('OTHER');
      expect(createdData().sourceExternalId).toBe('Преступление_и_наказание_(Достоевский)');
      expect(createdData().sourceTextType).toBe('ORIGINAL_TEXT');
    });

    /**
     * Ветка обновления: тот же охранник, что и при создании. Без него `PATCH` с любой ссылкой
     * и совпадающими языками записывал бы `ORIGINAL_TEXT` — утверждение о природе источника,
     * выведенное из площадки, про которую не известно ничего.
     */
    it('update не выводит ORIGINAL_TEXT для незнакомого домена при совпадении языков', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'DRAFT',
        sourceProvider: 'UNKNOWN',
        sourceExternalId: null,
        sourceUrl: null,
        sourceLanguage: 'ru',
        originalLanguage: 'ru',
        sourceTextType: 'UNKNOWN',
      });
      prisma.rightsIntake.update.mockResolvedValue({ id: 'i1' });

      await service.update('i1', { sourceUrl: 'https://example.com/book' });

      expect(updatedData().sourceTextType).toBeUndefined();
      expect(updatedData().sourceProvider).toBeUndefined();
    });

    it('update заполняет провайдера по ссылке на узнанную площадку', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'DRAFT',
        sourceProvider: 'UNKNOWN',
        sourceExternalId: null,
        sourceUrl: null,
        sourceLanguage: 'ru',
        originalLanguage: 'ru',
        sourceTextType: 'UNKNOWN',
      });
      prisma.rightsIntake.update.mockResolvedValue({ id: 'i1' });

      await service.update('i1', { sourceUrl: 'https://ru.wikisource.org/wiki/Бедные_люди' });

      expect(updatedData().sourceProvider).toBe('OTHER');
      expect(updatedData().sourceExternalId).toBe('Бедные_люди');
      expect(updatedData().sourceTextType).toBe('ORIGINAL_TEXT');
    });

    it('не переписывает явный выбор редактора', async () => {
      prisma.rightsIntake.create.mockResolvedValue({ id: 'i1' });

      await service.create(
        {
          ...baseDto,
          sourceProvider: 'OTHER',
          sourceExternalId: 'manual-7',
          sourceTextType: 'TRANSLATION',
          sourceUrl: 'https://www.gutenberg.org/ebooks/932',
          sourceLanguage: 'en',
          originalLanguage: 'en',
        },
        'user-1',
      );

      expect(createdData().sourceProvider).toBe('OTHER');
      expect(createdData().sourceExternalId).toBe('manual-7');
      expect(createdData().sourceTextType).toBe('TRANSLATION');
    });

    it('update заполняет пробел, когда ссылку добавили позже', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'DRAFT',
        sourceProvider: 'UNKNOWN',
        sourceExternalId: null,
        sourceUrl: null,
        sourceLanguage: 'en',
        originalLanguage: 'en',
        sourceTextType: 'UNKNOWN',
      });
      prisma.rightsIntake.update.mockResolvedValue({ id: 'i1' });

      await service.update('i1', { sourceUrl: 'https://gutenberg.org/cache/epub/932/pg932.txt' });

      expect(updatedData().sourceProvider).toBe('PROJECT_GUTENBERG');
      expect(updatedData().sourceExternalId).toBe('932');
      expect(updatedData().sourceTextType).toBe('ORIGINAL_TEXT');
    });

    it('update не переписывает уже заполненный провайдер', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'DRAFT',
        sourceProvider: 'OTHER',
        sourceExternalId: 'manual-7',
        sourceUrl: null,
        sourceLanguage: 'en',
        originalLanguage: 'en',
        sourceTextType: 'TRANSLATION',
      });
      prisma.rightsIntake.update.mockResolvedValue({ id: 'i1' });

      await service.update('i1', { sourceUrl: 'https://www.gutenberg.org/ebooks/932' });

      expect(updatedData().sourceProvider).toBeUndefined();
      expect(updatedData().sourceExternalId).toBeUndefined();
      expect(updatedData().sourceTextType).toBeUndefined();
    });
  });

  describe('list', () => {
    it('lists intakes with pagination', async () => {
      const items = [{ id: 'i1' }, { id: 'i2' }];
      prisma.rightsIntake.count.mockResolvedValue(2);
      prisma.rightsIntake.findMany.mockResolvedValue(items);
      mockTransactionArray();

      const result = await service.list({ page: 1, limit: 20 });
      expect(result.items).toEqual(items);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('filters by status', async () => {
      prisma.rightsIntake.count.mockResolvedValue(0);
      prisma.rightsIntake.findMany.mockResolvedValue([]);
      mockTransactionArray();

      await service.list({ status: RightsIntakeStatus.DRAFT });
      expect(prisma.rightsIntake.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workflowStatus: RightsIntakeStatus.DRAFT } }),
      );
    });

    it('searches by title', async () => {
      prisma.rightsIntake.count.mockResolvedValue(0);
      prisma.rightsIntake.findMany.mockResolvedValue([]);
      mockTransactionArray();

      await service.list({ q: 'odyssey' });
      expect(prisma.rightsIntake.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ candidateTitle: expect.anything() }),
            ]),
          }),
        }),
      );
    });

    it('excludes ARCHIVED when no status filter provided', async () => {
      prisma.rightsIntake.count.mockResolvedValue(0);
      prisma.rightsIntake.findMany.mockResolvedValue([]);
      mockTransactionArray();

      await service.list({});
      expect(prisma.rightsIntake.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workflowStatus: { not: 'ARCHIVED' } } }),
      );
      expect(prisma.rightsIntake.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workflowStatus: { not: 'ARCHIVED' } } }),
      );
    });

    it('filters by ARCHIVED when status=ARCHIVED', async () => {
      prisma.rightsIntake.count.mockResolvedValue(1);
      prisma.rightsIntake.findMany.mockResolvedValue([{ id: 'i1', workflowStatus: 'ARCHIVED' }]);
      mockTransactionArray();

      const result = await service.list({ status: RightsIntakeStatus.ARCHIVED });
      expect(prisma.rightsIntake.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workflowStatus: RightsIntakeStatus.ARCHIVED } }),
      );
      expect(result.total).toBe(1);
    });

    it('filters by targetLanguage using array_contains', async () => {
      prisma.rightsIntake.count.mockResolvedValue(1);
      prisma.rightsIntake.findMany.mockResolvedValue([{ id: 'i1', targetLanguages: ['en', 'fr'] }]);
      mockTransactionArray();

      await service.list({ targetLanguage: 'en' });
      expect(prisma.rightsIntake.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            targetLanguages: { array_contains: ['en'] },
          }),
        }),
      );
    });

    it('filters by sourceProvider', async () => {
      prisma.rightsIntake.count.mockResolvedValue(1);
      prisma.rightsIntake.findMany.mockResolvedValue([
        { id: 'i1', sourceProvider: 'PROJECT_GUTENBERG' },
      ]);
      mockTransactionArray();

      await service.list({ sourceProvider: 'PROJECT_GUTENBERG' as any });
      expect(prisma.rightsIntake.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            sourceProvider: 'PROJECT_GUTENBERG',
          }),
        }),
      );
    });

    it('filters by attentionOnly', async () => {
      prisma.rightsIntake.count.mockResolvedValue(1);
      prisma.rightsIntake.findMany.mockResolvedValue([{ id: 'i1', workflowStatus: 'DRAFT' }]);
      mockTransactionArray();

      await service.list({ attentionOnly: true });
      expect(prisma.rightsIntake.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              {
                workflowStatus: {
                  in: ['DRAFT', 'READY_FOR_AGENT', 'REVIEW_IMPORTED', 'HUMAN_REVIEW_REQUIRED'],
                },
              },
              { workflowStatus: 'APPROVED', createdBookId: null },
            ]),
          }),
        }),
      );
    });
  });

  describe('getById', () => {
    it('returns intake when found', async () => {
      const intake = { id: 'i1', candidateTitle: 'Test' };
      prisma.rightsIntake.findUnique.mockResolvedValue(intake);

      const result = await service.getById('i1');
      expect(result).toEqual(intake);
    });

    it('throws when not found', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(null);
      await expect(service.getById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates draft intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'DRAFT',
      });
      prisma.rightsIntake.update.mockResolvedValue({ id: 'i1', candidateTitle: 'Updated' });

      const result = await service.update('i1', { candidateTitle: 'Updated' });
      expect(prisma.rightsIntake.update).toHaveBeenCalled();
      expect(result).toEqual({ id: 'i1', candidateTitle: 'Updated' });
    });

    it('throws when updating archived intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'ARCHIVED',
      });
      await expect(service.update('i1', { candidateTitle: 'Updated' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('changeStatus', () => {
    it('allows DRAFT -> READY_FOR_AGENT', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'DRAFT',
      });
      prisma.rightsIntake.update.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'READY_FOR_AGENT',
      });

      const result = await service.changeStatus('i1', RightsIntakeStatus.READY_FOR_AGENT);
      expect(result.workflowStatus).toBe('READY_FOR_AGENT');
    });

    it('forbids DRAFT -> APPROVED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'DRAFT',
      });
      await expect(service.changeStatus('i1', RightsIntakeStatus.APPROVED)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('archive', () => {
    it('archives intake (soft delete)', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'DRAFT',
      });
      const archived = { id: 'i1', workflowStatus: 'ARCHIVED', archivedAt: new Date() };
      prisma.rightsIntake.update.mockResolvedValue(archived);

      const result = await service.archive('i1');
      expect(result.workflowStatus).toBe('ARCHIVED');
      expect(prisma.rightsIntake.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'i1' },
          data: expect.objectContaining({
            workflowStatus: 'ARCHIVED',
            archivedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('archives READY_FOR_AGENT intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'READY_FOR_AGENT',
      });
      prisma.rightsIntake.update.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'ARCHIVED',
        archivedAt: new Date(),
      });

      const result = await service.archive('i1');
      expect(result.workflowStatus).toBe('ARCHIVED');
    });

    it('throws if already archived', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'ARCHIVED',
      });
      await expect(service.archive('i1')).rejects.toThrow(BadRequestException);
    });

    it('throws when archiving APPROVED intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'APPROVED',
      });
      await expect(service.archive('i1')).rejects.toThrow(BadRequestException);
    });

    it('throws when archiving REJECTED intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'REJECTED',
      });
      await expect(service.archive('i1')).rejects.toThrow(BadRequestException);
    });

    it('throws when archiving BOOK_CREATED intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'BOOK_CREATED',
      });
      await expect(service.archive('i1')).rejects.toThrow(BadRequestException);
    });

    // WP-L.3: смягчённая сторона — администратору статус не мешает. Строгая сторона остаётся
    // выше: те же статусы без `force` по-прежнему отклоняются.
    it.each(['REVIEW_IMPORTED', 'HUMAN_REVIEW_REQUIRED', 'APPROVED', 'REJECTED', 'BOOK_CREATED'])(
      'archives %s intake when forced',
      async (workflowStatus) => {
        prisma.rightsIntake.findUnique.mockResolvedValue({ id: 'i1', workflowStatus });
        prisma.rightsIntake.update.mockResolvedValue({
          id: 'i1',
          workflowStatus: 'ARCHIVED',
          archivedAt: new Date(),
        });

        const result = await service.archive('i1', { force: true });
        expect(result.workflowStatus).toBe('ARCHIVED');
        expect(prisma.rightsIntake.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'i1' },
            data: expect.objectContaining({
              workflowStatus: 'ARCHIVED',
              archivedAt: expect.any(Date),
            }),
          }),
        );
      },
    );

    // Единственное, что `force` не обходит: повторная архивация. Иначе `archivedAt` переписывался
    // бы на новую дату и след «когда запись вывели из работы» терялся.
    it('throws when forcing an already archived intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'i1',
        workflowStatus: 'ARCHIVED',
      });
      await expect(service.archive('i1', { force: true })).rejects.toThrow(BadRequestException);
    });
  });
});
