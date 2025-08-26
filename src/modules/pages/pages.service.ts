import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PublicationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';

@Injectable()
export class PagesService {
  constructor(private prisma: PrismaService) {}

  async getPublicBySlug(slug: string) {
    const page = await this.prisma.page.findFirst({ where: { slug, status: 'published' } });
    if (!page) throw new NotFoundException('Page not found');
    return page;
  }

  adminList(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    return this.prisma.page.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit });
  }

  async create(dto: CreatePageDto) {
    try {
      return await this.prisma.page.create({
        data: {
          slug: dto.slug,
          title: dto.title,
          type: dto.type,
          content: dto.content,
          language: dto.language,
          seoId: dto.seoId ?? null,
        },
      });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Page with same slug already exists');
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdatePageDto) {
    const exists = await this.prisma.page.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Page not found');
    if (dto.slug) {
      const dup = await this.prisma.page.findFirst({ where: { slug: dto.slug, NOT: { id } } });
      if (dup) throw new BadRequestException('Page with same slug already exists');
    }
    return this.prisma.page.update({
      where: { id },
      data: {
        slug: dto.slug ?? undefined,
        title: dto.title ?? undefined,
        type: dto.type ?? undefined,
        content: dto.content ?? undefined,
        language: dto.language ?? undefined,
        seoId: dto.seoId ?? undefined,
        status: dto.status ?? undefined,
      },
    });
  }

  async setStatus(id: string, status: PublicationStatus) {
    const exists = await this.prisma.page.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Page not found');
    return this.prisma.page.update({ where: { id }, data: { status } });
  }

  async remove(id: string) {
    const exists = await this.prisma.page.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Page not found');
    await this.prisma.page.delete({ where: { id } });
    return { success: true };
  }
}
