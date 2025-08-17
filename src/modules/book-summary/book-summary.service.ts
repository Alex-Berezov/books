import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateBookSummaryDto } from './dto/update-book-summary.dto';

@Injectable()
export class BookSummaryService {
  constructor(private prisma: PrismaService) {}

  async getByVersion(bookVersionId: string) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    return this.prisma.bookSummary.findFirst({ where: { bookVersionId } });
  }

  async upsertForVersion(bookVersionId: string, dto: UpdateBookSummaryDto) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    const existing = await this.prisma.bookSummary.findFirst({ where: { bookVersionId } });
    if (!existing) {
      return this.prisma.bookSummary.create({ data: { bookVersionId, ...dto } });
    }
    return this.prisma.bookSummary.update({ where: { id: existing.id }, data: { ...dto } });
  }
}
