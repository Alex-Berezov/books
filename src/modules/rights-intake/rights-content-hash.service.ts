import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
  stableStringify,
  sha256Hex,
} from './rights-content-hash.util';
import {
  RightsContentHashComputationDto,
  RightsContentHashCheckDto,
} from './dto/rights-content-hash.dto';

type Trigger =
  | 'INITIAL_VERSION_SNAPSHOT'
  | 'BOOK_VERSION_UPDATED'
  | 'CHAPTER_CREATED'
  | 'CHAPTER_UPDATED'
  | 'CHAPTER_DELETED'
  | 'AUDIO_CHAPTER_CREATED'
  | 'AUDIO_CHAPTER_UPDATED'
  | 'AUDIO_CHAPTER_DELETED'
  | 'AUDIO_CHAPTER_REORDERED'
  | 'RIGHTS_SNAPSHOT_CHANGED'
  | 'SOURCE_EDITION_CHANGED'
  | 'REVIEW_IMPORT_CHANGED'
  | 'MANUAL_HASH_CHECK';

const TRIGGER_MESSAGES: Record<Trigger, string> = {
  INITIAL_VERSION_SNAPSHOT: 'Начальный слепок прав при создании версии',
  BOOK_VERSION_UPDATED: 'Изменены метаданные версии книги',
  CHAPTER_CREATED: 'Создана новая глава',
  CHAPTER_UPDATED: 'Изменена глава',
  CHAPTER_DELETED: 'Удалена глава',
  AUDIO_CHAPTER_CREATED: 'Создана новая аудио-глава',
  AUDIO_CHAPTER_UPDATED: 'Изменена аудио-глава',
  AUDIO_CHAPTER_DELETED: 'Удалена аудио-глава',
  AUDIO_CHAPTER_REORDERED: 'Изменён порядок аудио-глав',
  RIGHTS_SNAPSHOT_CHANGED: 'Изменён слепок прав',
  SOURCE_EDITION_CHANGED: 'Изменены данные исходного издания',
  REVIEW_IMPORT_CHANGED: 'Изменён импорт проверки прав',
  MANUAL_HASH_CHECK: 'Ручная проверка хеша контента',
};

@Injectable()
export class RightsContentHashService {
  constructor(private readonly prisma: PrismaService) {}

  async computeVersionHash(versionId: string): Promise<RightsContentHashComputationDto> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      include: {
        book: {
          select: {
            id: true,
            currentRightsProfileId: true,
            approvedRightsReviewId: true,
          },
        },
        chapters: {
          orderBy: { number: 'asc' },
        },
        audioChapters: {
          orderBy: { number: 'asc' },
          include: {
            media: {
              select: {
                id: true,
                key: true,
                url: true,
                contentType: true,
                size: true,
                duration: true,
                hash: true,
                isDeleted: true,
              },
            },
          },
        },
        previewMedia: {
          select: {
            id: true,
            key: true,
            url: true,
            contentType: true,
            size: true,
            duration: true,
            hash: true,
            isDeleted: true,
          },
        },
        rightsProfile: {
          include: {
            sourceEdition: {
              include: {
                editionRights: true,
              },
            },
            components: {
              orderBy: [{ componentType: 'asc' }, { id: 'asc' }],
            },
            territoryDecisions: {
              orderBy: { countryCode: 'asc' },
            },
            evidence: {
              orderBy: [
                { evidenceType: 'asc' },
                { authority: 'asc' },
                { title: 'asc' },
                { id: 'asc' },
              ],
            },
            actions: {
              orderBy: [{ actionType: 'asc' }, { id: 'asc' }],
            },
          },
        },
        approvedRightsReview: {
          include: {
            rightsReviewImport: true,
          },
        },
      },
    });

    if (!version) {
      throw new NotFoundException('BookVersion not found');
    }

    const versionAny = version as unknown as Record<string, unknown>;

    // Build snapshot input
    const chapters = ((versionAny['chapters'] as Array<Record<string, unknown>>) || []).map(
      (ch) => ({
        number: ch['number'],
        title: ch['title'],
        content: ch['content'],
      }),
    );

    const audioChapters = (
      (versionAny['audioChapters'] as Array<Record<string, unknown>>) || []
    ).map((ac) => ({
      number: ac['number'],
      title: ac['title'],
      audioUrl: ac['audioUrl'],
      duration: ac['duration'],
      description: ac['description'] ?? null,
      transcript: ac['transcript'] ?? null,
      mediaId: ac['mediaId'] ?? null,
      media: ac['media']
        ? {
            id: (ac['media'] as Record<string, unknown>)['id'],
            key: (ac['media'] as Record<string, unknown>)['key'],
            url: (ac['media'] as Record<string, unknown>)['url'],
            contentType: (ac['media'] as Record<string, unknown>)['contentType'] ?? null,
            size: (ac['media'] as Record<string, unknown>)['size'] ?? null,
            duration: (ac['media'] as Record<string, unknown>)['duration'] ?? null,
            hash: (ac['media'] as Record<string, unknown>)['hash'] ?? null,
            isDeleted: (ac['media'] as Record<string, unknown>)['isDeleted'] ?? false,
          }
        : null,
    }));

    const rightsProfile = versionAny['rightsProfile'] as Record<string, unknown> | null;
    const approvedRightsReview = versionAny['approvedRightsReview'] as Record<
      string,
      unknown
    > | null;

    const input: Record<string, unknown> = {
      algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
      identity: {
        bookId: versionAny['bookId'],
        versionId: versionAny['id'],
        language: versionAny['language'],
        type: versionAny['type'],
      },
      metadata: {
        title: versionAny['title'],
        author: versionAny['author'],
        authorId: versionAny['authorId'] ?? null,
        authorPageUrl: versionAny['authorPageUrl'] ?? null,
        description: versionAny['description'],
        shortDescription: versionAny['shortDescription'] ?? null,
        summaryShort: versionAny['summaryShort'] ?? null,
      },
      sourceTitleMetadata: {
        originalTitle: versionAny['originalTitle'] ?? null,
        originalLanguage: versionAny['originalLanguage'] ?? null,
        firstPublishedYear: versionAny['firstPublishedYear'] ?? null,
        editionPublishedYear: versionAny['editionPublishedYear'] ?? null,
        copyrightStatus: versionAny['copyrightStatus'] ?? null,
      },
      cover: {
        coverImageUrl: versionAny['coverImageUrl'],
        coverAlt: versionAny['coverAlt'] ?? null,
        previewMediaId: versionAny['previewMediaId'] ?? null,
      },
      structuredEditorialFields: {
        alternativeTitles: versionAny['alternativeTitles'] ?? null,
        characters: versionAny['characters'] ?? null,
        quotes: versionAny['quotes'] ?? null,
        faq: versionAny['faq'] ?? null,
        themes: versionAny['themes'] ?? null,
        symbols: versionAny['symbols'] ?? null,
      },
      chapters,
      audioChapters,
      previewMedia: versionAny['previewMedia']
        ? {
            id: (versionAny['previewMedia'] as Record<string, unknown>)['id'],
            key: (versionAny['previewMedia'] as Record<string, unknown>)['key'],
            url: (versionAny['previewMedia'] as Record<string, unknown>)['url'],
            contentType:
              (versionAny['previewMedia'] as Record<string, unknown>)['contentType'] ?? null,
            size: (versionAny['previewMedia'] as Record<string, unknown>)['size'] ?? null,
            duration: (versionAny['previewMedia'] as Record<string, unknown>)['duration'] ?? null,
            hash: (versionAny['previewMedia'] as Record<string, unknown>)['hash'] ?? null,
            isDeleted:
              (versionAny['previewMedia'] as Record<string, unknown>)['isDeleted'] ?? false,
          }
        : null,
      rightsLinks: {
        rightsProfileId: versionAny['rightsProfileId'],
        approvedRightsReviewId: versionAny['approvedRightsReviewId'],
      },
      rightsCountries: {
        rightsAllowedCountryCodes: versionAny['rightsAllowedCountryCodes'] ?? null,
        rightsBlockedCountryCodes: versionAny['rightsBlockedCountryCodes'] ?? null,
        rightsLicenseRequiredCountryCodes: versionAny['rightsLicenseRequiredCountryCodes'] ?? null,
        rightsPendingCountryCodes: versionAny['rightsPendingCountryCodes'] ?? null,
      },
      geoFields: {
        rightsGeoBlockRequired: versionAny['rightsGeoBlockRequired'] ?? false,
        rightsGeoBlockConfigured: versionAny['rightsGeoBlockConfigured'] ?? false,
      },
      rightsRequiredActions: versionAny['rightsRequiredActions'] ?? null,
      rightsProfile: rightsProfile
        ? {
            overallStatus: rightsProfile['overallStatus'],
            publicationGate: rightsProfile['publicationGate'],
            confidence: rightsProfile['confidence'],
            summaryRu: rightsProfile['summaryRu'] ?? null,
            conclusionRu: rightsProfile['conclusionRu'] ?? null,
            nextReviewAt: rightsProfile['nextReviewAt']
              ? new Date(rightsProfile['nextReviewAt'] as string).toISOString()
              : null,
            sourceEdition: this.serializeSourceEdition(
              rightsProfile['sourceEdition'] as Record<string, unknown> | null,
            ),
            components: ((rightsProfile['components'] as Array<Record<string, unknown>>) || []).map(
              (c) => ({
                componentType: c['componentType'],
                titleRu: c['titleRu'],
                status: c['status'],
                requiredAction: c['requiredAction'],
                confidence: c['confidence'],
              }),
            ),
            territoryDecisions: (
              (rightsProfile['territoryDecisions'] as Array<Record<string, unknown>>) || []
            ).map((td) => ({
              countryCode: td['countryCode'],
              finalStatus: td['finalStatus'],
              accessPolicy: td['accessPolicy'],
              geoBlockRequired: td['geoBlockRequired'] ?? false,
              geoBlockScope: td['geoBlockScope'] ?? null,
            })),
            evidence: ((rightsProfile['evidence'] as Array<Record<string, unknown>>) || []).map(
              (e) => ({
                evidenceType: e['evidenceType'],
                sourceLevel: e['sourceLevel'],
                title: e['title'],
                authority: e['authority'],
                url: e['url'] ?? null,
                jurisdictionCode: e['jurisdictionCode'] ?? null,
                accessedAt: e['accessedAt']
                  ? new Date(e['accessedAt'] as string).toISOString()
                  : null,
              }),
            ),
            actions: ((rightsProfile['actions'] as Array<Record<string, unknown>>) || []).map(
              (a) => ({
                actionType: a['actionType'],
                status: a['status'],
                affectedCountryCodes: a['affectedCountryCodes'] ?? null,
                isBlocking: a['isBlocking'] ?? false,
              }),
            ),
          }
        : null,
      rightsReview: approvedRightsReview
        ? {
            schemaVersion: approvedRightsReview['schemaVersion'] ?? null,
            reviewerType: approvedRightsReview['reviewerType'],
            overallStatus: approvedRightsReview['overallStatus'],
            publicationGate: approvedRightsReview['publicationGate'],
            confidence: approvedRightsReview['confidence'],
            summaryRu: approvedRightsReview['summaryRu'] ?? null,
            conclusionRu: approvedRightsReview['conclusionRu'] ?? null,
            nextReviewAt: approvedRightsReview['nextReviewAt']
              ? new Date(approvedRightsReview['nextReviewAt'] as string).toISOString()
              : null,
            rightsReviewImport: this.serializeReviewImport(
              approvedRightsReview['rightsReviewImport'] as Record<string, unknown> | null,
            ),
          }
        : null,
    };

    const serialized = stableStringify(input);
    const hash = sha256Hex(serialized);
    const algorithmVersion = RIGHTS_CONTENT_HASH_ALGORITHM_VERSION;

    return {
      versionId: versionAny['id'] as string,
      rightsProfileId: (versionAny['rightsProfileId'] as string) ?? null,
      approvedRightsReviewId: (versionAny['approvedRightsReviewId'] as string) ?? null,
      hash,
      algorithmVersion,
      calculatedAt: new Date().toISOString(),
      input,
    };
  }

  async initializeVersionBaseline(
    versionId: string,
    trigger: Trigger,
    userId?: string | null,
  ): Promise<RightsContentHashComputationDto> {
    const computation = await this.computeVersionHash(versionId);

    await this.prisma.bookVersion.update({
      where: { id: versionId },
      data: {
        rightsContentHash: computation.hash,
        rightsContentHashAlgorithmVersion: computation.algorithmVersion,
        rightsContentHashInput: JSON.parse(
          JSON.stringify(computation.input),
        ) as Prisma.InputJsonValue,
        rightsContentHashCalculatedAt: new Date(computation.calculatedAt),
        rightsRecheckRequired: false,
        rightsStaleDetectedAt: null,
        rightsStaleReasonCode: null,
        rightsStaleReasonRu: null,
      },
    });

    await this.prisma.rightsContentHashEvent.create({
      data: {
        bookVersionId: versionId,
        rightsProfileId: computation.rightsProfileId,
        rightsReviewId: computation.approvedRightsReviewId,
        trigger: trigger as never,
        previousHash: null,
        currentHash: computation.hash,
        hashAlgorithmVersion: computation.algorithmVersion,
        staleMarked: false,
        createdByUserId: userId ?? null,
      },
    });

    return computation;
  }

  async checkVersionStaleness(
    versionId: string,
    trigger: Trigger,
    userId?: string | null,
    persist = false,
  ): Promise<RightsContentHashCheckDto> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        rightsContentHash: true,
        rightsContentHashAlgorithmVersion: true,
        rightsRecheckRequired: true,
        rightsStaleReasonCode: true,
        rightsStaleReasonRu: true,
      },
    });

    if (!version) {
      throw new NotFoundException('BookVersion not found');
    }

    const computation = await this.computeVersionHash(versionId);
    const baselineHash = version.rightsContentHash;
    const matchesBaseline = baselineHash === computation.hash;
    const isStale = !matchesBaseline || version.rightsRecheckRequired;

    if (!matchesBaseline && persist) {
      await this.markVersionAndClearanceStale(
        versionId,
        trigger,
        computation.hash,
        baselineHash,
        userId,
      );
    }

    if (persist) {
      await this.prisma.rightsContentHashEvent.create({
        data: {
          bookVersionId: versionId,
          rightsProfileId: computation.rightsProfileId,
          rightsReviewId: computation.approvedRightsReviewId,
          trigger: trigger as never,
          previousHash: baselineHash,
          currentHash: computation.hash,
          hashAlgorithmVersion: computation.algorithmVersion,
          staleMarked: !matchesBaseline,
          reasonCode: !matchesBaseline ? trigger : null,
          reasonRu: !matchesBaseline ? TRIGGER_MESSAGES[trigger] : null,
          createdByUserId: userId ?? null,
        },
      });
    }

    return {
      versionId: version.id,
      baselineHash,
      currentHash: computation.hash,
      algorithmVersion: computation.algorithmVersion,
      matchesBaseline,
      isStale,
      recheckRequired: version.rightsRecheckRequired || !matchesBaseline,
      reasonCode: version.rightsStaleReasonCode ?? (!matchesBaseline ? trigger : null),
      reasonRu:
        version.rightsStaleReasonRu ?? (!matchesBaseline ? TRIGGER_MESSAGES[trigger] : null),
      checkedAt: new Date().toISOString(),
    };
  }

  async markVersionAndClearanceStale(
    versionId: string,
    trigger: Trigger,
    currentHash: string,
    previousHash: string | null,
    userId?: string | null,
  ): Promise<void> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        rightsProfileId: true,
        approvedRightsReviewId: true,
        rightsStaleDetectedAt: true,
      },
    });

    if (!version) {
      throw new NotFoundException('BookVersion not found');
    }

    const now = new Date();
    const reasonCode = trigger;
    const reasonRu = TRIGGER_MESSAGES[trigger];
    const staleReason = {
      rightsStaleDetectedAt: now,
      rightsStaleReasonCode: reasonCode,
      rightsStaleReasonRu: reasonRu,
    };

    await this.prisma.$transaction(async (tx) => {
      // Update BookVersion
      await tx.bookVersion.update({
        where: { id: versionId },
        data: {
          rightsRecheckRequired: true,
          ...staleReason,
        },
      });

      // Update RightsReview status to STALE if review exists
      if (version.approvedRightsReviewId) {
        await tx.rightsReview.update({
          where: { id: version.approvedRightsReviewId },
          data: {
            status: 'STALE' as never,
            staleDetectedAt: now,
            staleReasonCode: reasonCode,
            staleReasonRu: reasonRu,
          },
        });

        // Check related versions and mark stale only if their hash changed
        const relatedVersions = await tx.bookVersion.findMany({
          where: {
            approvedRightsReviewId: version.approvedRightsReviewId,
            id: { not: versionId },
            rightsStaleDetectedAt: null,
          },
          select: {
            id: true,
            rightsContentHash: true,
          },
        });

        for (const relatedVersion of relatedVersions) {
          if (relatedVersion.rightsContentHash) {
            try {
              const relatedComputation = await this.computeVersionHash(relatedVersion.id);
              if (relatedComputation.hash !== relatedVersion.rightsContentHash) {
                await tx.bookVersion.update({
                  where: { id: relatedVersion.id },
                  data: {
                    rightsRecheckRequired: true,
                    ...staleReason,
                  },
                });
              }
            } catch {
              // If hash computation fails, skip this version
            }
          }
        }
      }

      // Update RightsProfile status to STALE if profile exists
      if (version.rightsProfileId) {
        await tx.rightsProfile.update({
          where: { id: version.rightsProfileId },
          data: {
            status: 'STALE' as never,
            staleDetectedAt: now,
            staleReasonCode: reasonCode,
            staleReasonRu: reasonRu,
          },
        });

        // Check related versions and mark stale only if their hash changed
        const relatedVersions = await tx.bookVersion.findMany({
          where: {
            rightsProfileId: version.rightsProfileId,
            id: { not: versionId },
            rightsStaleDetectedAt: null,
          },
          select: {
            id: true,
            rightsContentHash: true,
          },
        });

        for (const relatedVersion of relatedVersions) {
          if (relatedVersion.rightsContentHash) {
            try {
              const relatedComputation = await this.computeVersionHash(relatedVersion.id);
              if (relatedComputation.hash !== relatedVersion.rightsContentHash) {
                await tx.bookVersion.update({
                  where: { id: relatedVersion.id },
                  data: {
                    rightsRecheckRequired: true,
                    ...staleReason,
                  },
                });
              }
            } catch {
              // If hash computation fails, skip this version
            }
          }
        }
      }

      // Create audit event
      await tx.rightsContentHashEvent.create({
        data: {
          bookVersionId: versionId,
          rightsProfileId: version.rightsProfileId,
          rightsReviewId: version.approvedRightsReviewId,
          trigger: trigger as never,
          previousHash,
          currentHash,
          hashAlgorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
          staleMarked: true,
          reasonCode,
          reasonRu,
          createdByUserId: userId ?? null,
        },
      });
    });
  }

  private serializeSourceEdition(
    sourceEdition: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!sourceEdition) return null;
    return {
      provider: sourceEdition['provider'],
      externalId: sourceEdition['externalId'] ?? null,
      sourceUrl: sourceEdition['sourceUrl'] ?? null,
      sourceTitle: sourceEdition['sourceTitle'] ?? null,
      sourceLanguage: sourceEdition['sourceLanguage'] ?? null,
      sourceTextType: sourceEdition['sourceTextType'],
      gutenbergStatus: sourceEdition['gutenbergStatus'] ?? null,
      status: sourceEdition['status'],
      editionRights: sourceEdition['editionRights']
        ? {
            status: (sourceEdition['editionRights'] as Record<string, unknown>)['status'],
            legalBasisRu:
              (sourceEdition['editionRights'] as Record<string, unknown>)['legalBasisRu'] ?? null,
            notesRu: (sourceEdition['editionRights'] as Record<string, unknown>)['notesRu'] ?? null,
          }
        : null,
    };
  }

  private serializeReviewImport(
    reviewImport: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!reviewImport) return null;
    return {
      schemaVersion: reviewImport['schemaVersion'] ?? null,
      sourceFileName: reviewImport['sourceFileName'] ?? null,
      reportJsonSha256: reviewImport['reportJsonSha256'] ?? null,
      reportMarkdownSha256: reviewImport['reportMarkdownSha256'] ?? null,
      rawAgentOutputSha256: reviewImport['rawAgentOutputSha256'] ?? null,
    };
  }
}
