import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Language, Prisma, PublicationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { resolveRequestedLanguage } from '../../shared/language/language.util';

@Injectable()
export class PagesService {
  constructor(private prisma: PrismaService) {}

  async getPublicBySlug(slug: string, language?: Language) {
    const where = language
      ? { slug, language, status: 'published' as const }
      : { slug, status: 'published' as const };
    const page = await this.prisma.page.findFirst({ where });
    if (!page) throw new NotFoundException('Page not found');
    return page;
  }

  /**
   * Public resolver with language policy: prefers query lang, then Accept-Language, then default.
   * If a language is resolved but no page exists in that language, falls back to any published page with the slug.
   */
  async getPublicBySlugWithPolicy(slug: string, queryLang?: string, acceptLanguage?: string) {
    const candidates = await this.prisma.page.findMany({
      where: { slug, status: 'published' },
      select: { id: true, language: true },
    });
    if (candidates.length === 0) throw new NotFoundException('Page not found');
    const available = candidates.map((c) => c.language);
    const preferred = resolveRequestedLanguage({
      queryLang: queryLang || undefined,
      acceptLanguage: acceptLanguage || undefined,
      available,
    });
    const pick = preferred
      ? (candidates.find((c) => c.language === preferred) ?? candidates[0])
      : candidates[0];
    return this.prisma.page.findUnique({ where: { id: pick.id } });
  }

  async adminList(page = 1, limit = 20, language?: Language) {
    const skip = (page - 1) * limit;
    const where = language ? { language } : undefined;

    const [data, total] = await Promise.all([
      this.prisma.page.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.page.count({ where }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async create(dto: CreatePageDto, language: Language) {
    try {
      return await this.prisma.page.create({
        data: {
          slug: dto.slug,
          title: dto.title,
          type: dto.type,
          content: dto.content,
          language,
          seoId: dto.seoId ?? null,
        },
      });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        // Composite unique violation (language, slug)
        throw new BadRequestException('Page with same slug already exists for this language');
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdatePageDto) {
    const exists = await this.prisma.page.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Page not found');
    if (dto.slug || dto.language) {
      const newSlug = dto.slug ?? exists.slug;
      const newLang: Language = dto.language ?? exists.language;
      const dup = await this.prisma.page.findFirst({
        where: { slug: newSlug, language: newLang, NOT: { id } },
        select: { id: true },
      });
      if (dup)
        throw new BadRequestException('Page with same slug already exists for this language');
    }
    // If seoId is provided (including null), optionally check existence to provide clearer error
    if (dto.seoId !== undefined && dto.seoId !== null) {
      const seo = await this.prisma.seo.findUnique({ where: { id: dto.seoId } });
      if (!seo) {
        throw new BadRequestException('SEO entity not found for provided seoId');
      }
    }
    try {
      return await this.prisma.page.update({
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
    } catch (e: unknown) {
      const err = e as Prisma.PrismaClientKnownRequestError & { meta?: { constraint?: string } };
      if (err?.code === 'P2003' && err?.meta?.constraint === 'Page_seoId_fkey') {
        throw new BadRequestException('Invalid seoId: referenced SEO entity does not exist');
      }
      throw e;
    }
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
