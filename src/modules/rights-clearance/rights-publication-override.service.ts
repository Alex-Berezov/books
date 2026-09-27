import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RightsPublicationOverrideDto,
  RightsPublicationOverrideStateDto,
} from './dto/rights-publication-override.dto';

/** Потолок истории в ответе: решений по одной книге единицы, но выборка без предела запрещена. */
const OVERRIDE_HISTORY_LIMIT = 100;

const OVERRIDE_SELECT = {
  id: true,
  bookId: true,
  bookSlug: true,
  reasonRu: true,
  grantedAt: true,
  grantedByUserId: true,
  revokedAt: true,
  revokedByUserId: true,
  revokeReasonRu: true,
  grantedByUser: { select: { email: true } },
  revokedByUser: { select: { email: true } },
} satisfies Prisma.RightsPublicationOverrideSelect;

type OverrideRow = Prisma.RightsPublicationOverrideGetPayload<{ select: typeof OVERRIDE_SELECT }>;

/** Действующее решение в том виде, в каком его читает гейт публикации. */
export type ActiveRightsPublicationOverride = {
  id: string;
  grantedAt: Date;
  grantedByUserId: string | null;
  reasonRu: string;
};

export const RIGHTS_OVERRIDE_NOT_ACTIVE = 'RIGHTS_OVERRIDE_NOT_ACTIVE';

/**
 * Решение владельца 27.09.2026 (тема №4): «Разрешить публикацию» — последняя инстанция по правам.
 *
 * Администратор снимает с книги все правовые блокеры гейта разом, с обязательной причиной. Что
 * именно снимается, решает гейт (`PublicationGateService`); здесь только журнал решений: строка
 * не удаляется, отмена ставит `revokedAt`, повторное нажатие закрывает прежнее решение и заводит
 * новое — с новым `grantedAt`, от которого гейт отсчитывает «претензия пришла после решения».
 */
@Injectable()
export class RightsPublicationOverrideService {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveForBook(bookId: string): Promise<ActiveRightsPublicationOverride | null> {
    return this.prisma.rightsPublicationOverride.findFirst({
      where: { bookId, revokedAt: null },
      orderBy: { grantedAt: 'desc' },
      select: { id: true, grantedAt: true, grantedByUserId: true, reasonRu: true },
    });
  }

  async getState(bookId: string): Promise<RightsPublicationOverrideStateDto> {
    await this.assertBookExists(bookId);

    const rows = await this.prisma.rightsPublicationOverride.findMany({
      where: { bookId },
      orderBy: { grantedAt: 'desc' },
      take: OVERRIDE_HISTORY_LIMIT,
      select: OVERRIDE_SELECT,
    });
    const history = rows.map((row) => this.toDto(row));

    return { active: history.find((item) => item.revokedAt === null) ?? null, history };
  }

  async grant(
    bookId: string,
    reasonRu: string,
    userId: string,
  ): Promise<RightsPublicationOverrideDto> {
    const book = await this.assertBookExists(bookId);

    const created = await this.prisma.$transaction(async (tx) => {
      // Два одновременных нажатия иначе оба не видят действующего решения и заводят по строке.
      await this.lockBook(tx, bookId);

      const now = new Date();
      await tx.rightsPublicationOverride.updateMany({
        where: { bookId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedByUserId: userId,
          revokeReasonRu: 'Заменено новым решением «Разрешить публикацию».',
        },
      });

      return tx.rightsPublicationOverride.create({
        data: { bookId, bookSlug: book.slug, reasonRu, grantedAt: now, grantedByUserId: userId },
        select: OVERRIDE_SELECT,
      });
    });

    return this.toDto(created);
  }

  async revoke(
    bookId: string,
    reasonRu: string | undefined,
    userId: string,
  ): Promise<RightsPublicationOverrideDto> {
    await this.assertBookExists(bookId);

    const revoked = await this.prisma.$transaction(async (tx) => {
      await this.lockBook(tx, bookId);

      const active = await tx.rightsPublicationOverride.findFirst({
        where: { bookId, revokedAt: null },
        orderBy: { grantedAt: 'desc' },
        select: { id: true },
      });
      if (!active) {
        throw new ConflictException({
          message: 'У книги нет действующего решения «Разрешить публикацию».',
          code: RIGHTS_OVERRIDE_NOT_ACTIVE,
        });
      }

      return tx.rightsPublicationOverride.update({
        where: { id: active.id },
        data: {
          revokedAt: new Date(),
          revokedByUserId: userId,
          revokeReasonRu: reasonRu ? reasonRu : null,
        },
        select: OVERRIDE_SELECT,
      });
    });

    return this.toDto(revoked);
  }

  private async lockBook(tx: Prisma.TransactionClient, bookId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Book" WHERE "id" = ${bookId} FOR UPDATE`;
  }

  private async assertBookExists(bookId: string): Promise<{ id: string; slug: string }> {
    const book = await this.prisma.book.findUnique({
      where: { id: bookId },
      select: { id: true, slug: true },
    });
    if (!book) {
      throw new NotFoundException('Book not found');
    }
    return book;
  }

  private toDto(row: OverrideRow): RightsPublicationOverrideDto {
    return {
      id: row.id,
      bookId: row.bookId,
      bookSlug: row.bookSlug,
      reasonRu: row.reasonRu,
      grantedAt: row.grantedAt.toISOString(),
      grantedByUserId: row.grantedByUserId,
      grantedByEmail: row.grantedByUser?.email ?? null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedByUserId: row.revokedByUserId,
      revokedByEmail: row.revokedByUser?.email ?? null,
      revokeReasonRu: row.revokeReasonRu,
    };
  }
}
