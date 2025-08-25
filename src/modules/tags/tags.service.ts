import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

@Injectable()
export class TagsService {
  constructor(private prisma: PrismaService) {}

  list(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    return this.prisma.tag.findMany({ orderBy: { name: 'asc' }, skip, take: limit });
  }

  async create(dto: CreateTagDto) {
    try {
      return await this.prisma.tag.create({ data: { name: dto.name, slug: dto.slug } });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Tag with same slug already exists');
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateTagDto) {
    const exists = await this.prisma.tag.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Tag not found');
    if (dto.slug) {
      const dup = await this.prisma.tag.findFirst({ where: { slug: dto.slug, NOT: { id } } });
      if (dup) throw new BadRequestException('Tag with same slug already exists');
    }
    return this.prisma.tag.update({ where: { id }, data: { name: dto.name, slug: dto.slug } });
  }

  async remove(id: string) {
    const exists = await this.prisma.tag.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Tag not found');
    return this.prisma.tag.delete({ where: { id } });
  }

  async versionsByTagSlug(slug: string) {
    const tag = await this.prisma.tag.findUnique({ where: { slug } });
    if (!tag) throw new NotFoundException('Tag not found');
    const links = await this.prisma.bookTag.findMany({
      where: { tagId: tag.id },
      select: { bookVersion: true },
      orderBy: { bookVersion: { createdAt: 'desc' } },
    });
    return { tag, versions: links.map((l) => l.bookVersion) };
  }

  async attach(versionId: string, tagId: string) {
    const [version, tag] = await Promise.all([
      this.prisma.bookVersion.findUnique({ where: { id: versionId } }),
      this.prisma.tag.findUnique({ where: { id: tagId } }),
    ]);
    if (!version) throw new NotFoundException('BookVersion not found');
    if (!tag) throw new NotFoundException('Tag not found');

    const exists = await this.prisma.bookTag.findFirst({
      where: { bookVersionId: versionId, tagId },
      select: { id: true },
    });
    if (exists) return exists; // идемпотентность

    try {
      return await this.prisma.bookTag.create({ data: { bookVersionId: versionId, tagId } });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        return this.prisma.bookTag.findFirst({ where: { bookVersionId: versionId, tagId } });
      }
      throw e;
    }
  }

  async detach(versionId: string, tagId: string) {
    const link = await this.prisma.bookTag.findFirst({
      where: { bookVersionId: versionId, tagId },
    });
    if (!link) return { success: true };
    await this.prisma.bookTag.delete({ where: { id: link.id } });
    return { success: true };
  }
}
