import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateSeoDto } from './dto/update-seo.dto';

@Injectable()
export class SeoService {
  constructor(private prisma: PrismaService) {}

  async getByVersion(bookVersionId: string) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');
    if (!version.seoId) return null;
    return this.prisma.seo.findUnique({ where: { id: version.seoId } });
  }

  async upsertForVersion(bookVersionId: string, dto: UpdateSeoDto) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    if (!version.seoId) {
      const created = await this.prisma.seo.create({ data: { ...this.dtoToData(dto) } });
      await this.prisma.bookVersion.update({
        where: { id: bookVersionId },
        data: { seoId: created.id },
      });
      return created;
    }

    return this.prisma.seo.update({ where: { id: version.seoId }, data: this.dtoToData(dto) });
  }

  private dtoToData(dto: UpdateSeoDto) {
    const {
      metaTitle,
      metaDescription,
      canonicalUrl,
      robots,
      ogTitle,
      ogDescription,
      ogType,
      ogUrl,
      ogImageUrl,
      ogImageAlt,
      twitterCard,
      twitterSite,
      twitterCreator,
      eventName,
      eventDescription,
      eventStartDate,
      eventEndDate,
      eventUrl,
      eventImageUrl,
      eventLocationName,
      eventLocationStreet,
      eventLocationCity,
      eventLocationRegion,
      eventLocationPostal,
      eventLocationCountry,
    } = dto;
    return {
      metaTitle,
      metaDescription,
      canonicalUrl,
      robots,
      ogTitle,
      ogDescription,
      ogType,
      ogUrl,
      ogImageUrl,
      ogImageAlt,
      twitterCard,
      twitterSite,
      twitterCreator,
      eventName,
      eventDescription,
      eventStartDate: eventStartDate ? new Date(eventStartDate) : undefined,
      eventEndDate: eventEndDate ? new Date(eventEndDate) : undefined,
      eventUrl,
      eventImageUrl,
      eventLocationName,
      eventLocationStreet,
      eventLocationCity,
      eventLocationRegion,
      eventLocationPostal,
      eventLocationCountry,
    };
  }
}
