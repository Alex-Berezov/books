import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertExpectedRowShape,
  assertRowAsExpected,
  type ExpectedRow,
} from '../../shared/dto/expected-row.util';
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
  async upsertForVersion(
    bookVersionId: string,
    dto: UpdateBookSummaryDto,
    expected: ExpectedRow = {},
  ) {
    assertExpectedRowShape(expected);
    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    try {
      return await withSummaryLock(this.prisma, bookVersionId, (tx) =>
        writeFull(tx, bookVersionId, dto, expected),
      );
    } catch (e: unknown) {
      if (isVersionGoneError(e)) throw new NotFoundException('BookVersion not found');
      throw e;
    }
  }

  /**
   * Запись хода пересказа `F06` (`features/F06-summary-autofill/tech.md` §5): полный или очень
   * краткий тем же телом, что ручки, под тем же замком и в той же транзакции, если `guard.allow`
   * под замком разрешил. `guard.done` - учёт хода в той же транзакции после записи. Очень
   * краткий без полного с текстом не пишется (как `upsertBrief`), ход получает `false`.
   */
  async writeGuarded(
    bookVersionId: string,
    part: 'full' | 'brief',
    html: string,
    guard: SummaryWriteGuard,
  ): Promise<boolean> {
    return writeUnderSummaryLock(this.prisma, bookVersionId, async (tx) => {
      if (!(await guard.allow(tx))) return false;
      if (part === 'full') {
        await writeFull(tx, bookVersionId, { summary: html });
      } else if ((await writeBrief(tx, bookVersionId, html)) === null) {
        return false;
      }
      await guard.done(tx);
      return true;
    });
  }

  /**
   * Очень краткий пересказ (F04 T1) — своей ручкой: `PUT summary` его не знает, и старая админка
   * без поля `brief` не сбросит ни текст, ни флаг. Без полного пересказа с текстом — 409: очень
   * краткий заводится после полного (`product.md` §7 п.5). Ответ — явным `select` (новая ручка F04,
   * решение арбитра `F04 | F04-1` п.1), та же форма, что у `GET summary`. `null` и пустая строка очищают поле; HTML без
   * видимого текста хранится как есть с `briefHasText = false` — блока на странице нет.
   */
  async upsertBrief(
    bookVersionId: string,
    dto: UpdateBookSummaryBriefDto,
    expectedUpdatedAt?: string,
  ) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    return writeUnderSummaryLock(this.prisma, bookVersionId, async (tx) => {
      const row = await writeBrief(tx, bookVersionId, dto.brief, expectedUpdatedAt);
      if (row === null) throw new ConflictException('Save the full summary first');
      return row;
    });
  }
}

/** Разрешение и учёт записи хода `F06` под замком пересказа (`writeGuarded`). */
export interface SummaryWriteGuard {
  allow(tx: Prisma.TransactionClient): Promise<boolean>;
  done(tx: Prisma.TransactionClient): Promise<void>;
}

const SUMMARY_CHANGED = 'The summary was changed by another editor';

/** Полный пересказ версии - тело `PUT summary` и записи хода; вызывается под замком. */
async function writeFull(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
  dto: UpdateBookSummaryDto,
  expected: ExpectedRow = {},
) {
  const existing = await tx.bookSummary.findFirst({
    where: { bookVersionId },
    orderBy: CURRENT_SUMMARY_ORDER,
  });
  assertRowAsExpected(existing, expected, SUMMARY_CHANGED);
  // Признак текста считается тем же правилом, что валидатор: сейчас он всегда true, но
  // счётчик пересказов опирается на колонку, а не на то, что валидатор стоит на входе.
  const hasText = richHtmlText(dto.summary) !== '';
  if (!existing) {
    return tx.bookSummary.create({ data: { bookVersionId, ...dto, hasText } });
  }
  return tx.bookSummary.update({ where: { id: existing.id }, data: { ...dto, hasText } });
}

/**
 * Очень краткий - тело `PUT summary/brief` и записи хода; под замком. Нет полного с текстом -
 * `null` (ручка отвечает 409). `null` и пустая строка очищают поле.
 */
async function writeBrief(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
  brief: string | null,
  expectedUpdatedAt?: string,
) {
  const existing = await tx.bookSummary.findUnique({
    where: { bookVersionId },
    select: { id: true, hasText: true, updatedAt: true },
  });
  if (!existing?.hasText) return null;
  assertRowAsExpected(existing, { expectedUpdatedAt }, SUMMARY_CHANGED);
  const briefHasText = brief !== null && richHtmlText(brief) !== '';
  return tx.bookSummary.update({
    where: { id: existing.id },
    data: { brief: brief === '' ? null : brief, briefHasText },
    select: BOOK_SUMMARY_RESPONSE_SELECT,
  });
}
