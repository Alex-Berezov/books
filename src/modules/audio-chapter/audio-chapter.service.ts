import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAudioChapterDto } from './dto/create-audio-chapter.dto';
import { UpdateAudioChapterDto } from './dto/update-audio-chapter.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class AudioChapterService {
  constructor(private prisma: PrismaService) {}

  listByVersion(bookVersionId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    return this.prisma.audioChapter.findMany({
      where: { bookVersionId },
      orderBy: { number: 'asc' },
      skip,
      take: limit,
    });
  }

  async create(bookVersionId: string, dto: CreateAudioChapterDto) {
    const exists = await this.prisma.audioChapter.findFirst({
      where: { bookVersionId, number: dto.number },
      select: { id: true },
    });
    if (exists) {
      throw new BadRequestException('Audio chapter number must be unique within a version');
    }
    try {
      return await this.prisma.audioChapter.create({
        data: {
          bookVersionId,
          number: dto.number,
          title: dto.title,
          audioUrl: dto.audioUrl,
          duration: dto.duration,
        },
      });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Audio chapter number must be unique within a version');
      }
      throw e;
    }
  }

  async get(id: string) {
    const item = await this.prisma.audioChapter.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Audio chapter not found');
    return item;
  }

  async update(id: string, dto: UpdateAudioChapterDto) {
    const item = await this.prisma.audioChapter.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Audio chapter not found');

    if (dto.number !== undefined && dto.number !== item.number) {
      const dup = await this.prisma.audioChapter.findFirst({
        where: { bookVersionId: item.bookVersionId, number: dto.number },
        select: { id: true },
      });
      if (dup)
        throw new BadRequestException('Audio chapter number must be unique within a version');
    }

    return this.prisma.audioChapter.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    const item = await this.prisma.audioChapter.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Audio chapter not found');
    return this.prisma.audioChapter.delete({ where: { id } });
  }
}
