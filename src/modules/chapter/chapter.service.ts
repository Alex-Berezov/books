import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateChapterDto } from './dto/create-chapter.dto';
import { UpdateChapterDto } from './dto/update-chapter.dto';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { Prisma } from '@prisma/client';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';

@Injectable()
export class ChapterService {
  constructor(
    private prisma: PrismaService,
    private rightsContentHashService: RightsContentHashService,
    private geoBlockRuleService: GeoBlockRuleService,
  ) {}

  async listByVersion(
    bookVersionId: string,
    page?: number,
    limit?: number,
    countryCode: string | null = null,
  ) {
    await this.ensureVersionPublished(bookVersionId);
    await this.geoBlockRuleService.assertAccess({
      bookVersionId,
      countryCode,
      scope: GeoBlockScope.TEXT_READER,
    });

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
      const chapter = await this.prisma.$transaction(async (tx) => {
        const created = await tx.chapter.create({
          data: { bookVersionId, number: chapterNumber, title: dto.title, content: dto.content },
        });
        await this.rightsContentHashService.checkVersionStaleness(
          bookVersionId,
          'CHAPTER_CREATED',
          null,
          true,
          tx,
        );
        return created;
      });
      return chapter;
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Chapter number must be unique within a version');
      }
      throw e;
    }
  }

  async get(id: string, countryCode: string | null = null) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id } });
    if (!chapter) throw new NotFoundException('Chapter not found');
    await this.ensureVersionPublished(chapter.bookVersionId);
    await this.geoBlockRuleService.assertAccess({
      bookVersionId: chapter.bookVersionId,
      countryCode,
      scope: GeoBlockScope.TEXT_READER,
    });
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

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.chapter.update({ where: { id }, data: dto });
      await this.rightsContentHashService.checkVersionStaleness(
        chapter.bookVersionId,
        'CHAPTER_UPDATED',
        null,
        true,
        tx,
      );
      return result;
    });
    return updated;
  }

  async remove(id: string) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id } });
    if (!chapter) throw new NotFoundException('Chapter not found');
    const bookVersionId = chapter.bookVersionId;
    const result = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.chapter.delete({ where: { id } });
      await this.rightsContentHashService.checkVersionStaleness(
        bookVersionId,
        'CHAPTER_DELETED',
        null,
        true,
        tx,
      );
      return deleted;
    });
    return result;
  }

  private async ensureVersionPublished(bookVersionId: string): Promise<void> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { status: true },
    });
    if (!version || version.status !== 'published') {
      throw new NotFoundException('Book version not found');
    }
  }
}
