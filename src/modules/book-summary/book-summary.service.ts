import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateBookSummaryDto } from './dto/update-book-summary.dto';

// Пространство имён двухаргументного `pg_advisory_xact_lock`; занятые — в перечне у `RECHECK_SCAN_LOCK_KEY`.
const BOOK_SUMMARY_LOCK_NAMESPACE = 831_427_004;
// Явные границы (`L-020`): писатель, дождавшийся замка, не должен падать P2028 на дефолтных 5 секундах.
const BOOK_SUMMARY_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;
// Одна строка на версию и для чтения, и для записи, пока старые дубли `LEGACY-420` не вычищены.
const CURRENT_SUMMARY_ORDER: Prisma.BookSummaryOrderByWithRelationInput[] = [
  { updatedAt: 'desc' },
  { id: 'desc' },
];

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

    return this.prisma.bookSummary.findFirst({
      where: { bookVersionId },
      orderBy: CURRENT_SUMMARY_ORDER,
    });
  }

  /**
   * `LEGACY-420`. «Прочитал -> создал» идёт в транзакции под advisory-замком
   * по версии: второй писатель ждёт коммита первого и видит его строку.
   * Уникального индекса на `bookVersionId` нет намеренно — чистка уже
   * существующих дублей перед ним правит живые данные и остаётся за владельцем
   * (ADR-018, прецедент W8 в `decisions-log.md`); `upsert` без индекса падал бы 42P10.
   */
  async upsertForVersion(bookVersionId: string, dto: UpdateBookSummaryDto) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT true AS locked
          FROM pg_advisory_xact_lock(${BOOK_SUMMARY_LOCK_NAMESPACE}::int4, hashtext(${bookVersionId}::text))`;
        const existing = await tx.bookSummary.findFirst({
          where: { bookVersionId },
          orderBy: CURRENT_SUMMARY_ORDER,
        });
        if (!existing) {
          return tx.bookSummary.create({ data: { bookVersionId, ...dto } });
        }
        return tx.bookSummary.update({ where: { id: existing.id }, data: { ...dto } });
      }, BOOK_SUMMARY_TX_OPTIONS);
    } catch (e: unknown) {
      // Версию проверяли до транзакции и без замка, а её удаление идёт мимо замка сводки:
      // удалённая в этом окне версия даёт FK-отказ на create (P2003) или снятую каскадом
      // строку на update (P2025) — это 404.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2003' || e.code === 'P2025')
      ) {
        throw new NotFoundException('BookVersion not found');
      }
      throw e;
    }
  }
}
