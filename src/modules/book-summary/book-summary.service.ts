import { Injectable, NotFoundException } from '@nestjs/common';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateBookSummaryDto } from './dto/update-book-summary.dto';

@Injectable()
export class BookSummaryService {
  constructor(
    private prisma: PrismaService,
    private readonly moderatorRoles: ModeratorRolesService,
  ) {}

  /**
   * 🔴 Маршрут публичный и статус версии не проверял: саммари неопубликованной
   * книги читалось по id версии (`LEGACY-090`). Черновик саммари — это
   * редакционный материал, который правовой контур ещё не пропустил.
   *
   * ⚠️ Просто зафильтровать по `published` было **нельзя**: на этот же адрес
   * ходит админская вкладка «Summary», где редактор пишет саммари до
   * публикации, — фильтр сделал бы её вечно пустой. Поэтому здесь, как в
   * читалке и комментариях, разделяется не доступ, а ответ.
   */
  async getByVersion(bookVersionId: string, actor?: { userId: string; email: string }) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    if (version.status !== 'published' && !(await this.moderatorRoles.isModerator(actor))) {
      throw new NotFoundException('BookVersion not found');
    }

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
