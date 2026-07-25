import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PublicationGateResultDto,
  PublicationGateReasonDto,
} from './dto/publication-gate-result.dto';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';

interface VersionWithGeoBlock {
  id: string;
  bookId: string;
  rightsProfileId: string | null;
  approvedRightsReviewId: string | null;
  rightsStatus: string | null;
  rightsBlockedCountryCodes: unknown;
  rightsLicenseRequiredCountryCodes: unknown;
  rightsPendingCountryCodes: unknown;
  rightsGeoBlockRequired: boolean;
  rightsGeoBlockConfigured: boolean;
  rightsContentHash: string | null;
  rightsRecheckRequired: boolean;
  book: {
    id: string;
    currentRightsProfileId: string | null;
    approvedRightsReviewId: string | null;
  };
}

@Injectable()
export class PublicationGateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rightsContentHashService: RightsContentHashService,
  ) {}

  async checkVersionCanPublish(versionId: string): Promise<PublicationGateResultDto> {
    const blockingReasons: PublicationGateReasonDto[] = [];
    const warnings: PublicationGateReasonDto[] = [];

    const rawVersion = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      include: {
        book: {
          select: {
            id: true,
            currentRightsProfileId: true,
            approvedRightsReviewId: true,
          },
        },
      },
    });

    if (!rawVersion) {
      throw new NotFoundException('BookVersion not found');
    }

    const version = rawVersion as unknown as VersionWithGeoBlock;
    const book = version.book;

    // 6.2 No rightsProfileId
    if (!version.rightsProfileId) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'MISSING_RIGHTS_PROFILE',
          severity: 'BLOCKER',
          messageRu: 'У версии книги нет связанного rights profile.',
        }),
      );
    }

    // 6.3 No approvedRightsReviewId
    if (!version.approvedRightsReviewId) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'MISSING_APPROVED_RIGHTS_REVIEW',
          severity: 'BLOCKER',
          messageRu: 'У версии книги нет утверждённой проверки авторских прав.',
        }),
      );
    }

    let review: { status: string } | null = null;
    if (version.approvedRightsReviewId) {
      review = await this.prisma.rightsReview.findUnique({
        where: { id: version.approvedRightsReviewId },
        select: { status: true },
      });
    }

    // 6.4 Review not found
    if (version.approvedRightsReviewId && !review) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'APPROVED_REVIEW_NOT_FOUND',
          severity: 'BLOCKER',
          messageRu:
            'Утверждённая проверка авторских прав (RightsReview) не найдена в базе данных.',
        }),
      );
    }

    // 6.5 Review not HUMAN_APPROVED
    if (review && review.status !== 'HUMAN_APPROVED') {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'RIGHTS_REVIEW_NOT_APPROVED',
          severity: 'BLOCKER',
          messageRu: 'Проверка авторских прав не утверждена. Текущий статус: ' + review.status,
        }),
      );
    }

    // 6.6 Review stale/superseded/rejected
    if (review) {
      if (review.status === 'STALE') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_REVIEW_STALE',
            severity: 'BLOCKER',
            messageRu: 'Проверка авторских прав устарела (STALE). Требуется повторная проверка.',
          }),
        );
      }
      if (review.status === 'SUPERSEDED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_REVIEW_SUPERSEDED',
            severity: 'BLOCKER',
            messageRu: 'Проверка авторских прав заменена новой (SUPERSEDED).',
          }),
        );
      }
      if (review.status === 'HUMAN_REJECTED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_REVIEW_REJECTED',
            severity: 'BLOCKER',
            messageRu: 'Проверка авторских прав отклонена (REJECTED).',
          }),
        );
      }
    }

    let profile: {
      id: string;
      status: string;
      isCurrent: boolean;
      publicationGate: string;
    } | null = null;
    if (version.rightsProfileId) {
      profile = await this.prisma.rightsProfile.findUnique({
        where: { id: version.rightsProfileId },
        select: {
          id: true,
          status: true,
          isCurrent: true,
          publicationGate: true,
        },
      });
    }

    // 6.7 Profile not found
    if (version.rightsProfileId && !profile) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'RIGHTS_PROFILE_NOT_FOUND',
          severity: 'BLOCKER',
          messageRu: 'Rights profile не найден в базе данных.',
        }),
      );
    }

    // 6.8 Profile not APPROVED
    if (profile && profile.status !== 'APPROVED') {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'RIGHTS_PROFILE_NOT_APPROVED',
          severity: 'BLOCKER',
          messageRu: 'Rights profile не утверждён. Текущий статус: ' + profile.status,
        }),
      );
    }

    // 6.9 Profile stale/superseded/rejected/archived
    if (profile) {
      if (profile.status === 'STALE') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_PROFILE_STALE',
            severity: 'BLOCKER',
            messageRu: 'Rights profile устарел (STALE).',
          }),
        );
      }
      if (profile.status === 'SUPERSEDED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_PROFILE_SUPERSEDED',
            severity: 'BLOCKER',
            messageRu: 'Rights profile заменён (SUPERSEDED).',
          }),
        );
      }
      if (profile.status === 'REJECTED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_PROFILE_REJECTED',
            severity: 'BLOCKER',
            messageRu: 'Rights profile отклонён (REJECTED).',
          }),
        );
      }
      if (profile.status === 'ARCHIVED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_PROFILE_ARCHIVED',
            severity: 'BLOCKER',
            messageRu: 'Rights profile архивирован (ARCHIVED).',
          }),
        );
      }
    }

    // 6.10 Profile not current
    if (profile && !profile.isCurrent) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'RIGHTS_PROFILE_NOT_CURRENT',
          severity: 'BLOCKER',
          messageRu: 'Rights profile не является текущим.',
        }),
      );
    }

    // 6.11 publicationGate = BLOCK
    if (profile && profile.publicationGate === 'BLOCK') {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'PUBLICATION_GATE_BLOCK',
          severity: 'BLOCKER',
          messageRu: 'Публикация запрещена по результатам проверки авторских прав.',
        }),
      );
    }

    // 6.12 Unresolved blocking actions
    if (profile) {
      const blockingActions = await this.prisma.rightsAction.findMany({
        where: {
          rightsProfileId: profile.id,
          isBlocking: true,
          status: { notIn: ['COMPLETED', 'WAIVED'] },
        },
        select: { id: true },
      });

      if (blockingActions.length > 0) {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'UNRESOLVED_BLOCKING_RIGHTS_ACTION',
            severity: 'BLOCKER',
            messageRu: 'Есть нерешённые блокирующие действия по авторским правам.',
            details: {
              actionIds: blockingActions.map((a) => a.id),
              count: blockingActions.length,
            },
          }),
        );
      }
    }

    // 6.13 Blocked countries require geo-block
    const blockedCountryCodes = version.rightsBlockedCountryCodes as string[] | null;
    if (blockedCountryCodes && blockedCountryCodes.length > 0) {
      if (!version.rightsGeoBlockConfigured) {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'BLOCKED_COUNTRIES_REQUIRE_GEO_BLOCK',
            severity: 'BLOCKER',
            messageRu:
              'Для версии есть заблокированные страны. До настройки geo-block публикация запрещена.',
          }),
        );
      } else {
        warnings.push(
          new PublicationGateReasonDto({
            code: 'BLOCKED_COUNTRIES_WITH_GEO_BLOCK',
            severity: 'WARNING',
            messageRu: 'Для версии есть заблокированные страны. Geo-block отмечен как настроенный.',
          }),
        );
      }
    }

    // 6.14 License required countries
    const licenseRequiredCountryCodes = version.rightsLicenseRequiredCountryCodes as
      | string[]
      | null;
    if (licenseRequiredCountryCodes && licenseRequiredCountryCodes.length > 0) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'LICENSE_REQUIRED',
          severity: 'BLOCKER',
          messageRu:
            'Для части рынков требуется лицензия. Публикация невозможна до реализации и привязки лицензии.',
        }),
      );
    }

    // 6.15 Pending countries
    const pendingCountryCodes = version.rightsPendingCountryCodes as string[] | null;
    if (pendingCountryCodes && pendingCountryCodes.length > 0) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'PENDING_TERRITORIES',
          severity: 'BLOCKER',
          messageRu: 'Есть территории с незавершённым решением по правам.',
        }),
      );
    }

    // 6.16 Snapshot mismatch
    if (version.rightsProfileId && book.currentRightsProfileId) {
      if (version.rightsProfileId !== book.currentRightsProfileId) {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_PROFILE_SNAPSHOT_OUTDATED',
            severity: 'BLOCKER',
            messageRu:
              'Версия ссылается на устаревший rights profile. Текущий profile книги отличается.',
          }),
        );
      }
    }

    if (version.approvedRightsReviewId && book.approvedRightsReviewId) {
      if (version.approvedRightsReviewId !== book.approvedRightsReviewId) {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_REVIEW_SNAPSHOT_OUTDATED',
            severity: 'BLOCKER',
            messageRu:
              'Версия ссылается на устаревшую проверку. Текущая утверждённая проверка книги отличается.',
          }),
        );
      }
    }

    // 6.17 Geo-block required but not configured
    if (version.rightsGeoBlockRequired && !version.rightsGeoBlockConfigured) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'GEO_BLOCK_NOT_CONFIGURED',
          severity: 'BLOCKER',
          messageRu:
            'Требуется настройка geo-block перед публикацией. Отметьте geo-block как настроенный через API.',
        }),
      );
    }

    // Phase 8: Content hash checks
    const contentHashBaseline: string | null = version.rightsContentHash;
    let contentHashCurrent: string | null = null;
    let contentHashMatches: boolean | null = null;

    if (!version.rightsContentHash) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'MISSING_RIGHTS_CONTENT_HASH',
          severity: 'BLOCKER',
          messageRu:
            'У версии нет сохранённого content hash для проверки актуальности прав. Требуется повторная проверка.',
        }),
      );
    }

    if (version.rightsRecheckRequired) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'RIGHTS_RECHECK_REQUIRED',
          severity: 'BLOCKER',
          messageRu:
            'После утверждения прав были изменены юридически значимые данные. Требуется повторная проверка.',
        }),
      );
    }

    // Always compute live hash for comparison
    try {
      const computation = await this.rightsContentHashService.computeVersionHash(versionId);
      contentHashCurrent = computation.hash;

      if (version.rightsContentHash && computation.hash !== version.rightsContentHash) {
        contentHashMatches = false;
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_CONTENT_HASH_CHANGED',
            severity: 'BLOCKER',
            messageRu:
              'Содержимое или rights snapshot версии изменились после утверждения проверки. Требуется повторная проверка.',
            details: {
              baselineHash: version.rightsContentHash,
              currentHash: computation.hash,
              algorithmVersion: computation.algorithmVersion,
            },
          }),
        );
      } else if (version.rightsContentHash) {
        contentHashMatches = true;
      }
    } catch {
      // If hash computation fails, don't block on this alone
    }

    return new PublicationGateResultDto({
      versionId: version.id,
      bookId: book.id,
      canPublish: blockingReasons.length === 0,
      checkedAt: new Date().toISOString(),
      rightsProfileId: version.rightsProfileId,
      approvedRightsReviewId: version.approvedRightsReviewId,
      rightsStatus: version.rightsStatus,
      blockingReasons,
      warnings,
      contentHashBaseline,
      contentHashCurrent,
      contentHashMatches,
      rightsRecheckRequired: version.rightsRecheckRequired,
    });
  }

  async assertVersionCanPublish(versionId: string): Promise<void> {
    const result = await this.checkVersionCanPublish(versionId);

    if (!result.canPublish) {
      throw new BadRequestException({
        message: 'Publication blocked by rights gate',
        code: 'RIGHTS_PUBLICATION_BLOCKED',
        canPublish: false,
        blockingReasons: result.blockingReasons,
        warnings: result.warnings,
      });
    }
  }
}
