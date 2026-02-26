import { ChapterService } from './chapter.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

interface PrismaStub {
  chapter: {
    findMany: (args: Prisma.ChapterFindManyArgs) => Promise<any[]>;
    findFirst: (args: Prisma.ChapterFindFirstArgs) => Promise<{ id: string } | null>;
    create: (args: Prisma.ChapterCreateArgs) => Promise<any>;
    findUnique: (args: Prisma.ChapterFindUniqueArgs) => Promise<{ id: string } | null>;
    update: (args: Prisma.ChapterUpdateArgs) => Promise<any>;
    delete: (args: Prisma.ChapterDeleteArgs) => Promise<any>;
  };
}

const createPrismaStub = (): PrismaStub => ({
  chapter: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
});

describe('ChapterService', () => {
  let service: ChapterService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new ChapterService(prisma as unknown as PrismaService);
  });

  it('lists all chapters by version when no pagination', async () => {
    (prisma.chapter.findMany as jest.Mock).mockResolvedValue([
      { id: 'c1', number: 1 },
      { id: 'c2', number: 2 },
    ]);
    const res = await service.listByVersion('v1');
    expect(res.length).toBe(2);
    expect(prisma.chapter.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1' },
      orderBy: { number: 'asc' },
    });
  });

  it('lists chapters with pagination when page and limit provided', async () => {
    (prisma.chapter.findMany as jest.Mock).mockResolvedValue([{ id: 'c1', number: 1 }]);
    const res = await service.listByVersion('v1', 1, 10);
    expect(res.length).toBe(1);
    expect(prisma.chapter.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1' },
      orderBy: { number: 'asc' },
      skip: 0,
      take: 10,
    });
  });

  it('creates unique chapter by number', async () => {
    (prisma.chapter.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.chapter.create as jest.Mock).mockResolvedValue({ id: 'c1' });
    const res = await service.create('v1', { number: 1, title: 'T', content: 'C' });
    expect(res.id).toBe('c1');
  });

  it('auto-assigns next chapter number when number is omitted', async () => {
    // First findFirst call (auto-assign): returns last chapter with number 5
    // Second findFirst call (uniqueness check): returns null (no conflict)
    (prisma.chapter.findFirst as jest.Mock)
      .mockResolvedValueOnce({ number: 5 }) // last chapter
      .mockResolvedValueOnce(null); // uniqueness check
    (prisma.chapter.create as jest.Mock).mockResolvedValue({ id: 'c2', number: 6 });
    const res = await service.create('v1', { title: 'T', content: 'C' });
    expect(res.number).toBe(6);
    expect(prisma.chapter.create).toHaveBeenCalledWith({
      data: { bookVersionId: 'v1', number: 6, title: 'T', content: 'C' },
    });
  });

  it('auto-assigns number 1 when no chapters exist and number is omitted', async () => {
    (prisma.chapter.findFirst as jest.Mock)
      .mockResolvedValueOnce(null) // no last chapter
      .mockResolvedValueOnce(null); // uniqueness check
    (prisma.chapter.create as jest.Mock).mockResolvedValue({ id: 'c1', number: 1 });
    const res = await service.create('v1', { title: 'T', content: 'C' });
    expect(res.number).toBe(1);
  });

  it('rejects duplicate number', async () => {
    (prisma.chapter.findFirst as jest.Mock).mockResolvedValue({ id: 'exists' });
    await expect(
      service.create('v1', { number: 1, title: 'T', content: 'C' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('gets chapter', async () => {
    (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({ id: 'c1' });
    const res = await service.get('c1');
    expect(res.id).toBe('c1');
  });

  it('throws not found for missing chapter', async () => {
    (prisma.chapter.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.get('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates chapter with number uniqueness check', async () => {
    (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({
      id: 'c1',
      bookVersionId: 'v1',
      number: 1,
    });
    (prisma.chapter.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.chapter.update as jest.Mock).mockResolvedValue({ id: 'c1', number: 2 });
    const res = await service.update('c1', { number: 2 });
    expect(res.number).toBe(2);
  });

  it('removes chapter', async () => {
    (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({ id: 'c1' });
    (prisma.chapter.delete as jest.Mock).mockResolvedValue({ id: 'c1' });
    const res = await service.remove('c1');
    expect(res.id).toBe('c1');
  });
});
