import { BookSummaryService } from './book-summary.service';
import { PrismaService } from '../../prisma/prisma.service';

interface PrismaStub {
  bookVersion: { findUnique: jest.Mock };
  bookSummary: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  bookVersion: { findUnique: jest.fn() },
  bookSummary: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
});

describe('BookSummaryService', () => {
  let service: BookSummaryService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new BookSummaryService(prisma as unknown as PrismaService);
  });

  it('getByVersion throws when version not found', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue(null);
    await expect(service.getByVersion('missing')).rejects.toThrow('BookVersion not found');
  });

  it('getByVersion returns first summary', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's1', bookVersionId: 'v1', summary: 'S' });
    const res = await service.getByVersion('v1');
    expect(res?.id).toBe('s1');
  });

  it('upsertForVersion creates when missing', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
    prisma.bookSummary.findFirst.mockResolvedValue(null);
    prisma.bookSummary.create.mockResolvedValue({ id: 's2', bookVersionId: 'v1', summary: 'NS' });
    const res = await service.upsertForVersion('v1', { summary: 'NS' });
    expect(res.id).toBe('s2');
    expect(prisma.bookSummary.create).toHaveBeenCalled();
  });

  it('upsertForVersion updates when exists', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's1', bookVersionId: 'v1', summary: 'S' });
    prisma.bookSummary.update.mockResolvedValue({ id: 's1', bookVersionId: 'v1', summary: 'UPD' });
    const res = await service.upsertForVersion('v1', { summary: 'UPD' });
    expect(res.summary).toBe('UPD');
    expect(prisma.bookSummary.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { summary: 'UPD' },
    });
  });
});
