import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';
import {
  BOOK_ANALYSIS_SELECT,
  EMPTY_BOOK_ANALYSIS,
  mergeAnalysis,
  readStoredAnalysis,
  toAnalysisWrite,
  type StoredBookAnalysis,
} from './book-analysis-data';
import { computeAnalysisCore } from './book-analysis-core';
import { checkAnalysisRefs, collectChapterRefs } from './book-analysis-refs';
import type { UpdateBookAnalysisDto } from './dto/update-book-analysis.dto';
import type {
  BookAnalysisResponseDto,
  BookAnalysisSaveResponseDto,
  BookAnalysisWarningDto,
} from './dto/book-analysis-response.dto';

// Пространство имён двухаргументного `pg_advisory_xact_lock`; занятые — в перечне у `RECHECK_SCAN_LOCK_KEY`.
const BOOK_ANALYSIS_LOCK_NAMESPACE = 831_427_006;
// Явные границы (`L-020`): писатель, дождавшийся замка, не должен падать P2028 на дефолтных 5 секундах.
const BOOK_ANALYSIS_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

type AnalysisRow = Prisma.BookAnalysisGetPayload<{ select: typeof BOOK_ANALYSIS_SELECT }>;

@Injectable()
export class BookAnalysisService {
  constructor(
    private prisma: PrismaService,
    private readonly moderatorRoles: ModeratorRolesService,
    private readonly geoBlockRuleService: GeoBlockRuleService,
  ) {}

  /**
   * Публичное чтение и чтение вкладки админки — один адрес, как у пересказа: черновик версии
   * анониму — 404, редактору — запись; анализ без ядра анониму — `null`.
   *
   * Гео-блок: анализ отдаётся только там, где отдаётся текст версии (`TEXT_READER`, как список
   * глав). Строгий вариант до ответа владельца — решение арбитра А1 «к владельцу» (тема №4):
   * смена решения — правка одного `assertReaderAccess`. Редактор проверку не проходит: админская
   * выдача глав гео-блоком не режется (`ChapterService.listAdminByVersion`), вкладка — тоже.
   */
  async getByVersion(
    bookVersionId: string,
    actor: { userId: string; email: string } | undefined,
    countryCode: string | null,
  ): Promise<BookAnalysisResponseDto | null> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { status: true, language: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    const editor = await this.moderatorRoles.isModerator(actor);
    if (!editor) {
      if (version.status !== 'published') throw new NotFoundException('BookVersion not found');
      await this.assertReaderAccess(bookVersionId, countryCode);
    }

    const row = await this.prisma.bookAnalysis.findUnique({
      where: { bookVersionId },
      select: BOOK_ANALYSIS_SELECT,
    });
    // Без ядра анализа для читателя нет (`product.md` §2): незаконченные блоки видит только редактор.
    if (!row || (!editor && !row.hasCore)) return null;
    return toResponse(row, version.language);
  }

  /**
   * Запись под advisory-замком по версии: «прочитал — слил — записал» не теряет блок второго
   * писателя. `dryRun` (решение А3) проходит ту же проверку и слияние без замка и без записи.
   */
  async saveForVersion(
    bookVersionId: string,
    dto: UpdateBookAnalysisDto,
    dryRun: boolean,
  ): Promise<BookAnalysisSaveResponseDto> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { language: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');
    if (dto.language !== version.language) {
      throw new BadRequestException(
        `language: JSON is "${dto.language}", the version is "${version.language}"`,
      );
    }

    if (dryRun) {
      const existing = await this.prisma.bookAnalysis.findUnique({
        where: { bookVersionId },
        select: BOOK_ANALYSIS_SELECT,
      });
      const merged = this.validateMerged(existing, dto);
      return { analysis: null, ...(await this.describe(this.prisma, bookVersionId, merged)) };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT true AS locked
          FROM pg_advisory_xact_lock(${BOOK_ANALYSIS_LOCK_NAMESPACE}::int4, hashtext(${bookVersionId}::text))`;
        const existing = await tx.bookAnalysis.findUnique({
          where: { bookVersionId },
          select: BOOK_ANALYSIS_SELECT,
        });
        const merged = this.validateMerged(existing, dto);
        const summary = await this.describe(tx, bookVersionId, merged);
        const data = { ...toAnalysisWrite(merged), hasCore: summary.hasCore };
        const row = existing
          ? await tx.bookAnalysis.update({
              where: { bookVersionId },
              data,
              select: BOOK_ANALYSIS_SELECT,
            })
          : await tx.bookAnalysis.create({
              data: { bookVersionId, ...data },
              select: BOOK_ANALYSIS_SELECT,
            });
        return { analysis: toResponse(row, version.language), ...summary };
      }, BOOK_ANALYSIS_TX_OPTIONS);
    } catch (e: unknown) {
      // Версию проверяли до транзакции и без замка: удалённая в этом окне версия даёт FK-отказ
      // на create (P2003) или снятую каскадом строку на update (P2025) — это 404.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2003' || e.code === 'P2025')
      ) {
        throw new NotFoundException('BookVersion not found');
      }
      throw e;
    }
  }

  private validateMerged(existing: AnalysisRow | null, dto: UpdateBookAnalysisDto) {
    const merged = mergeAnalysis(
      existing ? readStoredAnalysis(existing) : EMPTY_BOOK_ANALYSIS,
      dto,
    );
    const errors = checkAnalysisRefs(merged);
    if (errors.length > 0) {
      throw new BadRequestException(errors.map((e) => `${e.path}: ${e.message}`));
    }
    return merged;
  }

  /** Ядро и предупреждения слитой записи: ненайденные главы (T4) и чего не хватает до ядра. */
  private async describe(
    db: Prisma.TransactionClient,
    bookVersionId: string,
    merged: StoredBookAnalysis,
  ): Promise<{ hasCore: boolean; warnings: BookAnalysisWarningDto[] }> {
    const warnings: BookAnalysisWarningDto[] = [];
    const refs = collectChapterRefs(merged);
    if (refs.length > 0) {
      // Только упомянутые номера (их не больше лимитов блоков): выборка всех глав с пределом
      // давала бы ложное «нет главы» на версии длиннее предела.
      const chapters = await db.chapter.findMany({
        where: { bookVersionId, number: { in: [...new Set(refs.map((r) => r.chapter))] } },
        select: { number: true },
      });
      const known = new Set(chapters.map((c) => c.number));
      for (const ref of refs) {
        if (!known.has(ref.chapter)) {
          warnings.push({
            code: 'chapter_not_found',
            path: ref.path,
            message: `chapter ${ref.chapter} is not in this version; the link will not be shown`,
          });
        }
      }
    }
    const core = computeAnalysisCore(merged);
    for (const m of core.missing) {
      warnings.push({
        code: 'core_incomplete',
        path: m.part,
        message:
          m.part === 'mainIdea'
            ? 'mainIdea is empty; the page will not be published'
            : `${m.part}: ${m.have} of ${m.need} filled; the page will not be published`,
      });
    }
    return { hasCore: core.hasCore, warnings };
  }

  private assertReaderAccess(bookVersionId: string, countryCode: string | null) {
    return this.geoBlockRuleService.assertAccess({
      bookVersionId,
      countryCode,
      scope: GeoBlockScope.TEXT_READER,
    });
  }
}

function toResponse(
  row: AnalysisRow,
  language: BookAnalysisResponseDto['language'],
): BookAnalysisResponseDto {
  return {
    language,
    hasCore: row.hasCore,
    ...readStoredAnalysis(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
