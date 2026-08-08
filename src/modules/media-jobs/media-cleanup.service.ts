import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_SERVICE, StorageService } from '../../shared/storage/storage.interface';
import { loadUrlReferenceChecker } from '../media/media-references';

export interface CleanupResult {
  markedSoftDeleted: number;
  hardDeleted: number;
  storageFilesRemoved: number;
  storageErrors: number;
  softDeletedCandidates?: string[];
  hardDeletedCandidates?: string[];
}

@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger(MediaCleanupService.name);
  private lastRunAt: Date | null = null;
  private totalMarkedSoftDeleted = 0;
  private totalHardDeleted = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  /**
   * Two-stage orphan cleanup.
   *
   * Stage 1: MediaAsset rows with no inbound references older than `softDays` days
   *          and not yet soft-deleted → set isDeleted=true, deletedAt=now.
   * Stage 2: MediaAsset rows already soft-deleted and deletedAt older than `hardDays`
   *          → remove storage file and delete row.
   *
   * Safe: FK ON DELETE SET NULL on AudioChapter.mediaId and BookVersion.previewMediaId
   * means references are never orphaned if we accidentally delete a row.
   */
  async cleanup(options?: {
    softDays?: number;
    hardDays?: number;
    dryRun?: boolean;
  }): Promise<CleanupResult> {
    const softDays = options?.softDays ?? Number(process.env.MEDIA_CLEANUP_SOFT_DAYS ?? 7);
    const hardDays = options?.hardDays ?? Number(process.env.MEDIA_CLEANUP_HARD_DAYS ?? 30);
    const dryRun = options?.dryRun ?? false;
    const now = new Date();
    const softCutoff = new Date(now.getTime() - softDays * 86400 * 1000);
    const hardCutoff = new Date(now.getTime() - hardDays * 86400 * 1000);

    // Stage 1: find orphans (no audioChapters referencing, no previewVersions referencing)
    //
    // 🔴 Внешних ключей недостаточно (LEGACY-058). Обложка книги связана строкой
    // `BookVersion.coverImageUrl`, а не FK, поэтому по этому условию **любая обложка**
    // выглядела сиротой: замер на проде 05.08.2026 дал 56 кандидатов из 56 записей,
    // включая все восемь обложек опубликованных книг. Stage 2 удалил бы их файлы через
    // 30 дней — когда связь с причиной уже не очевидна.
    //
    // Правило про ссылки-строки живёт в `media/media-references.ts` — одно и то же для
    // уборки и для `DELETE /media/:id`. Раздельные копии разошлись бы, и уборка снова
    // начала бы удалять то, что удалять запрещено вручную.
    const fkCandidates = await this.prisma.mediaAsset.findMany({
      where: {
        isDeleted: false,
        createdAt: { lt: softCutoff },
        audioChapters: { none: {} },
        previewVersions: { none: {} },
      },
      select: { id: true, key: true },
    });

    const isReferencedByUrl = await loadUrlReferenceChecker(this.prisma);
    const softCandidates = fkCandidates.filter((asset) => !isReferencedByUrl(asset.key));

    const skippedByUrlReference = fkCandidates.length - softCandidates.length;
    if (skippedByUrlReference > 0) {
      // Не «шум», а полезный сигнал: это ровно те объекты, которые прежний критерий
      // пометил бы на удаление.
      this.logger.log(
        `Skipped ${skippedByUrlReference} asset(s) referenced by URL only (covers, audio, avatars).`,
      );
    }

    let markedSoftDeleted = 0;
    if (!dryRun && softCandidates.length > 0) {
      const ids = softCandidates.map((a) => a.id);
      const res = await this.prisma.mediaAsset.updateMany({
        where: { id: { in: ids } },
        data: { isDeleted: true, deletedAt: now },
      });
      markedSoftDeleted = res.count;
    }

    // Stage 2: find already soft-deleted assets past hardCutoff
    const hardCandidates = await this.prisma.mediaAsset.findMany({
      where: {
        isDeleted: true,
        deletedAt: { lt: hardCutoff, not: null },
      },
      select: { id: true, key: true },
    });

    let hardDeleted = 0;
    let storageFilesRemoved = 0;
    let storageErrors = 0;
    if (!dryRun) {
      for (const asset of hardCandidates) {
        try {
          await this.storage.delete(asset.key);
          storageFilesRemoved += 1;
        } catch (e) {
          storageErrors += 1;
          this.logger.warn(`Failed to remove storage object ${asset.key}: ${(e as Error).message}`);
        }
        try {
          await this.prisma.mediaAsset.delete({ where: { id: asset.id } });
          hardDeleted += 1;
        } catch (e) {
          this.logger.warn(`Failed to hard-delete MediaAsset ${asset.id}: ${(e as Error).message}`);
        }
      }
    }

    this.lastRunAt = now;
    this.totalMarkedSoftDeleted += markedSoftDeleted;
    this.totalHardDeleted += hardDeleted;

    const result: CleanupResult = {
      markedSoftDeleted: dryRun ? softCandidates.length : markedSoftDeleted,
      hardDeleted: dryRun ? hardCandidates.length : hardDeleted,
      storageFilesRemoved,
      storageErrors,
    };
    if (dryRun) {
      result.softDeletedCandidates = softCandidates.map((a) => a.id);
      result.hardDeletedCandidates = hardCandidates.map((a) => a.id);
    }
    this.logger.log(
      `Cleanup ${dryRun ? '(dry-run) ' : ''}done: soft=${result.markedSoftDeleted}, hard=${result.hardDeleted}, files=${storageFilesRemoved}`,
    );
    return result;
  }

  getMetrics() {
    return {
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      totalMarkedSoftDeleted: this.totalMarkedSoftDeleted,
      totalHardDeleted: this.totalHardDeleted,
    };
  }
}
