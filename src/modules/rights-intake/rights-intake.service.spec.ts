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
  });
});
