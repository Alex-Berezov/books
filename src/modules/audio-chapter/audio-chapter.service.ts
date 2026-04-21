import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAudioChapterDto } from './dto/create-audio-chapter.dto';
import { UpdateAudioChapterDto } from './dto/update-audio-chapter.dto';
import { Prisma } from '@prisma/client';

export interface PaginatedAudioChapters<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class AudioChapterService {
  constructor(private prisma: PrismaService) {}

  private normalizePage(page = 1, limit = 50) {
    const p = Math.max(1, Math.floor(page));
    const l = Math.min(100, Math.max(1, Math.floor(limit)));
    return { page: p, limit: l };
  }

  private async ensureVersionPublished(bookVersionId: string): Promise<void> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true, status: true },
    });
    if (!version || version.status !== 'published') {
      throw new NotFoundException('Book version not found');
    }
  }

  private async ensureVersionExists(bookVersionId: string): Promise<void> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true },
    });
    if (!version) throw new NotFoundException('Book version not found');
  }

  private async validateMediaId(mediaId: string | undefined | null): Promise<void> {
    if (!mediaId) return;
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { id: true, isDeleted: true },
    });
    if (!media || media.isDeleted) {
      throw new BadRequestException('Referenced mediaId does not exist');
    }
  }

  private conflict(number: number) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: `Audio chapter with number ${number} already exists in this version`,
      field: 'number',
    });
  }

  async listPublic(
    bookVersionId: string,
    page = 1,
    limit = 50,
  ): Promise<PaginatedAudioChapters<unknown>> {
    await this.ensureVersionPublished(bookVersionId);
    return this.listInternal(bookVersionId, page, limit);
  }

  async listAdmin(
    bookVersionId: string,
    page = 1,
    limit = 50,
  ): Promise<PaginatedAudioChapters<unknown>> {
    await this.ensureVersionExists(bookVersionId);
    return this.listInternal(bookVersionId, page, limit);
  }

  private async listInternal(
    bookVersionId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedAudioChapters<unknown>> {
    const { page: p, limit: l } = this.normalizePage(page, limit);
    const skip = (p - 1) * l;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.audioChapter.findMany({
        where: { bookVersionId },
        orderBy: { number: 'asc' },
        skip,
        take: l,
      }),
      this.prisma.audioChapter.count({ where: { bookVersionId } }),
    ]);
    return {
      items,
      total,
      page: p,
      limit: l,
      totalPages: Math.max(1, Math.ceil(total / l)),
    };
  }

  async create(bookVersionId: string, dto: CreateAudioChapterDto) {
    await this.ensureVersionExists(bookVersionId);
    await this.validateMediaId(dto.mediaId);

    const exists = await this.prisma.audioChapter.findFirst({
      where: { bookVersionId, number: dto.number },
      select: { id: true },
    });
    if (exists) throw this.conflict(dto.number);

    try {
      return await this.prisma.audioChapter.create({
        data: {
          bookVersionId,
          number: dto.number,
          title: dto.title,
          audioUrl: dto.audioUrl,
          duration: dto.duration,
          description: dto.description ?? null,
          transcript: dto.transcript ?? null,
          mediaId: dto.mediaId ?? null,
        },
      });
    } catch (e) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw this.conflict(dto.number);
      }
      throw e;
    }
  }

  async getPublic(id: string) {
    const item = await this.prisma.audioChapter.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Audio chapter not found');
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: item.bookVersionId },
      select: { status: true },
    });
    if (!version || version.status !== 'published') {
      throw new NotFoundException('Audio chapter not found');
    }
    return item;
  }

  async getAdmin(id: string) {
    const item = await this.prisma.audioChapter.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Audio chapter not found');
    return item;
  }

  async update(id: string, dto: UpdateAudioChapterDto) {
    const item = await this.prisma.audioChapter.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Audio chapter not found');

    if (dto.mediaId !== undefined) {
      await this.validateMediaId(dto.mediaId);
    }

    if (dto.number !== undefined && dto.number !== item.number) {
      const dup = await this.prisma.audioChapter.findFirst({
        where: { bookVersionId: item.bookVersionId, number: dto.number },
        select: { id: true },
      });
      if (dup) throw this.conflict(dto.number);
    }

    try {
      return await this.prisma.audioChapter.update({ where: { id }, data: dto });
    } catch (e) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw this.conflict(dto.number ?? item.number);
      }
      throw e;
    }
  }

  async remove(id: string) {
    const item = await this.prisma.audioChapter.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Audio chapter not found');
    return this.prisma.audioChapter.delete({ where: { id } });
  }

  async reorder(bookVersionId: string, audioChapterIds: string[]) {
    await this.ensureVersionExists(bookVersionId);

    const existing = await this.prisma.audioChapter.findMany({
      where: { bookVersionId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((e) => e.id));

    if (audioChapterIds.length !== existingIds.size) {
      throw new BadRequestException(
        'audioChapterIds must contain every chapter of the version exactly once',
      );
    }
    for (const id of audioChapterIds) {
      if (!existingIds.has(id)) {
        throw new BadRequestException(`Audio chapter ${id} does not belong to this version`);
      }
    }

    // Two-step renumber to avoid unique constraint collisions.
    const OFFSET = 1_000_000;
    await this.prisma.$transaction([
      ...audioChapterIds.map((id, idx) =>
        this.prisma.audioChapter.update({
          where: { id },
          data: { number: idx + 1 + OFFSET },
        }),
      ),
      ...audioChapterIds.map((id, idx) =>
        this.prisma.audioChapter.update({
          where: { id },
          data: { number: idx + 1 },
        }),
      ),
    ]);

    return this.prisma.audioChapter.findMany({
      where: { bookVersionId },
      orderBy: { number: 'asc' },
    });
  }
}
