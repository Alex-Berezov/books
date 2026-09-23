import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateChapterDto } from './dto/create-chapter.dto';
import { UpdateChapterDto } from './dto/update-chapter.dto';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { RightsClearanceLockService } from '../rights-intake/rights-clearance-lock.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';
import { Prisma, AdminAuditAction, AdminAuditTargetType, type Chapter } from '@prisma/client';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';
import {
  paginated,
  paginatedAll,
  type PaginatedResult,
} from '../../shared/dto/paginated-response.dto';

@Injectable()
export class ChapterService {
  constructor(
    private prisma: PrismaService,
    private rightsContentHashService: RightsContentHashService,
    private geoBlockRuleService: GeoBlockRuleService,
    private clearanceLock: RightsClearanceLockService,
    // `LEGACY-015`, пачка `T19`: удаление главы отвечает критерию
    // админского действия из докблока `AdminAuditEvent`.
    private adminAudit: AdminAuditService,
  ) {}

  async listByVersion(
    bookVersionId: string,
    page?: number,
    limit?: number,
    countryCode: string | null = null,
  ) {
    await this.ensureVersionPublished(bookVersionId);
    await this.geoBlockRuleService.assertAccess({
      bookVersionId,
      countryCode,
      scope: GeoBlockScope.TEXT_READER,
    });

    return this.listInternal(bookVersionId, page, limit);
  }

  /**
   * Админский список глав: черновик — рабочее состояние версии, а не отсутствие версии.
   * Публичная выдача остаётся за `listByVersion` с проверками публикации и гео-блокировок;
   * здесь проверяется только существование версии, как в `AudioChapterService.listAdmin`.
   */
  async listAdminByVersion(bookVersionId: string, page?: number, limit?: number) {
    await this.ensureVersionExists(bookVersionId);
    return this.listInternal(bookVersionId, page, limit);
  }

  // `total` считается всегда, когда выдача режется: без него последняя страница
  // неотличима от недобора (`LEGACY-098`, остаток `LEGACY-379`).
  private async listInternal(
    bookVersionId: string,
    page?: number,
    limit?: number,
  ): Promise<PaginatedResult<Chapter>> {
    const where = { bookVersionId };
    const orderBy = { number: 'asc' } as const;
    if (page && limit) {
      // Одним снимком: `total` из другого момента, чем страница, дал бы тот же недобор.
      const [items, total] = await this.prisma.$transaction([
        this.prisma.chapter.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
        this.prisma.chapter.count({ where }),
      ]);
      return paginated(items, { page, limit, total });
    }
    return paginatedAll(await this.prisma.chapter.findMany({ where, orderBy }));
  }

  async create(bookVersionId: string, dto: CreateChapterDto) {
    let chapterNumber = dto.number;

    // Auto-assign number if not provided
    if (chapterNumber === undefined || chapterNumber === null) {
      const last = await this.prisma.chapter.findFirst({
        where: { bookVersionId },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      chapterNumber = last ? last.number + 1 : 1;
    }

    const exists = await this.prisma.chapter.findFirst({
      where: { bookVersionId, number: chapterNumber },
      select: { id: true },
    });
    if (exists) {
      throw new BadRequestException('Chapter number must be unique within a version');
    }
    try {
      const chapter = await this.clearanceLock.runInLockedClearance(bookVersionId, async (tx) => {
        const created = await tx.chapter.create({
          data: { bookVersionId, number: chapterNumber, title: dto.title, content: dto.content },
        });
        await this.rightsContentHashService.checkVersionStaleness(
          bookVersionId,
          'CHAPTER_CREATED',
          null,
          true,
          tx,
        );
        return created;
      });
      return chapter;
    } catch (e: unknown) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Chapter number must be unique within a version');
      }
      throw e;
    }
  }

  async get(id: string, countryCode: string | null = null) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id } });
    if (!chapter) throw new NotFoundException('Chapter not found');
    await this.ensureVersionPublished(chapter.bookVersionId);
    await this.geoBlockRuleService.assertAccess({
      bookVersionId: chapter.bookVersionId,
      countryCode,
      scope: GeoBlockScope.TEXT_READER,
    });
    return chapter;
  }

  async update(id: string, dto: UpdateChapterDto) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id } });
    if (!chapter) throw new NotFoundException('Chapter not found');

    if (dto.number !== undefined && dto.number !== chapter.number) {
      const dup = await this.prisma.chapter.findFirst({
        where: { bookVersionId: chapter.bookVersionId, number: dto.number },
        select: { id: true },
      });
      if (dup) throw new BadRequestException('Chapter number must be unique within a version');
    }

    const updated = await this.clearanceLock.runInLockedClearance(
      chapter.bookVersionId,
      async (tx) => {
        const result = await tx.chapter.update({ where: { id }, data: dto });
        await this.rightsContentHashService.checkVersionStaleness(
          chapter.bookVersionId,
          'CHAPTER_UPDATED',
          null,
          true,
          tx,
        );
        return result;
      },
    );
    return updated;
  }

  async remove(id: string, actorUserId: string | null) {
    const chapter = await this.prisma.chapter.findUnique({ where: { id } });
    if (!chapter) throw new NotFoundException('Chapter not found');
    const bookVersionId = chapter.bookVersionId;
    const result = await this.clearanceLock.runInLockedClearance(bookVersionId, async (tx) => {
      const deleted = await tx.chapter.delete({ where: { id } });

      // `LEGACY-015`, пачка `T19`. Стоит **до** пометки свежести, а не после:
      // спека проверяет, что последней операцией под замком идёт именно она
      // (`chapter.service.spec.ts`), и порядок «удалили → записали → пересчитали»
      // это ожидание сохраняет. Замок группы к этому моменту уже взят —
      // `runInLockedClearance` берёт его первым оператором транзакции (`LEGACY-368`).
      await this.adminAudit.record(tx, {
        action: AdminAuditAction.CHAPTER_DELETED,
        targetType: AdminAuditTargetType.CHAPTER,
        targetId: id,
        actorUserId,
        payload: { bookVersionId },
      });

      await this.rightsContentHashService.checkVersionStaleness(
        bookVersionId,
        'CHAPTER_DELETED',
        null,
        true,
        tx,
      );
      return deleted;
    });
    return result;
  }

  private async ensureVersionExists(bookVersionId: string): Promise<void> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true },
    });
    if (!version) throw new NotFoundException('Book version not found');
  }

  private async ensureVersionPublished(bookVersionId: string): Promise<void> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { status: true },
    });
    if (!version || version.status !== 'published') {
      throw new NotFoundException('Book version not found');
    }
  }
}
