import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateChapterDto } from './dto/create-chapter.dto';
import { UpdateChapterDto } from './dto/update-chapter.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class ChapterService {
  constructor(private prisma: PrismaService) {}

  listByVersion(bookVersionId: string, page?: number, limit?: number) {
    if (page && limit) {
      const skip = (page - 1) * limit;
      return this.prisma.chapter.findMany({
        where: { bookVersionId },
        orderBy: { number: 'asc' },
        skip,
        take: limit,
      });
    }
    return this.prisma.chapter.findMany({
      where: { bookVersionId },
      orderBy: { number: 'asc' },
    });
  }

  async create(bookVersionId: string, dto: CreateChapterDto) {
    let chapterNumber = dto.number;

    // Auto-assign number if not provided
    if (chapterNumber === undefined || chapterNumber === null) {
      const last = await this.prisma.chapter.findFirst({
        where: { bookVersionId },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      chapterNumber = last ? last.number + 1 : 1;
    }

    const exists = await this.prisma.chapter.findFirst({
      where: { bookVersionId, number: chapterNumber },
      select: { id: true },
    });
    if (exists) {
      throw new BadRequestException('Chapter number must be unique within a version');
    }
    try {
      return await this.prisma.chapter.create({
        data: { bookVersionId, number: chapterNumber, title: dto.title, content: dto.content },
      });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Chapter number must be unique within a version');
      }
      throw e;
    }
  }

  async get(id: string) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id } });
    if (!chapter) throw new NotFoundException('Chapter not found');
    return chapter;
  }

  async update(id: string, dto: UpdateChapterDto) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id } });
    if (!chapter) throw new NotFoundException('Chapter not found');

    if (dto.number !== undefined && dto.number !== chapter.number) {
      const dup = await this.prisma.chapter.findFirst({
        where: { bookVersionId: chapter.bookVersionId, number: dto.number },
        select: { id: true },
      });
      if (dup) throw new BadRequestException('Chapter number must be unique within a version');
    }

    return this.prisma.chapter.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id } });
    if (!chapter) throw new NotFoundException('Chapter not found');
    return this.prisma.chapter.delete({ where: { id } });
  }
}
