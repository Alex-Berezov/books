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

// Предохранитель списка названий глав: глав в версии на порядки меньше.
const CHAPTER_TITLES_MAX = 5_000;

/** Запись главы внутри `rewriteLocked`: все обращения - через транзакцию под замком прав. */
export interface LockedChapterWriter {
  /** Статус версии под замком её строки; `null` - версии нет. */
  versionStatus(): Promise<string | null>;
  /** Строка главы версии под `FOR UPDATE`; `null` - главы нет. */
  lockChapter(id: string): Promise<{ id: string; content: string } | null>;
  /** Номер уже занят главой версии. */
  numberTaken(number: number): Promise<boolean>;
  /** `id` - замена текста существующей главы, без него - новая глава с номером и названием. */
  write(data: { id?: string; number: number; title: string; content: string }): Promise<Chapter>;
}

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

  /**
   * Номера и названия глав без текста — «Вводные для промпта» анализа (F03-1, решение арбитра А5):
   * `listInternal` тянет полный `content` каждой главы, на большой книге это мегабайты.
   */
  async listAdminTitles(bookVersionId: string) {
    await this.ensureVersionExists(bookVersionId);
    const where = { bookVersionId };
    // `total` — настоящий: усечение пределом видно потребителю (`LEGACY-098`), «Вводные» пишут
    // «показано N из M».
    const [items, total] = await this.prisma.$transaction([
      this.prisma.chapter.findMany({
        where,
        orderBy: { number: 'asc' },
        select: { number: true, title: true },
        take: CHAPTER_TITLES_MAX,
      }),
      this.prisma.chapter.count({ where }),
    ]);
    return paginated(items, { page: 1, limit: CHAPTER_TITLES_MAX, total });
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
      return await this.createLocked(bookVersionId, {
        number: chapterNumber,
        title: dto.title,
        content: dto.content,
      });
    } catch (e: unknown) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Chapter number must be unique within a version');
      }
      throw e;
    }
  }

  /**
   * Запись главы под замком проверки прав и с пометкой свежести - общий путь ручного создания и
   * запуска перевода (`F05-6`, 6b; D3: правовой учёт текста мимо этого пути не обходится).
   * `afterCreate` выполняется в той же транзакции, номер занят - `P2002` как у ручного пути.
   */
  async createLocked(
    bookVersionId: string,
    data: { number: number; title: string; content: string },
    afterCreate?: (tx: Prisma.TransactionClient, created: Chapter) => Promise<void>,
  ): Promise<Chapter> {
    return this.clearanceLock.runInLockedClearance(bookVersionId, async (tx) => {
      const created = await tx.chapter.create({ data: { bookVersionId, ...data } });
      await this.rightsContentHashService.checkVersionStaleness(
        bookVersionId,
        'CHAPTER_CREATED',
        null,
        true,
        tx,
      );
      await afterCreate?.(tx, created);
      return created;
    });
  }

  /**
   * Перезапись или создание главы черновика по Р9 (`F05-7v`): тот же замок проверки прав и та же
   * пометка свежести, что у ручных путей (D3). `body` решает в той же транзакции, писать ли:
   * статус версии читается после замка строки версии (`FOR NO KEY UPDATE` замка прав держит
   * публикацию), текст главы - под `FOR UPDATE` её строки (`lockChapter`). Ручное сохранение
   * главы ждёт этот же замок прав, поэтому проходит одно из двух, а сверка - уже по итогу первого.
   */
  async rewriteLocked<T>(
    bookVersionId: string,
    body: (tx: Prisma.TransactionClient, chapters: LockedChapterWriter) => Promise<T>,
  ): Promise<T> {
    return this.clearanceLock.runInLockedClearance(bookVersionId, async (tx) => {
      const writer: LockedChapterWriter = {
        versionStatus: async () =>
          (
            await tx.bookVersion.findUnique({
              where: { id: bookVersionId },
              select: { status: true },
            })
          )?.status ?? null,
        lockChapter: async (id) => {
          const rows = await tx.$queryRaw<Array<{ id: string; content: string }>>`
            SELECT "id", "content" FROM "Chapter"
            WHERE "id" = ${id} AND "bookVersionId" = ${bookVersionId}
            FOR UPDATE`;
          return rows[0] ?? null;
        },
        numberTaken: async (number) =>
          (await tx.chapter.findUnique({
            where: { bookVersionId_number: { bookVersionId, number } },
            select: { id: true },
          })) !== null,
        write: async (data) => {
          const written = data.id
            ? await tx.chapter.update({ where: { id: data.id }, data: { content: data.content } })
            : await tx.chapter.create({
                data: {
                  bookVersionId,
                  number: data.number,
                  title: data.title,
                  content: data.content,
                },
              });
          await this.rightsContentHashService.checkVersionStaleness(
            bookVersionId,
            data.id ? 'CHAPTER_UPDATED' : 'CHAPTER_CREATED',
            null,
            true,
            tx,
          );
          return written;
        },
      };
      return body(tx, writer);
    });
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
