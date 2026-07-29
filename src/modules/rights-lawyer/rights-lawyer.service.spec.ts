import { PrismaService } from '../../prisma/prisma.service';
import { RightsLawyerService } from './rights-lawyer.service';
import { RightsLawyerType, type RightsLawyerRecord } from './rights-lawyer-interface';

const makeLawyer = (overrides: Partial<RightsLawyerRecord> = {}): RightsLawyerRecord => ({
  id: 'lawyer-1',
  fullName: 'Иванова Анна Сергеевна',
  lawyerType: RightsLawyerType.EXTERNAL_COUNSEL,
  organization: 'Юридическое бюро',
  barId: null,
  email: 'anna@example.com',
  phone: null,
  jurisdictionCodes: ['RU', 'US'],
  specializationRu: null,
  notesRu: null,
  userId: null,
  isActive: true,
  deactivatedAt: null,
  deactivatedByUserId: null,
  deactivateReasonRu: null,
  createdByUserId: 'user-1',
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  ...overrides,
});

const createPrismaStub = () => ({
  rightsLawyer: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(makeLawyer()),
    create: jest.fn().mockResolvedValue(makeLawyer()),
    update: jest.fn().mockResolvedValue(makeLawyer()),
    count: jest.fn().mockResolvedValue(0),
  },
  rightsLawyerReview: { count: jest.fn().mockResolvedValue(0) },
  rightsLegalOpinion: { count: jest.fn().mockResolvedValue(0) },
  user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-9', name: null, email: 'a@b.c' }) },
});

describe('RightsLawyerService', () => {
  let prisma: ReturnType<typeof createPrismaStub>;
  let service: RightsLawyerService;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new RightsLawyerService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('normalises jurisdiction codes to upper case and deduplicates them', async () => {
      await service.create(
        { fullName: '  Иванова А. С.  ', jurisdictionCodes: ['ru', 'RU', 'us'] },
        'user-1',
      );

      const data = prisma.rightsLawyer.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['jurisdictionCodes']).toEqual(['RU', 'US']);
      expect(data['fullName']).toBe('Иванова А. С.');
      expect(data['lawyerType']).toBe(RightsLawyerType.EXTERNAL_COUNSEL);
      expect(data['createdByUserId']).toBe('user-1');
    });

    it('rejects an invalid jurisdiction code', async () => {
      await expect(
        service.create({ fullName: 'Юрист', jurisdictionCodes: ['RUS'] }, 'user-1'),
      ).rejects.toMatchObject({
        response: { code: 'LAWYER_INVALID_JURISDICTION', statusCode: 400 },
      });
    });

    it('rejects linking a user that does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.create({ fullName: 'Юрист', userId: 'ghost' }, 'user-1'),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_USER_NOT_FOUND', statusCode: 404 } });
    });

    it('rejects a user already linked to another lawyer', async () => {
      prisma.rightsLawyer.findFirst.mockResolvedValue(makeLawyer({ id: 'lawyer-other' }));
      await expect(
        service.create({ fullName: 'Юрист', userId: 'user-9' }, 'user-1'),
      ).rejects.toMatchObject({
        response: { code: 'LAWYER_USER_ALREADY_LINKED', statusCode: 409 },
      });
    });

    it('allows re-linking the same user to the same lawyer on update', async () => {
      prisma.rightsLawyer.findUnique.mockResolvedValue(makeLawyer({ userId: 'user-9' }));
      prisma.rightsLawyer.findFirst.mockResolvedValue(makeLawyer({ userId: 'user-9' }));

      await expect(service.update('lawyer-1', { userId: 'user-9' })).resolves.toBeDefined();
    });
  });

  describe('deactivate / activate', () => {
    it('requires a reason of at least 10 characters', async () => {
      await expect(
        service.deactivate('lawyer-1', { reasonRu: 'коротко' }, 'user-1'),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_REASON_TOO_SHORT', statusCode: 400 } });
    });

    it('marks the lawyer inactive instead of deleting the row', async () => {
      await service.deactivate('lawyer-1', { reasonRu: 'больше не сотрудничаем' }, 'user-1');

      const data = prisma.rightsLawyer.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['isActive']).toBe(false);
      expect(data['deactivateReasonRu']).toBe('больше не сотрудничаем');
      expect(prisma.rightsLawyer).not.toHaveProperty('delete');
    });

    it('clears the deactivation audit on activate', async () => {
      await service.activate('lawyer-1');

      const data = prisma.rightsLawyer.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).toEqual({
        isActive: true,
        deactivatedAt: null,
        deactivatedByUserId: null,
        deactivateReasonRu: null,
      });
    });
  });

  describe('requireActiveLawyer', () => {
    it('rejects a deactivated lawyer', async () => {
      prisma.rightsLawyer.findUnique.mockResolvedValue(makeLawyer({ isActive: false }));
      await expect(service.requireActiveLawyer('lawyer-1')).rejects.toMatchObject({
        response: { code: 'LAWYER_INACTIVE', statusCode: 409 },
      });
    });

    it('reports LAWYER_NOT_FOUND for an unknown id', async () => {
      prisma.rightsLawyer.findUnique.mockResolvedValue(null);
      await expect(service.requireActiveLawyer('ghost')).rejects.toMatchObject({
        response: { code: 'LAWYER_NOT_FOUND', statusCode: 404 },
      });
    });
  });

  describe('list', () => {
    it('filters by jurisdiction in memory because the column is JSON', async () => {
      prisma.rightsLawyer.findMany.mockResolvedValue([
        makeLawyer({ id: 'a', jurisdictionCodes: ['RU'] }),
        makeLawyer({ id: 'b', jurisdictionCodes: ['US'] }),
      ]);

      const result = await service.list({ jurisdictionCode: 'us' });

      expect(result.items.map((item) => item.id)).toEqual(['b']);
      expect(result.total).toBe(1);
    });
  });

  describe('toDto', () => {
    it('reports hasLawyerRole false when the linked user has no lawyer role', () => {
      const dto = service.toDto(
        makeLawyer({
          userId: 'user-9',
          user: { id: 'user-9', name: null, email: 'a@b.c', roles: [{ role: { name: 'admin' } }] },
        }),
      );
      expect(dto.hasLawyerRole).toBe(false);
      expect(dto.userEmail).toBe('a@b.c');
    });

    it('reports hasLawyerRole true when the role is present', () => {
      const dto = service.toDto(
        makeLawyer({
          userId: 'user-9',
          user: { id: 'user-9', name: null, email: 'a@b.c', roles: [{ role: { name: 'lawyer' } }] },
        }),
      );
      expect(dto.hasLawyerRole).toBe(true);
    });
  });
});
