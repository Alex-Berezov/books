import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateBookSummaryDto } from './dto/update-book-summary.dto';
import { UpdateBookSummaryBriefDto } from './dto/update-book-summary-brief.dto';
import { richHtmlText } from '../../shared/sanitize/rich-html-text';
import { isVersionGoneError, withSummaryLock, writeUnderSummaryLock } from './book-summary-lock';
// Одна строка на версию и для чтения, и для записи, пока старые дубли `LEGACY-420` не вычищены.
const CURRENT_SUMMARY_ORDER: Prisma.BookSummaryOrderByWithRelationInput[] = [
  { updatedAt: 'desc' },
  { id: 'desc' },
];

/** Поля ответа `BookSummaryResponseDto` — явный список для новой ручки очень краткого. */
const BOOK_SUMMARY_RESPONSE_SELECT = {
  id: true,
  bookVersionId: true,
  summary: true,
  hasText: true,
  analysis: true,
  themes: true,
  brief: true,
  briefHasText: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.BookSummarySelect;

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
   * С пачки `T54` в базе есть и `@unique` на `bookVersionId` — второй рубеж
   * к писателю мимо замка. Замок и «прочитал — создал» оставлены намеренно:
   * если миграция индекса на проде упадёт (23505, индекса нет), `upsert` отвечал бы
   * 42P10, а этот путь работает на обеих схемах.
   */
  async upsertForVersion(bookVersionId: string, dto: UpdateBookSummaryDto) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    try {
      return await withSummaryLock(this.prisma, bookVersionId, async (tx) => {
        const existing = await tx.bookSummary.findFirst({
          where: { bookVersionId },
          orderBy: CURRENT_SUMMARY_ORDER,
        });
        // Признак текста считается тем же правилом, что валидатор: сейчас он всегда true, но
        // счётчик пересказов опирается на колонку, а не на то, что валидатор стоит на входе.
        const hasText = richHtmlText(dto.summary) !== '';
        if (!existing) {
          return tx.bookSummary.create({ data: { bookVersionId, ...dto, hasText } });
        }
        return tx.bookSummary.update({ where: { id: existing.id }, data: { ...dto, hasText } });
      });
    } catch (e: unknown) {
      if (isVersionGoneError(e)) throw new NotFoundException('BookVersion not found');
      throw e;
    }
  }

  /**
   * Очень краткий пересказ (F04 T1) — своей ручкой: `PUT summary` его не знает, и старая админка
   * без поля `brief` не сбросит ни текст, ни флаг. Без полного пересказа с текстом — 409: очень
   * краткий заводится после полного (`product.md` §7 п.5). Ответ — явным `select` (новая ручка F04,
   * решение арбитра `F04 | F04-1` п.1), та же форма, что у `GET summary`. `null` и пустая строка очищают поле; HTML без
   * видимого текста хранится как есть с `briefHasText = false` — блока на странице нет.
   */
  async upsertBrief(bookVersionId: string, dto: UpdateBookSummaryBriefDto) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    const briefHasText = dto.brief !== null && richHtmlText(dto.brief) !== '';
    return writeUnderSummaryLock(this.prisma, bookVersionId, async (tx) => {
      const existing = await tx.bookSummary.findUnique({
        where: { bookVersionId },
        select: { id: true, hasText: true },
      });
      if (!existing?.hasText) {
        throw new ConflictException('Save the full summary first');
      }
      return tx.bookSummary.update({
        where: { id: existing.id },
        data: { brief: dto.brief === '' ? null : dto.brief, briefHasText },
        select: BOOK_SUMMARY_RESPONSE_SELECT,
      });
    });
  }
}
