import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateChapterDto } from './dto/create-chapter.dto';
import { UpdateChapterDto } from './dto/update-chapter.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class ChapterService {
  constructor(private prisma: PrismaService) {}

  listByVersion(bookVersionId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    return this.prisma.chapter.findMany({
      where: { bookVersionId },
      orderBy: { number: 'asc' },
      skip,
      take: limit,
    });
  }

  async create(bookVersionId: string, dto: CreateChapterDto) {
    const exists = await this.prisma.chapter.findFirst({
      where: { bookVersionId, number: dto.number },
      select: { id: true },
    });
    if (exists) {
      throw new BadRequestException('Chapter number must be unique within a version');
    }
    try {
      return await this.prisma.chapter.create({
        data: { bookVersionId, number: dto.number, title: dto.title, content: dto.content },
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
