import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_SERVICE, StorageService } from '../../shared/storage/storage.interface';
import {
  MEDIA_UNREFERENCED_BY_FK,
  MEDIA_URL_REFERENCE_FIELDS,
  findUrlReferencedKeys,
} from '../media/media-references';

export interface CleanupResult {
  markedSoftDeleted: number;
  hardDeleted: number;
  storageFilesRemoved: number;
  storageErrors: number;
  /**
   * Сколько строк прогон реально посмотрел на stage 1.
   *
   * 🔴 Без этого числа `markedSoftDeleted: 0` неотличимо от «критерий не выбрал ничего»
   * (`L-015`): пустая уборка и сломанная уборка отдают одно и то же тело. Именно этим
   * ответом подтверждается первый прогон на боевых данных, поэтому число считается
   * всегда, а не только в `dryRun`.
   */
  scanned: number;
  /** Из посмотренных: сколько спасла проверка ссылок по URL (`MEDIA_URL_REFERENCE_FIELDS`). */
  skippedByUrlReference: number;
  softDeletedCandidates?: string[];
  hardDeletedCandidates?: string[];
}

export interface CleanupOptions {
  softDays?: number;
  hardDays?: number;
  dryRun?: boolean;
}

/**
 * Ключ `pg_advisory_xact_lock(bigint)` уборки медиа (LEGACY-413). Та же перегрузка и тот же
 * ряд, что `CATEGORY_TREE_LOCK_KEY` (`8_314_270_001n`) и `RECHECK_SCAN_LOCK_KEY`
 * (`8_314_270_002n`): одноаргументные ключи не пересекаются с двухаргументными
 * пространствами имён других модулей.
 */
export const MEDIA_CLEANUP_LOCK_KEY = 8_314_270_003n;

export const MEDIA_CLEANUP_ALREADY_RUNNING = 'MEDIA_CLEANUP_ALREADY_RUNNING';

/**
 * Транзакция держит только замок, пока прогон идёт через `this.prisma` мимо неё, поэтому
 * `timeout` — это потолок длительности прогона, а не записи. Stage 2 удаляет файлы по одному
 * с сетевым вызовом на каждый; час — запас на порядки больше нынешних объёмов.
 */
const MEDIA_CLEANUP_LOCK_TX_OPTIONS = { timeout: 60 * 60_000, maxWait: 10_000 } as const;

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
   * All five foreign keys to MediaAsset are `ON DELETE SET NULL`: deleting a referenced row
   * does not fail, it silently nulls the reference. Stage 1 therefore has to see every one of
   * them (`MEDIA_UNREFERENCED_BY_FK`) plus every URL column — nothing downstream refuses.
   */
  async cleanup(options?: CleanupOptions): Promise<CleanupResult> {
    const result = await this.cleanupIfIdle(options);
    if (!result) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: MEDIA_CLEANUP_ALREADY_RUNNING,
        message: 'Media cleanup is already running',
      });
    }
    return result;
  }

  /**
   * Прогон под замком, общим для таймера и `POST /admin/media/cleanup-orphans` (LEGACY-413).
   * Замок занят — `null` без работы: два прогона по пересекающимся кандидатам удваивали бы
   * счётчики и ловили `P2025` на строках, которые удалил сосед.
   *
   * 🔴 Вся работа идёт через `this.prisma`, а не через `tx`: откат транзакции не должен
   * возвращать строки к файлам, которые stage 2 уже удалил из хранилища. Через `tx` идёт
   * только `SELECT 1` перед каждой записью: транзакция, закрытая по `timeout`, уже отпустила
   * замок, и этот запрос обрывает прогон, а не даёт ему идти рядом с соседним.
   *
   * Разведение с rights-recheck совпадает по поведению (409 ручному пути, пропуск таймеру),
   * а не по устройству: там замок держится только на claim строки запуска.
   */
  async cleanupIfIdle(options?: CleanupOptions): Promise<CleanupResult | null> {
    return this.prisma.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${MEDIA_CLEANUP_LOCK_KEY}) AS locked`;
      if (!lock?.locked) return null;
      const assertLockHeld = async (): Promise<void> => {
        await tx.$queryRaw`SELECT 1`;
      };
      return this.runCleanup(assertLockHeld, options);
    }, MEDIA_CLEANUP_LOCK_TX_OPTIONS);
  }

  private async runCleanup(
    assertLockHeld: () => Promise<void>,
    options?: CleanupOptions,
  ): Promise<CleanupResult> {
    const softDays = options?.softDays ?? Number(process.env.MEDIA_CLEANUP_SOFT_DAYS ?? 7);
    const hardDays = options?.hardDays ?? Number(process.env.MEDIA_CLEANUP_HARD_DAYS ?? 30);
    const dryRun = options?.dryRun ?? false;
    const now = new Date();
    const softCutoff = new Date(now.getTime() - softDays * 86400 * 1000);
    const hardCutoff = new Date(now.getTime() - hardDays * 86400 * 1000);

    // Stage 1: find orphans — no row references the asset by any of the five foreign keys
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
        ...MEDIA_UNREFERENCED_BY_FK,
      },
      select: { id: true, key: true },
    });

    const referencedKeys = await findUrlReferencedKeys(
      this.prisma,
      fkCandidates.map((asset) => asset.key),
    );
    const softCandidates = fkCandidates.filter((asset) => !referencedKeys.has(asset.key));

    const skippedByUrlReference = fkCandidates.length - softCandidates.length;
    if (skippedByUrlReference > 0) {
      // Не «шум», а полезный сигнал: это ровно те объекты, которые прежний критерий
      // пометил бы на удаление.
      this.logger.log(
        `Skipped ${skippedByUrlReference} asset(s) referenced only by a URL or key column ` +
          `(${MEDIA_URL_REFERENCE_FIELDS.length} columns checked, media-url-columns.ts).`,
      );
    }

    let markedSoftDeleted = 0;
    if (!dryRun && softCandidates.length > 0) {
      await assertLockHeld();
      const ids = softCandidates.map((a) => a.id);
      // Условие по внешним ключам повторяется в самой записи: пока шла проверка адресов,
      // редактор мог прикрепить ассет к главе или лицензии, а замок уборки правки не держит.
      const res = await this.prisma.mediaAsset.updateMany({
        where: { id: { in: ids }, isDeleted: false, ...MEDIA_UNREFERENCED_BY_FK },
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
        // Вне обоих `try`: ошибка закрытой транзакции обязана оборвать цикл, а не уйти в warn.
        await assertLockHeld();
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
      scanned: fkCandidates.length + hardCandidates.length,
      skippedByUrlReference,
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
