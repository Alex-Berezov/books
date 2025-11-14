import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class BookshelfService {
  constructor(private prisma: PrismaService) {}

  async list(
    userId: string,
    page = 1,
    limit = 10,
  ): Promise<{
    items: { id: string; addedAt: Date; bookVersion: any }[];
    page: number;
    limit: number;
    total: number;
    hasNext: boolean;
  }> {
    const skip = (page - 1) * limit;
    const [itemsRaw, total] = await this.prisma.$transaction([
      this.prisma.bookshelf.findMany({
        where: { userId },
        orderBy: { addedAt: 'desc' },
        skip,
        take: limit + 1, // +1 to compute hasNext without a second query
        include: { bookVersion: true },
      }),
      this.prisma.bookshelf.count({ where: { userId } }),
    ]);
    const hasNext = itemsRaw.length > limit;
    const items = itemsRaw.slice(0, limit).map((i) => ({
      id: i.id,
      addedAt: i.addedAt,
      bookVersion: i.bookVersion,
    }));
    return { items, page, limit, total, hasNext };
  }

  async add(userId: string, versionId: string) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    const existing = await this.prisma.bookshelf.findFirst({
      where: { userId, bookVersionId: versionId },
    });
    if (existing) return existing; // idempotent

    try {
      return await this.prisma.bookshelf.create({
        data: { userId, bookVersionId: versionId },
      });
    } catch {
      // fallback for race condition on unique constraint
      const found = await this.prisma.bookshelf.findFirst({
        where: { userId, bookVersionId: versionId },
      });
      if (found) return found;
      throw new BadRequestException('Unable to add to bookshelf');
    }
  }

  async remove(userId: string, versionId: string) {
    const existing = await this.prisma.bookshelf.findFirst({
      where: { userId, bookVersionId: versionId },
    });
    if (!existing) return { success: true };
    await this.prisma.bookshelf.delete({ where: { id: existing.id } });
    return { success: true };
  }
}
