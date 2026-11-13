import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { unfinishedRunLanguages } from '../book-version/book-language-lock';
import { approvedTargetLanguages } from '../book-version/intake-target-languages';
import {
  dossierSourceVersionId,
  selectTranslationSource,
  SourceCandidate,
  TranslationSource,
} from './translation-source';
import { TARGET_VERSION_SELECT, targetVersionState } from './target-version-text';

export interface VersionTranslationSource {
  bookId: string;
  source: TranslationSource;
  /**
   * Одобренные языки анкеты прав (`approvedTargetLanguages`), `null` - списка нет. Причина цели
   * одна на язык и причины версии (`VERSION_PUBLISHED`, `VERSION_HAS_TEXT`) стоят раньше
   * `NOT_IN_INTAKE`: тому, кто разрешает язык с версией (сравнение `F05-3`, С5), анкету надо
   * проверять по этому списку.
   */
  intakeTargets: readonly unknown[] | null;
  /** Версия, чьё досье берёт открытая версия (Р5, В10). */
  dossierSourceVersionId: string;
}

/** Исходник перевода по D8 для версии - чтение базы вокруг чистой функции выбора. */
@Injectable()
export class TranslationSourceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `withRunsInProgress` - причина «на язык идёт перевод» (ручка, оценка и старт запуска): лишний запрос, поэтому
   * не по умолчанию - шаги исполнителя зовут метод ради досье (`dossierSourceOf`) на каждом шаге.
   */
  async forVersion(
    versionId: string,
    options: { withRunsInProgress?: boolean } = {},
  ): Promise<VersionTranslationSource> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: {
        bookId: true,
        book: {
          select: {
            rightsIntake: { select: { targetLanguages: true } },
            // Версия на язык одна (`@@unique([bookId, language])`): строк не больше пяти.
            versions: {
              select: { ...TARGET_VERSION_SELECT, originalLanguage: true, createdAt: true },
            },
          },
        },
      },
    });
    if (!version) throw new NotFoundException('Book version not found');
    const intakeTargets = approvedTargetLanguages(version.book.rightsIntake?.targetLanguages);
    const versions: SourceCandidate[] = await Promise.all(
      version.book.versions.map(async (v) => ({
        id: v.id,
        language: v.language,
        originalLanguage: v.originalLanguage,
        createdAt: v.createdAt,
        chaptersWithText: v._count.chapters,
        ...(await targetVersionState(this.prisma, v, intakeTargets)),
      })),
    );
    const inProgress = options.withRunsInProgress
      ? await unfinishedRunLanguages(this.prisma, version.bookId)
      : undefined;
    const source = selectTranslationSource({ versionId, versions, intakeTargets, inProgress });
    return {
      bookId: version.bookId,
      source,
      intakeTargets,
      dossierSourceVersionId: dossierSourceVersionId(source, versions, versionId),
    };
  }
}
