import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { approvedTargetLanguages } from '../book-version/intake-target-languages';
import {
  dossierSourceVersionId,
  selectTranslationSource,
  SourceCandidate,
  TranslationSource,
} from './translation-source';

export interface VersionTranslationSource {
  bookId: string;
  source: TranslationSource;
  /**
   * Одобренные языки анкеты прав (`approvedTargetLanguages`), `null` - списка нет. Причина цели
   * одна на язык и `VERSION_EXISTS` стоит раньше `NOT_IN_INTAKE`: тому, кто разрешает язык
   * с версией (сравнение `F05-3`, С5), анкету надо проверять по этому списку.
   */
  intakeTargets: readonly unknown[] | null;
  /** Версия, чьё досье берёт открытая версия (Р5, В10). */
  dossierSourceVersionId: string;
}

/** Исходник перевода по D8 для версии - чтение базы вокруг чистой функции выбора. */
@Injectable()
export class TranslationSourceService {
  constructor(private readonly prisma: PrismaService) {}

  async forVersion(versionId: string): Promise<VersionTranslationSource> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: {
        bookId: true,
        book: {
          select: {
            rightsIntake: { select: { targetLanguages: true } },
            // Версия на язык одна (`@@unique([bookId, language])`): строк не больше пяти.
            versions: {
              select: {
                id: true,
                language: true,
                originalLanguage: true,
                createdAt: true,
                _count: { select: { chapters: { where: { content: { not: '' } } } } },
              },
            },
          },
        },
      },
    });
    if (!version) throw new NotFoundException('Book version not found');
    const versions: SourceCandidate[] = version.book.versions.map((v) => ({
      id: v.id,
      language: v.language,
      originalLanguage: v.originalLanguage,
      createdAt: v.createdAt,
      chaptersWithText: v._count.chapters,
    }));
    const intakeTargets = approvedTargetLanguages(version.book.rightsIntake?.targetLanguages);
    const source = selectTranslationSource({ versionId, versions, intakeTargets });
    return {
      bookId: version.bookId,
      source,
      intakeTargets,
      dossierSourceVersionId: dossierSourceVersionId(source, versions, versionId),
    };
  }
}
