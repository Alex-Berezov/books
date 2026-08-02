import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ComponentTerritoryAggregationService,
  type ComponentTerritoryAccessPolicy,
  type ComponentTerritoryAggregationComponent,
  type ComponentTerritoryAssessmentInput,
  type ComponentTerritoryConfidence,
  type ComponentTerritoryFinalStatus,
  type ExistingTerritoryDecisionInput,
} from './component-territory-aggregation.service';
import {
  AGENT_SUGGESTABLE_ACTION_STATUSES,
  areComponentRemovalsConfirmed,
  isComponentMarkedForRemoval,
} from './rights-action.constants';
import {
  TERRITORY_DECISION_DEFAULT_REASON_RU,
  UNASSESSED_LANGUAGE_STATUS,
  normalizeTerritoryFinalStatus,
} from './rights-review-import.constants';

import { PersonResolverService } from '../persons/person-resolver.service';
import { ContributorRole } from '../persons/person-interface';
import {
  RightsNotificationSeverity,
  RightsNotificationType,
} from '../rights-agent/rights-agent-interface';
import { RightsNotificationsService } from '../rights-agent/rights-notifications.service';
import { RightsConfidence, Prisma } from '@prisma/client';

type NormalizedContributorConfidence = RightsConfidence | null;

/** Prisma signals a unique-constraint violation with error code `P2002`. */
const isUniqueConstraintViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Сбой из-за формы отчёта, а не из-за инфраструктуры: отсутствующее обязательное поле,
 * неизвестное значение enum'а, нарушенный констрейнт. Такой отчёт не разложится никогда,
 * сколько ни повторяй запрос, поэтому ответ — 422, а не 500 (WP-6.3).
 */
const isReportShapeError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientValidationError ||
  error instanceof Prisma.PrismaClientKnownRequestError;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * WP-8.3: контрольная сумма файла источника из отчёта агента. Значение попадает в content
 * hash клиренса, поэтому мусор в нём хуже пустоты — «изменение» строки закрывало бы гейт
 * публикации без причины. Не похоже на sha256 → считаем, что суммы нет.
 */
const normalizeSha256 = (value: unknown): string | null =>
  typeof value === 'string' && SHA256_PATTERN.test(value.trim())
    ? value.trim().toLowerCase()
    : null;

interface NormalizedContributorInput {
  role: ContributorRole;
  roleOtherRu: string | null;
  displayName: string;
  canonicalName: string;
  creditedName: string | null;
  creditedLanguage: string | null;
  birthYear: number | null;
  deathYear: number | null;
  nationalityCountryCode: string | null;
  wikidataId: string | null;
  viafId: string | null;
  isni: string | null;
  gutenbergAgentId: string | null;
  publicDomainFromYear: number | null;
  sourceEvidenceIds: string[] | null;
  confidence: NormalizedContributorConfidence;
  notesRu: string | null;
}

interface MaterializedContributor {
  id: string;
  personId: string | null;
  rightsComponentId: string | null;
  input: NormalizedContributorInput;
}

const CONTRIBUTOR_ROLE_VALUES: ContributorRole[] = Object.values(ContributorRole);

const RIGHTS_CONFIDENCE_VALUES: string[] = ['HIGH', 'MEDIUM', 'LOW'];

const IDENTITY_CONFIDENCE_TO_RIGHTS_CONFIDENCE: Record<string, RightsConfidence | null> = {
  CONFIRMED: 'HIGH' as RightsConfidence,
  PROBABLE: 'MEDIUM' as RightsConfidence,
  UNCERTAIN: 'LOW' as RightsConfidence,
  UNKNOWN: null,
};

/** Кто запустил материализацию — от этого зависит только адресация уведомления. */
export interface MaterializationContext {
  /** Идентификатор сабмишена агентского канала (фаза 17); у ручного импорта отсутствует. */
  agentSubmissionId?: string | null;
}

@Injectable()
export class RightsMaterializationService {
  private readonly logger = new Logger(RightsMaterializationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly componentTerritoryAggregationService: ComponentTerritoryAggregationService,
    private readonly personResolverService: PersonResolverService,
    private readonly notifications: RightsNotificationsService,
  ) {}

  private get rp() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsProfile'] as {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  }

  private get rr() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsReview'] as {
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get se() {
    return (this.prisma as unknown as Record<string, unknown>)['sourceEdition'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get er() {
    return (this.prisma as unknown as Record<string, unknown>)['editionRights'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get rc() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsComponent'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get td() {
    return (this.prisma as unknown as Record<string, unknown>)['territoryDecision'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get re() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsEvidence'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get ra() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsAction'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get ri() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsReviewImport'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  parseDateOrNull(value: unknown): Date | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    }
    if (value instanceof Date) return value;
    return null;
  }

  /**
   * WP-6.3 (R9-02): обработка сбоя живёт здесь, в общем сервисе, а не в агентском канале.
   * Раньше `try/catch` был только в фазе 17: агент получал уведомление и диагностику,
   * а редактор на `POST /admin/rights/review-imports/:id/materialize` — голый 500 без тела
   * и без следа, то есть автоматический путь деградировал аккуратнее интерактивного.
   */
  async materializeFromImport(importId: string, context: MaterializationContext = {}) {
    try {
      return await this.runMaterialization(importId);
    } catch (error) {
      await this.reportMaterializationFailure(error, importId, context);
      throw this.toDiagnosticError(error, importId);
    }
  }

  /**
   * Уведомление пишется одинаково для обоих каналов; агентский добавляет к нему
   * `agentSubmissionId`. Ошибка самого уведомления не должна подменять исходную —
   * поэтому она только логируется.
   */
  private async reportMaterializationFailure(
    error: unknown,
    importId: string,
    context: MaterializationContext,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Materialization failed for import ${importId}: ${message}`);

    try {
      const importRecord = await this.ri.findUnique({ where: { id: importId } });
      if (!importRecord) return;

      const intakeId = importRecord['rightsIntakeId'] as string;
      const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
      const title = intake?.candidateTitle ?? intakeId;

      await this.notifications.create({
        type: RightsNotificationType.AGENT_REPORT_MATERIALIZATION_FAILED,
        severity: RightsNotificationSeverity.ERROR,
        titleRu: 'Не удалось построить профиль прав',
        messageRu: `Отчёт по интейку «${title}» импортирован, но материализация упала: ${message}.`,
        rightsIntakeId: intakeId,
        agentSubmissionId: context.agentSubmissionId ?? null,
        rightsReviewImportId: importId,
      });
    } catch (notificationError) {
      const notificationMessage =
        notificationError instanceof Error ? notificationError.message : String(notificationError);
      this.logger.error(
        `Failed to record a materialization failure notification for import ${importId}: ${notificationMessage}`,
      );
    }
  }

  private toDiagnosticError(error: unknown, importId: string): unknown {
    if (error instanceof HttpException) return error;
    if (!isReportShapeError(error)) return error;

    const message = error instanceof Error ? error.message : String(error);
    return new UnprocessableEntityException({
      code: 'REPORT_NOT_MATERIALIZABLE',
      message:
        'The report passed validation but cannot be materialized into the rights model. ' +
        'Import a corrected report.',
      messageRu:
        'Отчёт прошёл валидацию, но не раскладывается в модель прав. Нужен исправленный отчёт.',
      importId,
      reason: message,
    });
  }

  private async runMaterialization(importId: string) {
    const importRecord = await this.ri.findUnique({ where: { id: importId } });
    if (!importRecord) {
      throw new NotFoundException(`RightsReviewImport with ID '${importId}' not found`);
    }

    if (importRecord['importStatus'] !== 'VALIDATED') {
      throw new BadRequestException(
        `Cannot materialize: import status is '${String(importRecord['importStatus'])}', expected 'VALIDATED'`,
      );
    }

    if (importRecord['isCurrent'] !== true) {
      throw new BadRequestException('Cannot materialize: import is not current');
    }

    const intakeId = importRecord['rightsIntakeId'] as string;

    const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw new NotFoundException(`Rights intake with ID '${intakeId}' not found`);
    }

    if (intake.workflowStatus !== 'REVIEW_IMPORTED') {
      throw new BadRequestException(
        `Cannot materialize: intake status is '${intake.workflowStatus}', expected 'REVIEW_IMPORTED'`,
      );
    }

    const existingReview = (await (this.prisma as unknown as Record<string, unknown>)[
      'rightsReview'
    ]) as {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
    const existing = await existingReview.findFirst({
      where: { rightsReviewImportId: importId },
      include: { rightsProfile: true },
    });

    if (existing) {
      const existingProfile = existing['rightsProfile'] as Record<string, unknown>;
      if (existingProfile) {
        return existingProfile;
      }
    }

    const reportJson = importRecord['reportJson'] as Record<string, unknown>;

    if (reportJson['schemaVersion'] !== '1.0') {
      throw new BadRequestException(
        `Cannot materialize: reportJson.schemaVersion is '${
          reportJson['schemaVersion'] as string
        }', expected '1.0'`,
      );
    }

    if (reportJson['intakeId'] !== intakeId) {
      throw new BadRequestException(
        'Cannot materialize: reportJson.intakeId does not match the import rightsIntakeId',
      );
    }

    const intakeRecord = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });

    const result = await this.prisma.$transaction(async (tx) => {
      const t = tx as unknown as Record<string, unknown>;
      const rpTx = t['rightsProfile'] as {
        updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
        findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
      };
      const rrTx = t['rightsReview'] as {
        updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
        findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      await rpTx.updateMany({
        where: { rightsIntakeId: intakeId, isCurrent: true },
        data: {
          isCurrent: false,
          status: 'SUPERSEDED',
          supersededAt: new Date(),
        },
      });

      const supersededProfiles = await rpTx.findMany({
        where: { rightsIntakeId: intakeId, isCurrent: false, status: 'SUPERSEDED' },
        select: { id: true },
      });

      if (supersededProfiles.length > 0) {
        const supersededIds = supersededProfiles.map(
          (p: Record<string, unknown>) => p['id'],
        ) as string[];
        await rrTx.updateMany({
          where: { rightsProfileId: { in: supersededIds } },
          data: { status: 'SUPERSEDED' },
        });
      }

      const sourceAssessment = reportJson['sourceAssessment'] as
        | Record<string, unknown>
        | undefined;
      const componentAssessments = reportJson['componentAssessments'] as
        | Array<Record<string, unknown>>
        | undefined;
      const territoryDecisions = reportJson['territoryDecisions'] as
        | Array<Record<string, unknown>>
        | undefined;
      const languageAssessments = reportJson['languageAssessments'] as
        | Array<Record<string, unknown>>
        | undefined;
      const evidence = reportJson['evidence'] as Array<Record<string, unknown>> | undefined;
      const requiredActions = reportJson['requiredActions'] as
        | Array<Record<string, unknown>>
        | undefined;

      const seTx = t['sourceEdition'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const erTx = t['editionRights'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const rcTx = t['rightsComponent'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const tdTx = t['territoryDecision'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const ctaTx = t['componentTerritoryAssessment'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const reTx = t['rightsEvidence'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const raTx = t['rightsAction'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      const importedByUserId = (importRecord['importedByUserId'] as string | null) ?? null;

      const profile = await rpTx.create({
        data: {
          rightsIntakeId: intakeId,
          currentReviewImportId: importId,
          status: 'HUMAN_REVIEW_REQUIRED',
          isCurrent: true,
          overallStatus: reportJson['overallStatus'] as string,
          publicationGate: reportJson['publicationGate'] as string,
          confidence: reportJson['confidence'] as string,
          summaryRu: reportJson['summaryRu'] as string,
          conclusionRu: reportJson['conclusionRu'] as string,
          reasoningRu: (reportJson['reasoningRu'] as string) ?? null,
          nextReviewAt: this.parseDateOrNull(reportJson['nextReviewAt']),
        },
      });

      const newReview = await rrTx.create({
        data: {
          rightsProfileId: profile['id'] as string,
          rightsReviewImportId: importId,
          status: 'HUMAN_REVIEW_REQUIRED',
          schemaVersion: reportJson['schemaVersion'] as string,
          // WP-9.1 (essence §15): проверка — акт, и она несёт сведения «под каким заданием
          // и чем проверяли» сама, тем же приёмом, что и `schemaVersion`. Импорт может уйти
          // в `SUPERSEDED`, а проверка обязана оставаться самодостаточной.
          promptVersion: (importRecord['promptVersion'] as string | null) ?? null,
          agentModel: (importRecord['agentModel'] as string | null) ?? null,
          overallStatus: reportJson['overallStatus'] as string,
          publicationGate: reportJson['publicationGate'] as string,
          confidence: reportJson['confidence'] as string,
          summaryRu: reportJson['summaryRu'] as string,
          conclusionRu: reportJson['conclusionRu'] as string,
          reasoningRu: (reportJson['reasoningRu'] as string) ?? null,
          nextReviewAt: this.parseDateOrNull(reportJson['nextReviewAt']),
        },
      });

      // Phase 18: link the new review to the previous one (history chain).
      // Deliberately inline rather than via RightsReviewChainService: RightsIntakeModule
      // cannot import RightsRecheckModule without creating a module cycle.
      const newReviewId = newReview['id'] as string;
      const previousReview = await rrTx.findFirst({
        where: { rightsProfile: { rightsIntakeId: intakeId }, id: { not: newReviewId } },
        orderBy: { createdAt: 'desc' },
      });

      const chainData = previousReview
        ? {
            previousReviewId: previousReview['id'] as string,
            chainRootReviewId:
              (previousReview['chainRootReviewId'] as string | null) ??
              (previousReview['id'] as string),
            revisionNumber: ((previousReview['revisionNumber'] as number | null) ?? 1) + 1,
          }
        : {
            previousReviewId: null,
            chainRootReviewId: newReviewId,
            revisionNumber: 1,
          };

      try {
        await rrTx.update({ where: { id: newReviewId }, data: chainData });
      } catch (error: unknown) {
        // `previousReviewId` is @unique: if the predecessor is already claimed (a repeated
        // materialization after manual intervention), keep the root and revision number and
        // leave `previousReviewId` empty rather than failing the whole import.
        if (!isUniqueConstraintViolation(error)) throw error;
        await rrTx.update({
          where: { id: newReviewId },
          data: {
            previousReviewId: null,
            chainRootReviewId: chainData.chainRootReviewId,
            revisionNumber: chainData.revisionNumber,
          },
        });
      }

      // Phase 15: licenses are materialized before the entities that reference them,
      // so every licenseRef resolves to an already-persisted license id.
      const licenseIdByKey = await this.materializeLicenses(t, reportJson, {
        rightsProfileId: profile['id'] as string,
        rightsReviewImportId: importId,
        importedByUserId,
      });

      if (sourceAssessment) {
        const sourceEdition = await seTx.create({
          data: {
            rightsProfileId: profile['id'] as string,
            provider: (sourceAssessment['provider'] as string) ?? 'UNKNOWN',
            externalId: (sourceAssessment['externalId'] as string) ?? null,
            sourceUrl: (sourceAssessment['sourceUrl'] as string) ?? null,
            sourceTitle: (sourceAssessment['sourceTitle'] as string) ?? null,
            sourceLanguage: (sourceAssessment['sourceLanguage'] as string) ?? null,
            sourceTextType: (sourceAssessment['sourceTextType'] as string) ?? 'UNKNOWN',
            gutenbergStatus: (sourceAssessment['gutenbergStatus'] as string) ?? null,
            status: sourceAssessment['status'] as string,
            notesRu: (sourceAssessment['notesRu'] as string) ?? null,
            // WP-8.3 (R3-05): контрольная сумма файла источника. Поле в отчёте необязательное
            // (`additionalProperties: true`, `schemaVersion` не поднимается), поэтому агент
            // может её не прислать — тогда файл прикрепляет редактор через
            // `POST /admin/rights/profiles/:id/source-file`, и сумму считает сервер.
            // Явно мусорное значение отбрасывается: в хеш клиренса попадает только то,
            // что похоже на sha256.
            sourceFileSha256: normalizeSha256(sourceAssessment['sourceFileSha256']),
          },
        });

        /**
         * WP-7.3 (R4-03, R2-01, R3-01): `EditionRights` — запись на язык, а не копия источника.
         *
         * До WP-7 создавалась ровно одна строка, дословно повторявшая `status`/`notesRu`
         * исходного издания, а вердикт агента по каждому языку (`languageAssessments`)
         * уничтожался, хотя валидатор требовал покрытия каждого целевого языка.
         *
         * Языкового блока в отчёте нет → строк не создаётся вообще. Пустой дубликат источника
         * означал бы «язык оценён», хотя он не оценён: отсутствие записи честнее.
         */
        const assessedLanguages = new Set<string>();

        for (const assessment of languageAssessments ?? []) {
          const rawLanguageCode = assessment['languageCode'];
          const languageCode =
            typeof rawLanguageCode === 'string' ? rawLanguageCode.trim().toLowerCase() : '';
          if (!languageCode) continue;
          assessedLanguages.add(languageCode);

          await erTx.create({
            data: {
              sourceEditionId: sourceEdition['id'] as string,
              languageCode,
              status: assessment['status'] as string,
              notesRu: (assessment['notesRu'] as string) ?? null,
              translationOrigin: (assessment['translationOrigin'] as string) ?? 'UNKNOWN',
              translationSourceLanguage:
                (assessment['translationSourceLanguage'] as string) ?? null,
              requiresGeoBlock: (assessment['requiresGeoBlock'] as boolean) ?? false,
            },
          });
        }

        /**
         * WP-G.5: пробел в покрытии языков перестал быть ошибкой валидации, поэтому целевой
         * язык без оценки обязан получить явную запись. Молчаливый пропуск читался бы как
         * «языка нет в контракте»; `NOT_TARGETED` означает «не разрешён» и сохраняет правило
         * ADR-014: клиренс покрывает целевые языки целиком, подмножество не разрешается.
         */
        const targetLanguages = Array.isArray(intake.targetLanguages)
          ? (intake.targetLanguages as unknown[])
          : [];
        for (const rawTarget of targetLanguages) {
          const languageCode = typeof rawTarget === 'string' ? rawTarget.trim().toLowerCase() : '';
          if (!languageCode || assessedLanguages.has(languageCode)) continue;
          assessedLanguages.add(languageCode);

          await erTx.create({
            data: {
              sourceEditionId: sourceEdition['id'] as string,
              languageCode,
              status: UNASSESSED_LANGUAGE_STATUS,
              notesRu: null,
              translationOrigin: 'UNKNOWN',
              translationSourceLanguage: null,
              requiresGeoBlock: false,
            },
          });
        }

        await this.linkLicenses(t, licenseIdByKey, {
          refs: sourceAssessment['licenseRefs'],
          linkType: 'SOURCE_EDITION',
          targetField: 'sourceEditionId',
          targetId: sourceEdition['id'] as string,
          createdByUserId: importedByUserId,
        });
      }

      const aggregationComponents: ComponentTerritoryAggregationComponent[] = [];
      const createdComponentMap = new Map<string, string>();
      const licenseRefByCountry = new Map<string, string>();
      let hasComponentTerritoryAssessments = false;
      if (componentAssessments && componentAssessments.length > 0) {
        for (let idx = 0; idx < componentAssessments.length; idx++) {
          const component = componentAssessments[idx];
          const componentLanguage =
            typeof component['languageCode'] === 'string' && component['languageCode'].trim() !== ''
              ? component['languageCode'].trim().toLowerCase()
              : null;

          const createdComponent = await rcTx.create({
            data: {
              rightsProfileId: profile['id'] as string,
              componentType: component['componentType'] as string,
              titleRu: component['titleRu'] as string,
              // WP-7.2: `null` — компонент общий для всех языков версии (обложка, иллюстрация).
              languageCode: componentLanguage,
              status: component['status'] as string,
              requiredAction: component['requiredAction'] as string,
              confidence: component['confidence'] as string,
              notesRu: (component['notesRu'] as string) ?? null,
            },
          });
          createdComponentMap.set(`comp-${idx}`, createdComponent['id'] as string);

          await this.linkLicenses(t, licenseIdByKey, {
            refs: component['licenseRefs'],
            linkType: 'RIGHTS_COMPONENT',
            targetField: 'rightsComponentId',
            targetId: createdComponent['id'] as string,
            createdByUserId: importedByUserId,
          });

          const componentConfidence = component['confidence'] as ComponentTerritoryConfidence;
          const componentTerritoryAssessments = Array.isArray(component['territoryAssessments'])
            ? (component['territoryAssessments'] as Array<Record<string, unknown>>)
            : [];
          const normalizedAssessments: ComponentTerritoryAssessmentInput[] = [];

          for (const assessment of componentTerritoryAssessments) {
            hasComponentTerritoryAssessments = true;
            const normalizedAssessment = {
              countryCode: (assessment['countryCode'] as string).toUpperCase(),
              status: assessment['status'] as ComponentTerritoryFinalStatus,
              accessPolicy: assessment['accessPolicy'] as ComponentTerritoryAccessPolicy,
              geoBlockRequired: (assessment['geoBlockRequired'] as boolean) ?? false,
              reasonRu: (assessment['reasonRu'] as string) ?? null,
              legalBasisRu: (assessment['legalBasisRu'] as string) ?? null,
              publicDomainFromYear:
                typeof assessment['publicDomainFromYear'] === 'number'
                  ? assessment['publicDomainFromYear']
                  : null,
              rightsExpireAt: this.parseDateOrNull(assessment['rightsExpireAt']),
              sourceEvidenceIds: Array.isArray(assessment['sourceEvidenceIds'])
                ? (assessment['sourceEvidenceIds'] as string[])
                : null,
              confidence:
                (assessment['confidence'] as ComponentTerritoryConfidence | undefined) ??
                componentConfidence,
              notesRu: (assessment['notesRu'] as string) ?? null,
            };

            const createdAssessment = await ctaTx.create({
              data: {
                rightsComponentId: createdComponent['id'] as string,
                ...normalizedAssessment,
              },
            });

            const assessmentLicenseRef = assessment['licenseRef'];
            if (typeof assessmentLicenseRef === 'string') {
              // Remembered so an aggregated territory decision without its own licenseRef
              // can still inherit the license that justified the country.
              licenseRefByCountry.set(normalizedAssessment.countryCode, assessmentLicenseRef);
              await this.linkLicenses(t, licenseIdByKey, {
                refs: [assessmentLicenseRef],
                linkType: 'COMPONENT_TERRITORY_ASSESSMENT',
                targetField: 'componentTerritoryAssessmentId',
                targetId: createdAssessment['id'] as string,
                coversCountryCodes: [normalizedAssessment.countryCode],
                createdByUserId: importedByUserId,
              });
            }

            normalizedAssessments.push(normalizedAssessment);
          }

          aggregationComponents.push({
            rightsComponentId: createdComponent['id'] as string,
            componentType: component['componentType'] as string,
            titleRu: component['titleRu'] as string,
            status: component['status'] as string,
            requiredAction: component['requiredAction'] as string,
            confidence: componentConfidence,
            territoryAssessments: normalizedAssessments,
          });
        }
      }

      // WP-B.4: действия создаются до расчёта решений по странам, чтобы в агрегацию ушёл
      // реальный `componentRemovalsConfirmed`, а не подразумеваемое «не подтверждено».
      // Порядок важен только относительно блока `territoryDecision` ниже: собственных
      // `linkLicenses` у действий нет.
      const createdActions: Array<{ actionType: string; status: string }> = [];
      if (requiredActions && requiredActions.length > 0) {
        for (const action of requiredActions) {
          // WP-5.3: агент предлагает действие, закрывает его человек. Раньше принимались все
          // пять статусов, поэтому отчёт с `suggestedStatus: COMPLETED` создавал уже закрытое
          // блокирующее действие — условие №5 фазы 7 оказывалось под контролем проверяемой
          // стороны (R3-03). Закрытие теперь возможно только через
          // `PATCH /admin/rights/actions/:id`, то есть с автором и событием в аудите.
          const suggestedStatus = action['suggestedStatus'] as string | undefined;
          const finalStatus =
            suggestedStatus &&
            (AGENT_SUGGESTABLE_ACTION_STATUSES as readonly string[]).includes(suggestedStatus)
              ? suggestedStatus
              : 'PENDING';
          const actionType = action['actionType'] as string;

          await raTx.create({
            data: {
              rightsProfileId: profile['id'] as string,
              actionType,
              status: finalStatus,
              descriptionRu: action['descriptionRu'] as string,
              affectedCountryCodes: (action['affectedCountryCodes'] as unknown[]) ?? [],
              isBlocking: (action['isBlocking'] as boolean) ?? false,
            },
          });

          createdActions.push({ actionType, status: finalStatus });
        }
      }

      const existingTerritoryDecisions = this.mapExistingTerritoryDecisions(
        territoryDecisions,
        reportJson['confidence'],
      );
      const decisionsToCreate = hasComponentTerritoryAssessments
        ? this.componentTerritoryAggregationService.aggregateTerritoryDecisionsFromComponents({
            rightsProfileId: profile['id'] as string,
            components: aggregationComponents,
            targetCountryCodes: Array.isArray(intake.targetCountryCodes)
              ? (intake.targetCountryCodes as string[])
              : [],
            existingTerritoryDecisions,
            // Все действия отчёта создаются открытыми (WP-5.3), поэтому подтверждением здесь
            // может быть только отсутствие компонентов к удалению (WP-A.4). Компонент,
            // помеченный к удалению, по-прежнему участвует в оценке страны (R6-06).
            componentRemovalsConfirmed: areComponentRemovalsConfirmed(
              createdActions,
              aggregationComponents.some((component) => isComponentMarkedForRemoval(component)),
            ),
          })
        : existingTerritoryDecisions.map((territory) => ({
            rightsProfileId: profile['id'] as string,
            ...territory,
          }));

      const reportedLicenseRefByCountry = this.mapReportedTerritoryLicenseRefs(territoryDecisions);

      if (decisionsToCreate.length > 0) {
        for (const territory of decisionsToCreate) {
          const createdDecision = await tdTx.create({
            data: {
              rightsProfileId: profile['id'] as string,
              countryCode: territory.countryCode,
              finalStatus: territory.finalStatus,
              accessPolicy: territory.accessPolicy,
              geoBlockRequired: territory.geoBlockRequired,
              geoBlockScope: territory.geoBlockScope ?? null,
              reasonRu: territory.reasonRu,
              legalBasisRu: territory.legalBasisRu ?? null,
              confidence: territory.confidence,
              nextReviewAt: territory.nextReviewAt ?? null,
            },
          });

          // Aggregated decisions lose the report-level licenseRef, so fall back to the
          // license attached to the component assessment for the same country.
          const decisionLicenseRef =
            reportedLicenseRefByCountry.get(territory.countryCode) ??
            licenseRefByCountry.get(territory.countryCode);

          if (decisionLicenseRef) {
            await this.linkLicenses(t, licenseIdByKey, {
              refs: [decisionLicenseRef],
              linkType: 'TERRITORY_DECISION',
              targetField: 'territoryDecisionId',
              targetId: createdDecision['id'] as string,
              coversCountryCodes: [territory.countryCode],
              createdByUserId: importedByUserId,
            });
          }
        }
      }

      if (evidence && evidence.length > 0) {
        for (const ev of evidence) {
          const createdEvidence = await reTx.create({
            data: {
              rightsProfileId: profile['id'] as string,
              evidenceType: ev['evidenceType'] as string,
              sourceLevel: ev['sourceLevel'] as string,
              title: ev['title'] as string,
              authority: ev['authority'] as string,
              url: (ev['url'] as string) ?? null,
              jurisdictionCode: (ev['jurisdictionCode'] as string) ?? null,
              accessedAt: this.parseDateOrNull(ev['accessedAt']),
              relevantExcerpt: (ev['relevantExcerpt'] as string) ?? null,
              summaryRu: ev['summaryRu'] as string,
            },
          });

          if (typeof ev['licenseRef'] === 'string') {
            await this.linkLicenses(t, licenseIdByKey, {
              refs: [ev['licenseRef']],
              linkType: 'RIGHTS_EVIDENCE',
              targetField: 'rightsEvidenceId',
              targetId: createdEvidence['id'] as string,
              createdByUserId: importedByUserId,
            });
          }
        }
      }

      await this.materializeProfileContributors(
        t as unknown as Prisma.TransactionClient,
        profile['id'] as string,
        reportJson,
        ((intakeRecord as Record<string, unknown>)['candidateAuthor'] as string) ?? null,
        createdComponentMap,
      );

      const riTx = t['rightsIntake'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      await riTx.update({
        where: { id: intakeId },
        data: {
          workflowStatus: 'HUMAN_REVIEW_REQUIRED',
          approvedReviewId: null,
        },
      });

      return profile;
    });

    return result;
  }

  /**
   * Creates (or reuses) the licenses declared in the report and links each one to the profile.
   * Reuse order: same `licenseKey`, then same non-empty `documentSha256`, otherwise a new row.
   * A reused license is never overwritten — only its still-empty columns get filled in.
   */
  private async materializeLicenses(
    t: Record<string, unknown>,
    reportJson: Record<string, unknown>,
    context: {
      rightsProfileId: string;
      rightsReviewImportId: string;
      importedByUserId: string | null;
    },
  ): Promise<Map<string, string>> {
    const licenseIdByKey = new Map<string, string>();
    const licenses = reportJson['licenses'];
    if (!Array.isArray(licenses) || licenses.length === 0) return licenseIdByKey;

    const rlTx = t['rightsLicense'] as {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const rleTx = t['rightsLicenseEvent'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    for (const raw of licenses) {
      const license = raw as Record<string, unknown>;
      const key = license['key'];
      if (typeof key !== 'string' || key.trim() === '') continue;

      const documentSha256 = (license['documentSha256'] as string | undefined) ?? null;
      const data = this.buildLicenseData(license, key);

      let existing = await rlTx.findFirst({ where: { licenseKey: key } });
      if (!existing && documentSha256) {
        existing = await rlTx.findFirst({ where: { documentSha256 } });
      }

      let licenseId: string;
      if (existing) {
        licenseId = existing['id'] as string;
        const patch = this.buildLicenseBackfill(existing, data);
        if (Object.keys(patch).length > 0) {
          await rlTx.update({ where: { id: licenseId }, data: patch });
        }
      } else {
        const created = await rlTx.create({
          data: { ...data, createdByUserId: context.importedByUserId },
        });
        licenseId = created['id'] as string;
      }

      licenseIdByKey.set(key, licenseId);

      await rleTx.create({
        data: {
          rightsLicenseId: licenseId,
          eventType: 'IMPORTED_FROM_REVIEW',
          currentStatus: data['status'] as string,
          createdByUserId: context.importedByUserId,
          payload: {
            rightsProfileId: context.rightsProfileId,
            rightsReviewImportId: context.rightsReviewImportId,
          },
        },
      });

      await this.linkLicenses(t, licenseIdByKey, {
        refs: [key],
        linkType: 'RIGHTS_PROFILE',
        targetField: 'rightsProfileId',
        targetId: context.rightsProfileId,
        createdByUserId: context.importedByUserId,
      });
    }

    return licenseIdByKey;
  }

  private buildLicenseData(license: Record<string, unknown>, key: string): Record<string, unknown> {
    const readStringArray = (
      value: unknown,
      transform: (item: string) => string,
    ): string[] | null =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').map(transform)
        : null;

    return {
      licenseKey: key,
      licenseType: (license['licenseType'] as string) ?? 'DIRECT_LICENSE',
      status: (license['status'] as string) ?? 'DRAFT',
      title: license['title'] as string,
      licensor: license['licensor'] as string,
      licensee: (license['licensee'] as string) ?? null,
      rightsHolder: (license['rightsHolder'] as string) ?? null,
      referenceNumber: (license['referenceNumber'] as string) ?? null,
      grantedAt: this.parseDateOrNull(license['grantedAt']),
      effectiveFrom: this.parseDateOrNull(license['effectiveFrom']),
      expiresAt: this.parseDateOrNull(license['expiresAt']),
      isPerpetual: (license['isPerpetual'] as boolean) ?? false,
      territoryScope: (license['territoryScope'] as string) ?? 'UNKNOWN',
      countryCodes: readStringArray(license['countryCodes'], (item) => item.toUpperCase()),
      excludedCountryCodes: readStringArray(license['excludedCountryCodes'], (item) =>
        item.toUpperCase(),
      ),
      languageCodes: readStringArray(license['languageCodes'], (item) => item.toLowerCase()),
      mediaFormats: readStringArray(license['mediaFormats'], (item) => item),
      commercialUseAllowed: (license['commercialUseAllowed'] as boolean) ?? false,
      modificationAllowed: (license['modificationAllowed'] as boolean) ?? false,
      translationAllowed: (license['translationAllowed'] as boolean) ?? false,
      sublicensingAllowed: (license['sublicensingAllowed'] as boolean) ?? false,
      attributionRequired: (license['attributionRequired'] as boolean) ?? false,
      requiredAttributionText: (license['requiredAttributionText'] as string) ?? null,
      exclusive: (license['exclusive'] as boolean) ?? false,
      revocable: (license['revocable'] as boolean) ?? true,
      royaltyTermsRu: (license['royaltyTermsRu'] as string) ?? null,
      otherConditionsRu: (license['otherConditionsRu'] as string) ?? null,
      notesRu: (license['notesRu'] as string) ?? null,
      documentStorageKey: (license['documentStorageKey'] as string) ?? null,
      documentSha256: (license['documentSha256'] as string) ?? null,
      documentUrl: (license['documentUrl'] as string) ?? null,
      sourceEvidenceIds: readStringArray(license['sourceEvidenceIds'], (item) => item),
      confidence: (license['confidence'] as string) ?? null,
    };
  }

  /** Only fills columns that are currently null/empty on the reused license. */
  private buildLicenseBackfill(
    existing: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(data)) {
      if (value === null || value === undefined) continue;
      const current = existing[field];
      const isEmpty =
        current === null ||
        current === undefined ||
        (Array.isArray(current) && current.length === 0);
      if (isEmpty) patch[field] = value;
    }
    return patch;
  }

  /** Creates license links, skipping refs that were not materialized and existing duplicates. */
  private async linkLicenses(
    t: Record<string, unknown>,
    licenseIdByKey: Map<string, string>,
    options: {
      refs: unknown;
      linkType: string;
      targetField: string;
      targetId: string;
      coversCountryCodes?: string[];
      createdByUserId: string | null;
    },
  ): Promise<void> {
    if (licenseIdByKey.size === 0) return;

    const refs = Array.isArray(options.refs)
      ? options.refs.filter((ref): ref is string => typeof ref === 'string')
      : [];
    if (refs.length === 0) return;

    const rllTx = t['rightsLicenseLink'] as {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    for (const ref of new Set(refs)) {
      const rightsLicenseId = licenseIdByKey.get(ref);
      if (!rightsLicenseId) continue;

      const existing = await rllTx.findFirst({
        where: { rightsLicenseId, [options.targetField]: options.targetId },
      });
      if (existing) continue;

      await rllTx.create({
        data: {
          rightsLicenseId,
          linkType: options.linkType,
          [options.targetField]: options.targetId,
          coversCountryCodes: options.coversCountryCodes ?? null,
          createdByUserId: options.createdByUserId,
        },
      });
    }
  }

  private mapReportedTerritoryLicenseRefs(
    territoryDecisions: Array<Record<string, unknown>> | undefined,
  ): Map<string, string> {
    const refs = new Map<string, string>();
    if (!Array.isArray(territoryDecisions)) return refs;

    for (const decision of territoryDecisions) {
      const countryCode = decision['countryCode'];
      const licenseRef = decision['licenseRef'];
      if (typeof countryCode === 'string' && typeof licenseRef === 'string') {
        refs.set(countryCode.toUpperCase(), licenseRef);
      }
    }
    return refs;
  }

  /**
   * WP-5.5: пересчёт решений по странам после того, как человек изменил статус действия
   * на удаление компонента.
   *
   * Материализация — единственный писатель правовой модели (R3-02), поэтому пересчёт живёт
   * здесь, а не в сервисе действий. Вызывается **внутри транзакции вызывающего**: смена
   * статуса, событие аудита и новый вердикт по стране обязаны примениться вместе.
   *
   * Пересчёт идемпотентен: компоненты и их оценки берутся из БД, а профильные решения агента —
   * из исходного отчёта, а не из уже смёржанных строк `TerritoryDecision`.
   *
   * Возвращает `null`, если пересчитывать нечего или небезопасно: профиль не текущий,
   * компонентных оценок нет (решения пришли из отчёта дословно, агрегация не применялась),
   * либо исходный отчёт недоступен — без профильных решений агента пересчёт мог бы ослабить
   * вердикт, который агент выставил на уровне профиля.
   */
  async recomputeTerritoryDecisionsFromComponents(
    tx: Record<string, unknown>,
    profileId: string,
  ): Promise<{ changedCountryCodes: string[] } | null> {
    const profileTx = tx['rightsProfile'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
    const profile = await profileTx.findUnique({ where: { id: profileId } });
    if (!profile || profile['isCurrent'] !== true) return null;

    const componentTx = tx['rightsComponent'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const components = await componentTx.findMany({
      where: { rightsProfileId: profileId },
      include: { territoryAssessments: true },
    });

    const aggregationComponents: ComponentTerritoryAggregationComponent[] = components.map(
      (component) => ({
        rightsComponentId: component['id'] as string,
        componentType: component['componentType'] as string,
        titleRu: component['titleRu'] as string,
        status: component['status'] as string,
        requiredAction: component['requiredAction'] as string,
        confidence: component['confidence'] as ComponentTerritoryConfidence,
        territoryAssessments: (
          (component['territoryAssessments'] as Array<Record<string, unknown>> | undefined) ?? []
        ).map((assessment) => ({
          countryCode: (assessment['countryCode'] as string).toUpperCase(),
          status: assessment['status'] as ComponentTerritoryFinalStatus,
          accessPolicy: assessment['accessPolicy'] as ComponentTerritoryAccessPolicy,
          geoBlockRequired: (assessment['geoBlockRequired'] as boolean) ?? false,
          reasonRu: (assessment['reasonRu'] as string) ?? null,
          legalBasisRu: (assessment['legalBasisRu'] as string) ?? null,
          confidence: (assessment['confidence'] as ComponentTerritoryConfidence | null) ?? null,
          rightsExpireAt: this.parseDateOrNull(assessment['rightsExpireAt']),
        })),
      }),
    );

    const hasComponentTerritoryAssessments = aggregationComponents.some(
      (component) => component.territoryAssessments.length > 0,
    );
    if (!hasComponentTerritoryAssessments) return null;

    const importId = profile['currentReviewImportId'];
    if (typeof importId !== 'string') return null;

    const importTx = tx['rightsReviewImport'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
    const importRecord = await importTx.findUnique({ where: { id: importId } });
    const reportJson = importRecord?.['reportJson'] as Record<string, unknown> | undefined;
    if (!reportJson) return null;

    const intakeTx = tx['rightsIntake'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
    const intake = await intakeTx.findUnique({
      where: { id: profile['rightsIntakeId'] as string },
    });

    const actionTx = tx['rightsAction'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const actions = await actionTx.findMany({ where: { rightsProfileId: profileId } });

    const decisions =
      this.componentTerritoryAggregationService.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: profileId,
        components: aggregationComponents,
        targetCountryCodes: Array.isArray(intake?.['targetCountryCodes'])
          ? (intake['targetCountryCodes'] as string[])
          : [],
        existingTerritoryDecisions: this.mapExistingTerritoryDecisions(
          reportJson['territoryDecisions'] as Array<Record<string, unknown>> | undefined,
          reportJson['confidence'],
        ),
        componentRemovalsConfirmed: areComponentRemovalsConfirmed(
          actions.map((action) => ({
            actionType: action['actionType'] as string,
            status: action['status'] as string,
          })),
          aggregationComponents.some((component) => isComponentMarkedForRemoval(component)),
        ),
      });

    const decisionTx = tx['territoryDecision'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const changedCountryCodes: string[] = [];
    for (const decision of decisions) {
      const data = {
        finalStatus: decision.finalStatus,
        accessPolicy: decision.accessPolicy,
        geoBlockRequired: decision.geoBlockRequired,
        geoBlockScope: decision.geoBlockScope ?? null,
        reasonRu: decision.reasonRu,
        legalBasisRu: decision.legalBasisRu ?? null,
        confidence: decision.confidence,
        nextReviewAt: decision.nextReviewAt ?? null,
      };

      const existing = await decisionTx.findUnique({
        where: {
          rightsProfileId_countryCode: {
            rightsProfileId: profileId,
            countryCode: decision.countryCode,
          },
        },
      });

      if (!existing) {
        await decisionTx.create({
          data: { rightsProfileId: profileId, countryCode: decision.countryCode, ...data },
        });
        changedCountryCodes.push(decision.countryCode);
        continue;
      }

      const unchanged = (Object.keys(data) as Array<keyof typeof data>).every((key) => {
        const next = data[key];
        const prev = existing[key];
        if (next instanceof Date || prev instanceof Date) {
          const nextTime = next instanceof Date ? next.getTime() : null;
          const prevTime = prev instanceof Date ? prev.getTime() : null;
          return nextTime === prevTime;
        }
        return (prev ?? null) === (next ?? null);
      });
      if (unchanged) continue;

      await decisionTx.update({ where: { id: existing['id'] as string }, data });
      changedCountryCodes.push(decision.countryCode);
    }

    return { changedCountryCodes };
  }

  /**
   * WP-G.2/G.3/G.4: единственная воронка, через которую решения отчёта попадают и в запись,
   * и в агрегацию по компонентам. Нормализация и дефолты живут здесь, потому что валидатор
   * теперь пропускает строчный код страны, синоним `finalStatus` и разрешающее решение без
   * `reasonRu`/`confidence` — а обе колонки `NOT NULL`, и `finalStatus` — Prisma-enum.
   */
  private mapExistingTerritoryDecisions(
    territoryDecisions: Array<Record<string, unknown>> | undefined,
    reportConfidence: unknown,
  ): ExistingTerritoryDecisionInput[] {
    const fallbackConfidence = this.readConfidence(reportConfidence) ?? 'LOW';

    return (territoryDecisions ?? []).map((territory) => {
      const rawCountryCode = territory['countryCode'];
      const rawFinalStatus = territory['finalStatus'];
      const rawReasonRu = territory['reasonRu'];
      // WP-G.2 × WP-B.3: дефолт для записи сохраняется (колонки `NOT NULL`, инцидент R4-01),
      // но помечается синтетическим — иначе он выглядел бы обоснованием агента в агрегации.
      const agentReasonRu =
        typeof rawReasonRu === 'string' && rawReasonRu.trim() !== '' ? rawReasonRu : null;
      const agentConfidence = this.readConfidence(territory['confidence']);

      return {
        countryCode: typeof rawCountryCode === 'string' ? rawCountryCode.toUpperCase() : '',
        finalStatus: (typeof rawFinalStatus === 'string'
          ? normalizeTerritoryFinalStatus(rawFinalStatus)
          : rawFinalStatus) as ComponentTerritoryFinalStatus,
        accessPolicy: territory['accessPolicy'] as ComponentTerritoryAccessPolicy,
        geoBlockRequired: (territory['geoBlockRequired'] as boolean) ?? false,
        geoBlockScope: (territory['geoBlockScope'] as string) ?? null,
        reasonRu: agentReasonRu ?? TERRITORY_DECISION_DEFAULT_REASON_RU,
        legalBasisRu: (territory['legalBasisRu'] as string) ?? null,
        confidence: agentConfidence ?? fallbackConfidence,
        reasonRuFromAgent: agentReasonRu !== null,
        confidenceFromAgent: agentConfidence !== null,
        nextReviewAt: this.parseDateOrNull(territory['nextReviewAt']),
      };
    });
  }

  private readConfidence(value: unknown): ComponentTerritoryConfidence | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    return normalized === 'HIGH' || normalized === 'MEDIUM' || normalized === 'LOW'
      ? normalized
      : null;
  }

  private readContributorString(raw: Record<string, unknown>, ...keys: string[]): string | null {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }

  private readContributorNumber(raw: Record<string, unknown>, ...keys: string[]): number | null {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
      }
    }
    return null;
  }

  private normalizeContributorRole(rawRole: string | null): {
    role: ContributorRole;
    roleOtherRu: string | null;
  } {
    if (!rawRole) {
      return { role: ContributorRole.AUTHOR, roleOtherRu: null };
    }

    const upperCased = rawRole.toUpperCase();
    if (CONTRIBUTOR_ROLE_VALUES.includes(upperCased as ContributorRole)) {
      return { role: upperCased as ContributorRole, roleOtherRu: null };
    }

    return { role: ContributorRole.OTHER, roleOtherRu: rawRole };
  }

  private normalizeContributorConfidence(
    raw: Record<string, unknown>,
  ): NormalizedContributorConfidence {
    const confidence = this.readContributorString(raw, 'confidence');
    if (confidence && RIGHTS_CONFIDENCE_VALUES.includes(confidence.toUpperCase())) {
      return confidence.toUpperCase() as RightsConfidence;
    }

    const identityConfidence = this.readContributorString(raw, 'identityConfidence');
    if (identityConfidence) {
      return IDENTITY_CONFIDENCE_TO_RIGHTS_CONFIDENCE[identityConfidence.toUpperCase()] ?? null;
    }

    return null;
  }

  private normalizeContributor(raw: Record<string, unknown>): NormalizedContributorInput | null {
    const displayName = this.readContributorString(
      raw,
      'displayName',
      'canonicalName',
      'originalName',
      'name',
    );
    if (!displayName) {
      return null;
    }

    const { role, roleOtherRu } = this.normalizeContributorRole(
      this.readContributorString(raw, 'role'),
    );

    return {
      role,
      roleOtherRu: this.readContributorString(raw, 'roleOtherRu') ?? roleOtherRu,
      displayName,
      canonicalName:
        this.readContributorString(raw, 'canonicalName', 'originalName') ?? displayName,
      creditedName: this.readContributorString(raw, 'creditedName', 'pseudonym'),
      creditedLanguage: this.readContributorString(raw, 'creditedLanguage', 'targetLanguage'),
      birthYear: this.readContributorNumber(raw, 'birthYear'),
      deathYear: this.readContributorNumber(raw, 'deathYear'),
      nationalityCountryCode: this.readContributorString(
        raw,
        'nationalityCountryCode',
        'nationalityCountry',
      ),
      wikidataId: this.readContributorString(raw, 'wikidataId'),
      viafId: this.readContributorString(raw, 'viafId'),
      isni: this.readContributorString(raw, 'isni'),
      gutenbergAgentId: this.readContributorString(raw, 'gutenbergAgentId'),
      publicDomainFromYear: this.readContributorNumber(raw, 'publicDomainFromYear'),
      sourceEvidenceIds: Array.isArray(raw['sourceEvidenceIds'])
        ? (raw['sourceEvidenceIds'] as unknown[]).filter(
            (evidenceId): evidenceId is string => typeof evidenceId === 'string',
          )
        : null,
      confidence: this.normalizeContributorConfidence(raw),
      notesRu: this.readContributorString(raw, 'notesRu'),
    };
  }

  private buildContributorData(
    rightsProfileId: string,
    rightsComponentId: string | null,
    personId: string | null,
    input: NormalizedContributorInput,
  ): Record<string, unknown> {
    return {
      rightsProfileId,
      rightsComponentId,
      personId,
      role: input.role,
      roleOtherRu: input.roleOtherRu,
      displayName: input.displayName,
      canonicalName: input.canonicalName,
      creditedName: input.creditedName,
      creditedLanguage: input.creditedLanguage,
      birthYear: input.birthYear,
      deathYear: input.deathYear,
      nationalityCountryCode: input.nationalityCountryCode,
      wikidataId: input.wikidataId,
      viafId: input.viafId,
      isni: input.isni,
      gutenbergAgentId: input.gutenbergAgentId,
      publicDomainFromYear: input.publicDomainFromYear,
      sourceEvidenceIds: input.sourceEvidenceIds,
      confidence: input.confidence,
      notesRu: input.notesRu,
    };
  }

  private contributorDedupKey(
    personId: string | null,
    input: NormalizedContributorInput,
    rightsComponentId: string | null,
  ): string {
    const identity = personId ?? input.canonicalName.toLowerCase();
    return `${identity}|${input.role}|${rightsComponentId ?? ''}`;
  }

  private async resolveContributorPersonId(
    input: NormalizedContributorInput,
  ): Promise<string | null> {
    try {
      const person = await this.personResolverService.resolveOrCreatePerson({
        displayName: input.displayName,
        canonicalName: input.canonicalName,
        birthYear: input.birthYear,
        deathYear: input.deathYear,
        nationalityCountryCode: input.nationalityCountryCode,
        publicDomainFromYear: input.publicDomainFromYear,
        wikidataId: input.wikidataId,
        viafId: input.viafId,
        isni: input.isni,
        gutenbergAgentId: input.gutenbergAgentId,
        notesRu: input.notesRu,
      });
      return person.id;
    } catch {
      return null;
    }
  }

  private async materializeProfileContributors(
    tx: Prisma.TransactionClient,
    rightsProfileId: string,
    reportJson: Record<string, unknown>,
    intakeCandidateAuthor: string | null,
    createdComponentMap: Map<string, string>,
  ) {
    const t = tx as unknown as Record<string, unknown>;
    const rpcModel = t['rightsProfileContributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const createdDedupKeys = new Set<string>();
    const keyToContributorRecord = new Map<string, MaterializedContributor>();
    let createdCount = 0;

    const createContributor = async (
      input: NormalizedContributorInput,
      rightsComponentId: string | null,
    ): Promise<MaterializedContributor | null> => {
      const personId = await this.resolveContributorPersonId(input);
      const dedupKey = this.contributorDedupKey(personId, input, rightsComponentId);
      if (createdDedupKeys.has(dedupKey)) {
        return null;
      }
      createdDedupKeys.add(dedupKey);

      const created = await rpcModel.create({
        data: this.buildContributorData(rightsProfileId, rightsComponentId, personId, input),
      });
      createdCount += 1;

      return {
        id: created['id'] as string,
        personId,
        rightsComponentId,
        input,
      };
    };

    const rawContributors = reportJson['contributors'];
    if (Array.isArray(rawContributors)) {
      for (let index = 0; index < rawContributors.length; index++) {
        const rawContributor = rawContributors[index] as Record<string, unknown>;
        const input = this.normalizeContributor(rawContributor);
        if (!input) continue;

        const created = await createContributor(input, null);
        if (!created) continue;

        const contributorKey =
          this.readContributorString(rawContributor, 'key') ?? `contributor-${index}`;
        keyToContributorRecord.set(contributorKey, created);
      }
    }

    const componentAssessments = reportJson['componentAssessments'];
    if (Array.isArray(componentAssessments)) {
      for (let index = 0; index < componentAssessments.length; index++) {
        const componentAssessment = componentAssessments[index] as Record<string, unknown>;
        const rightsComponentId = createdComponentMap.get(`comp-${index}`);
        if (!rightsComponentId) continue;

        await this.materializeComponentContributorRefs(
          rpcModel,
          componentAssessment,
          rightsComponentId,
          keyToContributorRecord,
          createdDedupKeys,
          createContributor,
        );

        const inlineContributors = componentAssessment['contributors'];
        if (Array.isArray(inlineContributors)) {
          for (const rawContributor of inlineContributors) {
            const input = this.normalizeContributor(rawContributor as Record<string, unknown>);
            if (!input) continue;
            await createContributor(input, rightsComponentId);
          }
        }
      }
    }

    const sourceAssessment = reportJson['sourceAssessment'] as Record<string, unknown> | undefined;
    const sourceContributors = sourceAssessment?.['contributors'];
    if (Array.isArray(sourceContributors)) {
      for (const rawContributor of sourceContributors) {
        const input = this.normalizeContributor(rawContributor as Record<string, unknown>);
        if (!input) continue;
        await createContributor(input, null);
      }
    }

    if (createdCount === 0 && intakeCandidateAuthor && intakeCandidateAuthor.trim()) {
      const candidateAuthor = intakeCandidateAuthor.trim();
      await createContributor(
        {
          role: ContributorRole.AUTHOR,
          roleOtherRu: null,
          displayName: candidateAuthor,
          canonicalName: candidateAuthor,
          creditedName: null,
          creditedLanguage: null,
          birthYear: null,
          deathYear: null,
          nationalityCountryCode: null,
          wikidataId: null,
          viafId: null,
          isni: null,
          gutenbergAgentId: null,
          publicDomainFromYear: null,
          sourceEvidenceIds: null,
          confidence: null,
          notesRu: null,
        },
        null,
      );
    }
  }

  private async materializeComponentContributorRefs(
    rpcModel: {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    },
    componentAssessment: Record<string, unknown>,
    rightsComponentId: string,
    keyToContributorRecord: Map<string, MaterializedContributor>,
    createdDedupKeys: Set<string>,
    createContributor: (
      input: NormalizedContributorInput,
      rightsComponentId: string | null,
    ) => Promise<MaterializedContributor | null>,
  ) {
    const refs = componentAssessment['contributorRefs'];
    if (!Array.isArray(refs)) return;

    for (const rawRef of refs) {
      const ref = rawRef as Record<string, unknown>;
      const contributorKey = this.readContributorString(ref, 'contributorKey');
      if (!contributorKey) continue;

      const base = keyToContributorRecord.get(contributorKey);
      if (!base) continue;

      const rawRefRole = this.readContributorString(ref, 'role');
      const refRole = rawRefRole ? this.normalizeContributorRole(rawRefRole) : null;
      const creditedName =
        this.readContributorString(ref, 'creditedName') ?? base.input.creditedName;
      const notesRu = this.readContributorString(ref, 'notesRu') ?? base.input.notesRu;
      const roleMatchesBase = !refRole || refRole.role === base.input.role;

      // Первая ссылка на ещё не привязанного участника: переиспользуем существующую строку,
      // чтобы не плодить дубликат профильного участника.
      if (base.rightsComponentId === null && roleMatchesBase) {
        await rpcModel.update({
          where: { id: base.id },
          data: { rightsComponentId, creditedName, notesRu },
        });

        base.rightsComponentId = rightsComponentId;
        base.input = { ...base.input, creditedName, notesRu };
        createdDedupKeys.add(
          this.contributorDedupKey(base.personId, base.input, rightsComponentId),
        );
        continue;
      }

      await createContributor(
        {
          ...base.input,
          role: refRole ? refRole.role : base.input.role,
          roleOtherRu: refRole ? refRole.roleOtherRu : base.input.roleOtherRu,
          creditedName,
          notesRu,
        },
        rightsComponentId,
      );
    }
  }
}
