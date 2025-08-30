import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Language, Tag, TagTranslation, BookVersion } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { resolveRequestedLanguage } from '../../shared/language/language.util';
import { CreateTagTranslationDto } from './dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from './dto/update-tag-translation.dto';

@Injectable()
export class TagsService {
  constructor(private prisma: PrismaService) {}

  list(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    return this.prisma.tag.findMany({ orderBy: { name: 'asc' }, skip, take: limit });
  }

  async create(dto: CreateTagDto) {
    // Base tag create (no unique slug constraint now). Translations are managed via separate endpoints.
    return this.prisma.tag.create({ data: { name: dto.name, slug: dto.slug } });
  }

  async update(id: string, dto: UpdateTagDto) {
    const exists = await this.prisma.tag.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Tag not found');
    return this.prisma.tag.update({ where: { id }, data: { name: dto.name, slug: dto.slug } });
  }

  async remove(id: string) {
    const exists = await this.prisma.tag.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Tag not found');
    return this.prisma.tag.delete({ where: { id } });
  }

  async versionsByTagSlug(
    slug: string,
    queryLang?: string,
    acceptLanguageHeader?: string,
  ): Promise<{
    tag: Tag & { translation: TagTranslation | null };
    versions: BookVersion[];
    availableLanguages: Language[];
  }> {
    const headerLang = acceptLanguageHeader || null;
    const preferred = resolveRequestedLanguage({
      queryLang,
      acceptLanguage: headerLang,
      available: [],
    });
    const trans = await this.prisma.tagTranslation.findUnique({
      where: { language_slug: { language: preferred ?? Language.en, slug } },
      include: { tag: true },
    });
    let tagId: string | null = null;
    let baseTag: Tag | null = null;
    if (trans?.tag) {
      tagId = trans.tag.id;
      baseTag = trans.tag;
    } else {
      // Fallback to base Tag by slug for backward compatibility
      const found = await this.prisma.tag.findFirst({ where: { slug } });
      if (!found) throw new NotFoundException('Tag not found');
      tagId = found.id;
      baseTag = found;
    }
    // public only: published versions with this tag
    const versions = await this.prisma.bookVersion.findMany({
      where: { status: 'published', tags: { some: { tagId } } },
      orderBy: { createdAt: 'desc' },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
    const availableLanguages: Language[] = Array.from(new Set(versions.map((v) => v.language)));
    const effective = resolveRequestedLanguage({
      queryLang,
      acceptLanguage: headerLang,
      available: availableLanguages,
    });
    const filtered = effective ? versions.filter((v) => v.language === effective) : versions;
    return {
      tag: { ...baseTag, translation: (trans as TagTranslation) ?? null },
      versions: filtered,
      availableLanguages,
    };
  }

  async versionsByTagLangSlug(
    pathLang: Language,
    slug: string,
  ): Promise<{
    tag: Tag & { translation: TagTranslation | null };
    versions: BookVersion[];
    availableLanguages: Language[];
  }> {
    const trans = await this.prisma.tagTranslation.findUnique({
      where: { language_slug: { language: pathLang, slug } },
      include: { tag: true },
    });
    let tagId: string | null = null;
    let baseTag: Tag | null = null;
    if (trans?.tag) {
      baseTag = trans.tag;
      tagId = trans.tag.id;
    } else {
      // Fallback to base Tag by slug for backward compatibility
      const found = await this.prisma.tag.findFirst({ where: { slug } });
      if (!found) throw new NotFoundException('Tag not found');
      tagId = found.id;
      baseTag = found;
    }
    const versions = await this.prisma.bookVersion.findMany({
      where: { status: 'published', language: pathLang, tags: { some: { tagId } } },
      orderBy: { createdAt: 'desc' },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
    const availableLanguages: Language[] = Array.from(
      new Set(
        (
          await this.prisma.bookVersion.findMany({
            where: { status: 'published', tags: { some: { tagId } } },
            select: { language: true },
          })
        ).map((v) => v.language),
      ),
    );
    return {
      tag: { ...baseTag, translation: (trans as TagTranslation) ?? null },
      versions,
      availableLanguages,
    };
  }

  // ===== Translations (Admin) =====
  listTranslations(tagId: string): Promise<TagTranslation[]> {
    return this.prisma.tagTranslation.findMany({
      where: { tagId },
      orderBy: { language: 'asc' },
    });
  }

  async createTranslation(tagId: string, dto: CreateTagTranslationDto) {
    const exists = await this.prisma.tag.findUnique({ where: { id: tagId } });
    if (!exists) throw new NotFoundException('Tag not found');
    try {
      return await this.prisma.tagTranslation.create({
        data: { tagId, language: dto.language, name: dto.name, slug: dto.slug },
      });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Translation with same (language, slug) already exists');
      }
      throw e;
    }
  }

  async updateTranslation(tagId: string, language: Language, dto: UpdateTagTranslationDto) {
    const tr = await this.prisma.tagTranslation.findUnique({
      where: { tagId_language: { tagId, language } },
    });
    if (!tr) throw new NotFoundException('Translation not found');
    return this.prisma.tagTranslation.update({
      where: { tagId_language: { tagId, language } },
      data: { name: dto.name, slug: dto.slug },
    });
  }

  async deleteTranslation(tagId: string, language: Language) {
    const tr = await this.prisma.tagTranslation.findUnique({
      where: { tagId_language: { tagId, language } },
    });
    if (!tr) return { success: true };
    await this.prisma.tagTranslation.delete({
      where: { tagId_language: { tagId, language } },
    });
    return { success: true };
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
