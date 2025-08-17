import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class CategoryService {
  constructor(private prisma: PrismaService) {}

  list(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    return this.prisma.category.findMany({ orderBy: { name: 'asc' }, skip, take: limit });
  }

  async create(dto: CreateCategoryDto) {
    try {
      return await this.prisma.category.create({ data: dto });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Category with same slug already exists');
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const exists = await this.prisma.category.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Category not found');
    if (dto.slug) {
      const dup = await this.prisma.category.findFirst({ where: { slug: dto.slug, NOT: { id } } });
      if (dup) throw new BadRequestException('Category with same slug already exists');
    }
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    const exists = await this.prisma.category.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Category not found');
    return this.prisma.category.delete({ where: { id } });
  }

  async getBySlugWithBooks(slug: string) {
    const category = await this.prisma.category.findUnique({ where: { slug } });
    if (!category) throw new NotFoundException('Category not found');
    const links = await this.prisma.bookCategory.findMany({
      where: { categoryId: category.id },
      select: { bookVersion: true },
      orderBy: { bookVersion: { createdAt: 'desc' } },
    });
    return { category, versions: links.map((l) => l.bookVersion) };
  }

  async attachCategoryToVersion(versionId: string, categoryId: string) {
    const [version, category] = await Promise.all([
      this.prisma.bookVersion.findUnique({ where: { id: versionId } }),
      this.prisma.category.findUnique({ where: { id: categoryId } }),
    ]);
    if (!version) throw new NotFoundException('BookVersion not found');
    if (!category) throw new NotFoundException('Category not found');

    const exists = await this.prisma.bookCategory.findFirst({
      where: { bookVersionId: versionId, categoryId },
      select: { id: true },
    });
    if (exists) return exists; // idempotent

    try {
      return await this.prisma.bookCategory.create({
        data: { bookVersionId: versionId, categoryId },
      });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        // unique(bookVersionId, categoryId)
        return this.prisma.bookCategory.findFirst({
          where: { bookVersionId: versionId, categoryId },
        });
      }
      throw e;
    }
  }

  async detachCategoryFromVersion(versionId: string, categoryId: string) {
    const link = await this.prisma.bookCategory.findFirst({
      where: { bookVersionId: versionId, categoryId },
    });
    if (!link) throw new NotFoundException('Relation not found');
    await this.prisma.bookCategory.delete({ where: { id: link.id } });
    return { success: true };
  }
}
