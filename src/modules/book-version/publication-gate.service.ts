import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PublicationGateResultDto,
  PublicationGateReasonDto,
} from './dto/publication-gate-result.dto';
import {
  collectMissingVersionContentFields,
  DEFAULT_PUBLICATION_GATE_STAGE,
  isLawyerOverridableGateCode,
  isPreparationBlockingGateCode,
  LAWYER_OVERRIDE_APPLIED_CODE,
  PublicationGateStage,
} from './publication-gate.constants';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { UNASSESSED_LANGUAGE_STATUS } from '../rights-intake/rights-review-import.constants';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoBlockRuleDto, GeoBlockScope } from '../geo-block/dto/geo-block.dto';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { RightsClaimsService } from '../rights-claims/rights-claims.service';
import { RightsClearanceResolverService } from '../rights-clearance/rights-clearance-resolver.service';
import { RightsRecheckService } from '../rights-recheck/rights-recheck.service';
import { RightsLawyerReviewService } from '../rights-lawyer/rights-lawyer-review.service';

interface VersionWithGeoBlock {
  id: string;
  bookId: string;
  language: string | null;
  description: string | null;
  coverImageUrl: string | null;
  rightsProfileId: string | null;
  approvedRightsReviewId: string | null;
  rightsStatus: string | null;
  rightsGeoBlockRequired: boolean;
  rightsGeoBlockConfigured: boolean;
  rightsGeoBlockVerifiedAt: Date | null;
  rightsContentHash: string | null;
  rightsRecheckRequired: boolean;
  rightsLicenseAttributionTextRu: string | null;
  book: {
    id: string;
    currentRightsProfileId: string | null;
    approvedRightsReviewId: string | null;
  };
}

/** Scopes that close a market as a whole; every other scope closes only a part of the content. */
const FULL_BLOCK_SCOPES: GeoBlockScope[] = [
  GeoBlockScope.ENTIRE_BOOK,
  GeoBlockScope.LANGUAGE_EDITION,
];

@Injectable()
export class PublicationGateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rightsContentHashService: RightsContentHashService,
    private readonly geoBlockRuleService: GeoBlockRuleService,
    private readonly licenseCoverageService: RightsLicenseCoverageService,
    private readonly rightsClaimsService: RightsClaimsService,
    private readonly rightsRecheckService: RightsRecheckService,
    private readonly rightsLawyerReviewService: RightsLawyerReviewService,
    private readonly clearanceResolver: RightsClearanceResolverService,
  ) {}

  /**
   * `prisma generate` локально запрещён, поэтому модель читается тем же приёмом, что и в
   * `rights-profile.service.ts`: делегат берётся с клиента по имени.
   */
  private get editionRights() {
    return (this.prisma as unknown as Record<string, unknown>)['editionRights'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  }

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

    // WP-2: everything below that asks "what does the clearance say" asks the resolver, not the
    // write-once columns on the version. The columns stay the audit record of the publication.
    const clearance = await this.clearanceResolver.resolveForVersion(versionId);

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

    // 6.5-6.6 Review not usable. WP-A.3: the named statuses say the same thing as
    // `RIGHTS_REVIEW_NOT_APPROVED`, only precisely — emitting both turned one cause into two
    // blockers and made an ordinary stale clearance look like a pile of legal problems.
    // `RIGHTS_REVIEW_NOT_APPROVED` stays as the else branch for every other status (ADR-008:
    // codes are never removed).
    if (review) {
      if (review.status === 'STALE') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_REVIEW_STALE',
            severity: 'BLOCKER',
            messageRu: 'Проверка авторских прав устарела (STALE). Требуется повторная проверка.',
          }),
        );
      } else if (review.status === 'SUPERSEDED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_REVIEW_SUPERSEDED',
            severity: 'BLOCKER',
            messageRu: 'Проверка авторских прав заменена новой (SUPERSEDED).',
          }),
        );
      } else if (review.status === 'HUMAN_REJECTED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_REVIEW_REJECTED',
            severity: 'BLOCKER',
            messageRu: 'Проверка авторских прав отклонена (REJECTED).',
          }),
        );
      } else if (review.status !== 'HUMAN_APPROVED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_REVIEW_NOT_APPROVED',
            severity: 'BLOCKER',
            messageRu: 'Проверка авторских прав не утверждена. Текущий статус: ' + review.status,
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

    // 6.8-6.9 Profile not usable. WP-A.3: same rule as for the review — the precise status wins,
    // `RIGHTS_PROFILE_NOT_APPROVED` covers everything else.
    if (profile) {
      if (profile.status === 'STALE') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_PROFILE_STALE',
            severity: 'BLOCKER',
            messageRu: 'Rights profile устарел (STALE).',
          }),
        );
      } else if (profile.status === 'SUPERSEDED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_PROFILE_SUPERSEDED',
            severity: 'BLOCKER',
            messageRu: 'Rights profile заменён (SUPERSEDED).',
          }),
        );
      } else if (profile.status === 'REJECTED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_PROFILE_REJECTED',
            severity: 'BLOCKER',
            messageRu: 'Rights profile отклонён (REJECTED).',
          }),
        );
      } else if (profile.status === 'ARCHIVED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_PROFILE_ARCHIVED',
            severity: 'BLOCKER',
            messageRu: 'Rights profile архивирован (ARCHIVED).',
          }),
        );
      } else if (profile.status !== 'APPROVED') {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'RIGHTS_PROFILE_NOT_APPROVED',
            severity: 'BLOCKER',
            messageRu: 'Rights profile не утверждён. Текущий статус: ' + profile.status,
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
    const blockedCountryCodes = clearance.blockedCountryCodes;
    if (blockedCountryCodes.length > 0) {
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

    // 6.14 License coverage (Phase 15). A country with LICENSE_REQUIRED no longer blocks
    // publication on its own — it blocks only when no valid license covers it.
    const licenseCoverage = await this.licenseCoverageService.evaluateVersionCoverage(versionId);

    for (const blocker of licenseCoverage.blockers) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: blocker.code,
          severity: 'BLOCKER',
          messageRu: blocker.messageRu,
          details: { licenseId: blocker.licenseId, countryCode: blocker.countryCode },
        }),
      );
    }

    for (const warning of licenseCoverage.warnings) {
      // Attribution is only worth flagging when the version has no attribution text yet.
      if (
        warning.code === 'LICENSE_ATTRIBUTION_REQUIRED' &&
        version.rightsLicenseAttributionTextRu
      ) {
        continue;
      }
      warnings.push(
        new PublicationGateReasonDto({
          code: warning.code,
          severity: 'WARNING',
          messageRu: warning.messageRu,
          details: { licenseId: warning.licenseId, countryCode: warning.countryCode },
        }),
      );
    }

    // 6.15 Pending countries. WP-C.3: сужение области, а не отмена правила — `PENDING_TERRITORIES`
    // остаётся кодом ядра и по-прежнему блокирует, но считается только по целевым странам версии.
    // Страна вне плана публикации запрещала релиз на целевых рынках, хотя публиковаться там никто
    // не собирался. Компенсация — отдельный код-предупреждение: непроверенный рынок остаётся
    // видимым (ADR-008: коды добавляются, не переименовываются). Неизвестный план публикации
    // (нет интейка или список пуст) означает прежнее поведение: блокирует любой пендинг.
    const targetCountryCodes = await this.loadTargetCountryCodes(clearance.rightsIntakeId);
    const pendingCountryCodes = clearance.pendingCountryCodes;
    const pendingInTargetMarkets =
      targetCountryCodes.length === 0
        ? pendingCountryCodes
        : pendingCountryCodes.filter((countryCode) =>
            targetCountryCodes.includes(countryCode.toUpperCase()),
          );
    const pendingOutsideTargetMarkets =
      targetCountryCodes.length === 0
        ? []
        : pendingCountryCodes.filter(
            (countryCode) => !targetCountryCodes.includes(countryCode.toUpperCase()),
          );

    if (pendingInTargetMarkets.length > 0) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'PENDING_TERRITORIES',
          severity: 'BLOCKER',
          messageRu: 'Есть территории с незавершённым решением по правам.',
          // WP-A.2: without the list the editor could not tell which market to finish.
          details: { countryCodes: pendingInTargetMarkets },
        }),
      );
    }

    if (pendingOutsideTargetMarkets.length > 0) {
      warnings.push(
        new PublicationGateReasonDto({
          code: 'PENDING_TERRITORIES_OUTSIDE_TARGET_MARKETS',
          severity: 'WARNING',
          messageRu:
            'Есть территории с незавершённым решением по правам вне целевых рынков версии. ' +
            'Публикацию это не блокирует.',
          details: { countryCodes: pendingOutsideTargetMarkets },
        }),
      );
    }

    // 6.16 Snapshot mismatch. Approving a new review writes to the intake and the profile, never
    // to the book, so comparing the version against `Book.*` could not detect the drift these two
    // codes were written for (R5-03) — the comparison is against the resolved clearance instead.
    if (clearance.profileOutdated) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'RIGHTS_PROFILE_SNAPSHOT_OUTDATED',
          severity: 'BLOCKER',
          messageRu:
            'Версия ссылается на устаревший rights profile. Действующий профиль клиренса отличается.',
          details: {
            versionProfileId: clearance.snapshotProfileId,
            effectiveProfileId: clearance.effectiveProfileId,
          },
        }),
      );
    }

    if (clearance.reviewOutdated) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'RIGHTS_REVIEW_SNAPSHOT_OUTDATED',
          severity: 'BLOCKER',
          messageRu:
            'Версия ссылается на устаревшую проверку. Действующая утверждённая проверка отличается.',
          details: {
            versionReviewId: clearance.snapshotReviewId,
            effectiveReviewId: clearance.effectiveReviewId,
          },
        }),
      );
    }

    // 6.17 Geo-block chain. WP-A.1: the flag alone used to demand configuration, runtime rules and
    // verification even when the clearance closed no market — and a rule cannot be created for a
    // country nobody blocked, so the editor was stuck in a loop with no exit. The chain is now
    // demanded only where there is something to close: a blocked market or one that needs a
    // license. The flag itself is not ignored — when it points at nothing, the gate says so.
    const geoRestrictedCountryCodes = [
      ...new Set(
        [
          ...blockedCountryCodes,
          ...clearance.licenseRequiredCountryCodes,
          ...licenseCoverage.requiredCountryCodes,
        ].map((countryCode) => countryCode.toUpperCase()),
      ),
    ].sort();
    const geoBlockChainRequired =
      version.rightsGeoBlockRequired && geoRestrictedCountryCodes.length > 0;

    if (version.rightsGeoBlockRequired && geoRestrictedCountryCodes.length === 0) {
      warnings.push(
        new PublicationGateReasonDto({
          code: 'GEO_BLOCK_REQUIRED_WITHOUT_RESTRICTED_COUNTRIES',
          severity: 'WARNING',
          messageRu:
            'Версия помечена как требующая geo-block, но ни одна страна не закрыта и не требует лицензии. ' +
            'Правила geo-block не требуются.',
        }),
      );
    }

    if (geoBlockChainRequired && !version.rightsGeoBlockConfigured) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'GEO_BLOCK_NOT_CONFIGURED',
          severity: 'BLOCKER',
          messageRu:
            'Требуется настройка geo-block перед публикацией. Отметьте geo-block как настроенный через API.',
        }),
      );
    }

    if (geoBlockChainRequired) {
      const activeRules = await this.geoBlockRuleService.getActiveRulesForVersion(versionId);
      const activeCountryCodes = new Set(activeRules.map((rule) => rule.countryCode.toUpperCase()));
      const missingCountryCodes = blockedCountryCodes.filter(
        (countryCode) => !activeCountryCodes.has(countryCode.toUpperCase()),
      );

      // WP-3.1: counting rules per country accepted any scope as coverage, so a country the
      // clearance closed outright could be covered by a `TEXT_READER` rule alone — the audio
      // edition of the same forbidden text stayed reachable from it (R5-02, R6-01). A market
      // closed as a whole needs a rule that closes it as a whole.
      const insufficientScopesByCountry = this.collectInsufficientScopes(
        blockedCountryCodes,
        activeRules,
      );
      const insufficientCountryCodes = Object.keys(insufficientScopesByCountry).sort();

      if (insufficientCountryCodes.length > 0) {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'GEO_BLOCK_SCOPE_INSUFFICIENT',
            severity: 'BLOCKER',
            messageRu:
              'Страна закрыта целиком, но правило geo-block закрывает только часть контента. ' +
              'Требуется правило со скоупом ENTIRE_BOOK или LANGUAGE_EDITION.',
            details: {
              countryCodes: insufficientCountryCodes,
              scopesByCountry: insufficientScopesByCountry,
              requiredScopes: [...FULL_BLOCK_SCOPES],
            },
          }),
        );
      }

      if (activeRules.length === 0 || missingCountryCodes.length > 0) {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'GEO_BLOCK_RULES_MISSING',
            severity: 'BLOCKER',
            messageRu:
              'Geo-block обязателен, но runtime-правила ещё не сгенерированы из territory decisions.',
            details: {
              missingCountryCodes,
            },
          }),
        );
      } else if (activeRules.some((rule) => rule.verifiedAt === null)) {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'GEO_BLOCK_RULES_NOT_VERIFIED',
            severity: 'BLOCKER',
            messageRu: 'Сгенерированные runtime-правила geo-block ещё не проверены.',
          }),
        );
      }

      if (!version.rightsGeoBlockVerifiedAt) {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'GEO_BLOCK_VERIFICATION_MISSING',
            severity: 'BLOCKER',
            messageRu: 'У версии отсутствует подтверждение проверки runtime geo-block.',
          }),
        );
      }
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
    } catch (e) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'RIGHTS_CONTENT_HASH_CHECK_FAILED',
          severity: 'BLOCKER',
          messageRu: 'Ошибка при вычислении content hash. Невозможно проверить актуальность прав.',
          details: {
            error: e instanceof Error ? e.message : 'Unknown error',
          },
        }),
      );
    }

    // 6.18 Rights claims (Phase 16)
    const claimEvaluation = await this.rightsClaimsService.evaluateVersionClaims(versionId);

    for (const blocker of claimEvaluation.blockers) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: blocker.code,
          severity: 'BLOCKER',
          messageRu: blocker.messageRu,
          details: {
            ...(blocker.details ?? {}),
            claimId: blocker.claimId,
            claimNumber: blocker.claimNumber,
          },
        }),
      );
    }

    for (const warning of claimEvaluation.warnings) {
      warnings.push(
        new PublicationGateReasonDto({
          code: warning.code,
          severity: 'WARNING',
          messageRu: warning.messageRu,
          details: {
            ...(warning.details ?? {}),
            claimId: warning.claimId,
            claimNumber: warning.claimNumber,
          },
        }),
      );
    }

    // 6.19 Automatic recheck (Phase 18)
    const recheckEvaluation = await this.rightsRecheckService.evaluateVersionRecheck(versionId);

    for (const blocker of recheckEvaluation.blockers) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: blocker.code,
          severity: 'BLOCKER',
          messageRu: blocker.messageRu,
          details: { ...(blocker.details ?? {}), taskId: blocker.taskId },
        }),
      );
    }

    for (const warning of recheckEvaluation.warnings) {
      warnings.push(
        new PublicationGateReasonDto({
          code: warning.code,
          severity: 'WARNING',
          messageRu: warning.messageRu,
          details: { ...(warning.details ?? {}), taskId: warning.taskId },
        }),
      );
    }

    // 6.20 Lawyer workflow (Phase 19)
    const lawyerEvaluation =
      await this.rightsLawyerReviewService.evaluateVersionLawyerReview(versionId);

    for (const blocker of lawyerEvaluation.blockers) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: blocker.code,
          severity: 'BLOCKER',
          messageRu: blocker.messageRu,
          details: { ...(blocker.details ?? {}), lawyerReviewId: blocker.lawyerReviewId },
        }),
      );
    }

    for (const warning of lawyerEvaluation.warnings) {
      warnings.push(
        new PublicationGateReasonDto({
          code: warning.code,
          severity: 'WARNING',
          messageRu: warning.messageRu,
          details: { ...(warning.details ?? {}), lawyerReviewId: warning.lawyerReviewId },
        }),
      );
    }

    // 6.21 Language rights coverage. WP-G.5 понизил `MISSING_LANGUAGE_ASSESSMENT` до
    // предупреждения, а компенсацией объявил запись `EditionRights` со статусом `NOT_TARGETED`
    // на непокрытый целевой язык — но эту заглушку не читал ни один гейт, и версия на
    // неоценённом языке уходила в публикацию. ADR-014 требует, чтобы клиренс покрывал целевые
    // языки целиком, поэтому смягчение валидации держится на блокере здесь: публикуется только
    // язык, по которому есть реальная правовая оценка. Код новый и добавлен аддитивно (ADR-008),
    // существующие коды не тронуты.
    const versionLanguage =
      typeof version.language === 'string' ? version.language.trim().toLowerCase() : '';
    if (version.rightsProfileId && versionLanguage) {
      const assessedLanguageCodes = await this.loadAssessedLanguageCodes(version.rightsProfileId);

      if (!assessedLanguageCodes.includes(versionLanguage)) {
        blockingReasons.push(
          new PublicationGateReasonDto({
            code: 'MISSING_LANGUAGE_RIGHTS_ASSESSMENT',
            severity: 'BLOCKER',
            messageRu:
              'По языку версии нет правовой оценки в клиренсе. Требуется отчёт с оценкой этого языка.',
            details: { languageCode: versionLanguage, assessedLanguageCodes },
          }),
        );
      }
    }

    // 6.22 Наполненность версии. WP-L.1 убрал описание и обложку из обязательных полей создания
    // книги из клиренса: это контентная работа, и делается она в разделе «Книги», а не в форме
    // прав. Компенсация — здесь: незаполненная оболочка наружу не уходит. Проверка не про права,
    // но именно этот гейт стоит перед публикацией, и код добавлен аддитивно (ADR-008). Подготовку
    // он не запрещает намеренно — наполнять версию и надо после создания.
    const missingContentFields = collectMissingVersionContentFields(version);
    if (missingContentFields.length > 0) {
      blockingReasons.push(
        new PublicationGateReasonDto({
          code: 'VERSION_CONTENT_INCOMPLETE',
          severity: 'BLOCKER',
          messageRu:
            'Версия не наполнена: нет описания или обложки. Заполните их в разделе «Книги» — публикация пустой карточки запрещена.',
          details: { missingFields: missingContentFields },
        }),
      );
    }

    // WP-M: действующее заключение юриста снимает блокеры, о которых оно высказывается.
    //
    // Условие двойное. Во-первых, заключение положительное и в силе — это считает сам юридический
    // модуль (`lawyerApproved`), а не липкий снимок на профиле. Во-вторых, собственный гейт юриста
    // чист: пока висит невыполненное блокирующее условие или просроченная проверка, «юрист
    // одобрил» ещё не наступило, и снимать чужие блокеры не с чего.
    const lawyerOverrideActive =
      lawyerEvaluation.lawyerApproved && lawyerEvaluation.blockers.length === 0;

    const overriddenReasons = lawyerOverrideActive
      ? blockingReasons.filter((reason) => isLawyerOverridableGateCode(reason.code))
      : [];

    if (overriddenReasons.length > 0) {
      // Снятые причины не исчезают, а переезжают в предупреждения: редактор обязан видеть, что
      // именно перекрыто решением юриста, а аудит — на каком основании вышла публикация.
      for (const reason of overriddenReasons) {
        blockingReasons.splice(blockingReasons.indexOf(reason), 1);
        warnings.push(
          new PublicationGateReasonDto({
            code: reason.code,
            severity: 'WARNING',
            messageRu: `${reason.messageRu} Снято положительным заключением юриста.`,
            details: { ...(reason.details ?? {}), overriddenByLawyer: true },
          }),
        );
      }

      warnings.push(
        new PublicationGateReasonDto({
          code: LAWYER_OVERRIDE_APPLIED_CODE,
          severity: 'WARNING',
          messageRu:
            'Часть требований снята действующим заключением юриста — публикация разрешена под его ответственность.',
          details: {
            overriddenCodes: overriddenReasons.map((reason) => reason.code),
            lawyerOpinionValidUntil: lawyerEvaluation.lawyerOpinionValidUntil,
            lawyerReviewIds: lawyerEvaluation.reviewIds,
          },
        }),
      );
    }

    // WP-H: тот же список блокеров отвечает на второй вопрос — «можно ли готовить материал».
    // Публикационный вердикт считается по полному списку и не ослаблен; подготовку запрещает
    // только белый список кодов, при которых с произведением нельзя работать вообще.
    const preparationBlockingReasons = blockingReasons.filter((reason) =>
      isPreparationBlockingGateCode(reason.code),
    );

    return new PublicationGateResultDto({
      versionId: version.id,
      bookId: book.id,
      canPublish: blockingReasons.length === 0,
      canPrepare: preparationBlockingReasons.length === 0,
      preparationBlockingReasons,
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
      licenseCoverageStatus: licenseCoverage.status,
      licenseRequiredCountryCodes: licenseCoverage.requiredCountryCodes,
      licenseCoveredCountryCodes: licenseCoverage.coveredCountryCodes,
      licenseUncoveredCountryCodes: licenseCoverage.uncoveredCountryCodes,
      licenseIds: licenseCoverage.licenseIds,
      activeClaimsCount: claimEvaluation.activeClaimsCount,
      blockingClaimsCount: claimEvaluation.blockingClaimsCount,
      criticalClaimsCount: claimEvaluation.criticalClaimsCount,
      overdueClaimsCount: claimEvaluation.overdueClaimsCount,
      claimBlockedCountryCodes: claimEvaluation.claimBlockedCountryCodes,
      hasWorldwideClaimBlock: claimEvaluation.hasWorldwideBlock,
      worstClaimSeverity: claimEvaluation.worstSeverity,
      claimIds: claimEvaluation.claimIds,
      openRecheckTasksCount: recheckEvaluation.openTasksCount,
      overdueRecheckTasksCount: recheckEvaluation.overdueTasksCount,
      blockingRecheckTasksCount: recheckEvaluation.blockingTasksCount,
      nextRecheckDueAt: recheckEvaluation.nextRecheckDueAt,
      recheckTaskIds: recheckEvaluation.taskIds,
      lawyerReviewRequired: lawyerEvaluation.lawyerReviewRequired,
      lawyerApproved: lawyerEvaluation.lawyerApproved,
      openLawyerReviewsCount: lawyerEvaluation.openReviewsCount,
      pendingLawyerConditionsCount: lawyerEvaluation.pendingConditionsCount,
      riskLevel: lawyerEvaluation.riskLevel,
      lawyerOpinionValidUntil: lawyerEvaluation.lawyerOpinionValidUntil,
      lawyerReviewIds: lawyerEvaluation.reviewIds,
    });
  }

  /**
   * For every country blocked outright: the scopes of its rules, when none of them closes the
   * whole edition. Countries without any rule are left to `GEO_BLOCK_RULES_MISSING` — "no rule"
   * and "rule too narrow" are different problems and need different fixes from the editor.
   */
  private collectInsufficientScopes(
    blockedCountryCodes: string[],
    activeRules: GeoBlockRuleDto[],
  ): Record<string, string[]> {
    const scopesByCountry: Record<string, string[]> = {};

    for (const countryCode of blockedCountryCodes) {
      const normalizedCountryCode = countryCode.toUpperCase();
      const countryRules = activeRules.filter(
        (rule) => rule.countryCode.toUpperCase() === normalizedCountryCode,
      );
      if (countryRules.length === 0) continue;
      if (countryRules.some((rule) => FULL_BLOCK_SCOPES.includes(rule.scope))) continue;

      scopesByCountry[normalizedCountryCode] = [...new Set(countryRules.map((rule) => rule.scope))];
    }

    return scopesByCountry;
  }

  /**
   * Языки, по которым клиренс профиля несёт реальную оценку агента. `NOT_TARGETED` — заглушка
   * материализации на целевой язык без оценки (WP-G.5), покрытием она не является.
   */
  private async loadAssessedLanguageCodes(rightsProfileId: string): Promise<string[]> {
    const records = await this.editionRights.findMany({
      where: { sourceEdition: { rightsProfileId } },
      select: { languageCode: true, status: true },
    });

    return records
      .filter((record) => record['status'] !== UNASSESSED_LANGUAGE_STATUS)
      .map((record) =>
        typeof record['languageCode'] === 'string'
          ? record['languageCode'].trim().toLowerCase()
          : '',
      )
      .filter((languageCode) => languageCode !== '');
  }

  /**
   * WP-C.3: план публикации версии — целевые страны её интейка. Пустой результат означает
   * «план неизвестен», и правило работает в прежнем, более строгом виде.
   */
  private async loadTargetCountryCodes(rightsIntakeId: string | null): Promise<string[]> {
    if (!rightsIntakeId) return [];

    const intake = (await this.prisma.rightsIntake.findUnique({
      where: { id: rightsIntakeId },
      select: { targetCountryCodes: true },
    })) as { targetCountryCodes?: unknown } | null;

    const rawCountryCodes = intake?.targetCountryCodes;
    if (!Array.isArray(rawCountryCodes)) return [];

    return rawCountryCodes
      .filter((countryCode): countryCode is string => typeof countryCode === 'string')
      .map((countryCode) => countryCode.toUpperCase());
  }

  /**
   * WP-H: стадия — параметр охраны, а не фильтр ответа. `checkVersionCanPublish` всегда отдаёт
   * оба вердикта целиком, поэтому прочитать `canPublish: true` у запроса стадии подготовки
   * невозможно; выбирать, какой вердикт enforce'ится, приходится здесь и явно.
   */
  async assertVersionCanPublish(
    versionId: string,
    stage: PublicationGateStage = DEFAULT_PUBLICATION_GATE_STAGE,
  ): Promise<void> {
    const result = await this.checkVersionCanPublish(versionId);

    if (stage === 'PREPARATION') {
      if (!result.canPrepare) {
        throw new BadRequestException({
          message: 'Preparation blocked by rights gate',
          code: 'RIGHTS_PREPARATION_BLOCKED',
          canPublish: result.canPublish,
          canPrepare: false,
          blockingReasons: result.preparationBlockingReasons,
          warnings: result.warnings,
        });
      }
      return;
    }

    if (!result.canPublish) {
      throw new BadRequestException({
        message: 'Publication blocked by rights gate',
        code: 'RIGHTS_PUBLICATION_BLOCKED',
        canPublish: false,
        canPrepare: result.canPrepare,
        blockingReasons: result.blockingReasons,
        warnings: result.warnings,
      });
    }
  }
}
