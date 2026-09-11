import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

// Полке нужны карточка версии и адрес книги — и ничего больше. Выборка перечисляет поля
// поимённо не для красоты: `include` тянул всю строку `BookVersion`, включая 29 правовых
// колонок и `rightsContentHashInput`, и отдавал их наружу на каждом элементе полки.
const BOOKSHELF_VERSION_SELECT = {
  id: true,
  bookId: true,
  language: true,
  title: true,
  author: true,
  description: true,
  coverImageUrl: true,
  type: true,
  isFree: true,
  createdAt: true,
  updatedAt: true,
  slug: true,
  book: { select: { id: true, slug: true } },
  _count: { select: { chapters: true } },
} satisfies Prisma.BookVersionSelect;

type BookshelfBookVersion = Omit<
  Prisma.BookVersionGetPayload<{ select: typeof BOOKSHELF_VERSION_SELECT }>,
  '_count'
> & { chaptersCount: number };

@Injectable()
export class BookshelfService {
  constructor(private prisma: PrismaService) {}

  async list(
    userId: string,
    page = 1,
    limit = 10,
  ): Promise<{
    items: { id: string; addedAt: Date; bookVersion: BookshelfBookVersion }[];
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
        include: {
          bookVersion: { select: BOOKSHELF_VERSION_SELECT },
        },
      }),
      this.prisma.bookshelf.count({ where: { userId } }),
    ]);
    const hasNext = itemsRaw.length > limit;
    const items = itemsRaw.slice(0, limit).map((i) => {
      // `_count` — служебная форма запроса, а не поле ответа: наружу идёт готовое число.
      const { _count, ...version } = i.bookVersion;
      return {
        id: i.id,
        addedAt: i.addedAt,
        bookVersion: {
          ...version,
          chaptersCount: _count?.chapters || 0,
        },
      };
    });
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
