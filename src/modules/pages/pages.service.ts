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
    const page = await this.prisma.page.findFirst({
      where,
      include: { seo: true },
    });
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
    return this.prisma.page.findUnique({
      where: { id: pick.id },
      include: { seo: true },
    });
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
        include: { seo: true },
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

  async findById(id: string) {
    const page = await this.prisma.page.findUnique({
      where: { id },
      include: { seo: true },
    });
    if (!page) throw new NotFoundException('Page not found');
    return page;
  }

  async create(dto: CreatePageDto, language: Language) {
    // Handle SEO: if dto.seo is provided, create SEO entity first
    let finalSeoId = dto.seoId;
    if (dto.seo) {
      // Check if SEO fields are not all null/undefined
      const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
      if (hasSeoData) {
        // Create new SEO entity
        const newSeo = await this.prisma.seo.create({
          data: dto.seo,
        });
        finalSeoId = newSeo.id;
      }
    } else if (dto.seoId !== undefined && dto.seoId !== null) {
      // Legacy: seoId provided directly - validate it exists
      const seo = await this.prisma.seo.findUnique({ where: { id: dto.seoId } });
      if (!seo) {
        throw new BadRequestException('SEO entity not found for provided seoId');
      }
      finalSeoId = dto.seoId;
    }

    try {
      return await this.prisma.page.create({
        data: {
          slug: dto.slug,
          title: dto.title,
          type: dto.type,
          content: dto.content,
          language,
          seoId: finalSeoId ?? null,
        },
        include: { seo: true },
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

    // Handle SEO: if dto.seo is provided, create or update SEO entity
    let finalSeoId = dto.seoId;
    if (dto.seo) {
      // Check if SEO fields are not all null/undefined
      const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
      if (hasSeoData) {
        if (exists.seoId) {
          // Update existing SEO entity
          await this.prisma.seo.update({
            where: { id: exists.seoId },
            data: dto.seo,
          });
          finalSeoId = exists.seoId;
        } else {
          // Create new SEO entity
          const newSeo = await this.prisma.seo.create({
            data: dto.seo,
          });
          finalSeoId = newSeo.id;
        }
      } else if (exists.seoId) {
        // All SEO fields are null - detach SEO entity
        finalSeoId = null;
      }
    } else if (dto.seoId !== undefined) {
      // Legacy: seoId provided directly
      if (dto.seoId !== null) {
        const seo = await this.prisma.seo.findUnique({ where: { id: dto.seoId } });
        if (!seo) {
          throw new BadRequestException('SEO entity not found for provided seoId');
        }
      }
      finalSeoId = dto.seoId;
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
          seoId: finalSeoId !== undefined ? finalSeoId : undefined,
          status: dto.status ?? undefined,
        },
        include: { seo: true },
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
    return this.prisma.page.update({
      where: { id },
      data: { status },
      include: { seo: true },
    });
  }

  async remove(id: string) {
    const exists = await this.prisma.page.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Page not found');
    await this.prisma.page.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Check if a slug exists for a given language.
   * @param slug - The slug to check
   * @param language - The language context
   * @param excludeId - Optional page ID to exclude (when editing)
   * @returns The existing page or null if slug is available
   */
  async checkSlugExists(slug: string, language: Language, excludeId?: string) {
    const where: Prisma.PageWhereInput = {
      slug,
      language,
    };

    if (excludeId) {
      where.NOT = { id: excludeId };
    }

    return this.prisma.page.findFirst({
      where,
      select: { id: true, title: true, status: true },
    });
  }

  /**
   * Generate a unique slug by appending a numeric suffix.
   * @param baseSlug - The base slug to make unique
   * @param language - The language context
   * @returns A unique slug with numeric suffix (e.g., "about-us-2")
   */
  async generateUniqueSuggestedSlug(baseSlug: string, language: Language): Promise<string> {
    let suffix = 2;
    let candidateSlug = `${baseSlug}-${suffix}`;

    // Find first available suffix
    while (await this.checkSlugExists(candidateSlug, language)) {
      suffix++;
      candidateSlug = `${baseSlug}-${suffix}`;
    }

    return candidateSlug;
  }
}
