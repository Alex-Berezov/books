import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookVersionDto } from './dto/create-book-version.dto';
import { UpdateBookVersionDto } from './dto/update-book-version.dto';
import { Prisma } from '@prisma/client';
import { Language, BookType } from '@prisma/client';

@Injectable()
export class BookVersionService {
  constructor(private prisma: PrismaService) {}

  async list(bookId: string, filters: { language?: Language; type?: BookType; isFree?: boolean }) {
    const where: Prisma.BookVersionWhereInput = {
      bookId,
      ...(filters.language ? { language: filters.language } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.isFree !== undefined ? { isFree: filters.isFree } : {}),
      status: 'published',
    };
    return this.prisma.bookVersion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
  }

  async create(bookId: string, dto: CreateBookVersionDto) {
    const existing = await this.prisma.bookVersion.findFirst({
      where: { bookId, language: dto.language },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('Version for this language already exists for this book');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        let seoId: number | undefined;
        if (dto.seoMetaTitle || dto.seoMetaDescription) {
          const seo = await tx.seo.create({
            data: {
              metaTitle: dto.seoMetaTitle,
              metaDescription: dto.seoMetaDescription,
            },
          });
          seoId = seo.id;
        }
        return tx.bookVersion.create({
          data: {
            bookId,
            language: dto.language,
            title: dto.title,
            author: dto.author,
            description: dto.description,
            coverImageUrl: dto.coverImageUrl,
            type: dto.type,
            isFree: dto.isFree,
            referralUrl: dto.referralUrl,
            seoId,
            status: 'draft',
          },
          include: { seo: { select: { metaTitle: true, metaDescription: true } } },
        });
      });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Version for this language already exists for this book');
      }
      throw e;
    }
  }

  async getPublic(id: string) {
    const version = await this.prisma.bookVersion.findFirst({
      where: { id, status: 'published' },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
    if (!version) throw new NotFoundException('BookVersion not found');
    return version;
  }

  // Админский доступ — любая версия
  async getAdmin(id: string) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
    if (!version) throw new NotFoundException('BookVersion not found');
    return version;
  }

  async update(id: string, dto: UpdateBookVersionDto) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');
    try {
      return await this.prisma.$transaction(async (tx) => {
        let seoId = existing.seoId;
        if (dto.seoMetaTitle !== undefined || dto.seoMetaDescription !== undefined) {
          if (seoId) {
            await tx.seo.update({
              where: { id: seoId },
              data: {
                metaTitle: dto.seoMetaTitle,
                metaDescription: dto.seoMetaDescription,
              },
            });
          } else {
            const seo = await tx.seo.create({
              data: {
                metaTitle: dto.seoMetaTitle,
                metaDescription: dto.seoMetaDescription,
              },
            });
            seoId = seo.id;
          }
        }
        const updated = await tx.bookVersion.update({
          where: { id },
          data: {
            ...dto,
            seoId,
          },
          include: { seo: { select: { metaTitle: true, metaDescription: true } } },
        });
        return updated;
      });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Version for this language already exists for this book');
      }
      throw e;
    }
  }

  async remove(id: string) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');
    return this.prisma.bookVersion.delete({
      where: { id },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
  }

  async publish(id: string) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');
    return this.prisma.bookVersion.update({
      where: { id },
      data: { status: 'published', publishedAt: new Date() },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
  }

  async unpublish(id: string) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');
    return this.prisma.bookVersion.update({
      where: { id },
      data: { status: 'draft', publishedAt: null },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
  }

  // Админский листинг без фильтра по статусу
  async listAdmin(
    bookId: string,
    filters: { language?: Language; type?: BookType; isFree?: boolean },
  ) {
    const where: Prisma.BookVersionWhereInput = {
      bookId,
      ...(filters.language ? { language: filters.language } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.isFree !== undefined ? { isFree: filters.isFree } : {}),
    };
    return this.prisma.bookVersion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
  }
}
