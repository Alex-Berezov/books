import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { RightsLicensesService } from '../rights-licenses/rights-licenses.service';
import { RightsLicenseStatus } from '../rights-licenses/rights-license-interface';
import { mapRightsAction } from './rights-action.mapper';
import { TerritoryRegionAggregationService } from './territory-region-aggregation.service';
import type { RightsLicenseSummaryDto } from '../rights-licenses/dto/rights-license-response.dto';
import type { RightsLicenseRecord } from '../rights-licenses/rights-license-interface';
import type {
  RightsProfileDetailDto,
  RightsProfileSummaryDto,
  RightsReviewDto,
} from './dto/rights-profile-response.dto';
import { RightsReviewApprovalDto } from './dto/rights-review-approval.dto';

const EXPIRING_SOON_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One RightsLicenseLink row joined with its license, as loaded for a profile. */
interface ProfileLicenseLink {
  rightsLicenseId: string;
  rightsComponentId: string | null;
  componentTerritoryAssessmentId: string | null;
  rightsLicense: RightsLicenseRecord;
}

@Injectable()
export class RightsProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly regionAggregationService: TerritoryRegionAggregationService,
    private readonly licensesService: RightsLicensesService,
    private readonly licenseCoverageService: RightsLicenseCoverageService,
  ) {}

  private get rp() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsProfile'] as {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  private get se() {
    return (this.prisma as unknown as Record<string, unknown>)['sourceEdition'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  private get er() {
    return (this.prisma as unknown as Record<string, unknown>)['editionRights'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  }

  async getCurrentByIntake(intakeId: string) {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw new NotFoundException(`Rights intake with ID '${intakeId}' not found`);
    }

    const profile = await this.rp.findFirst({
      where: { rightsIntakeId: intakeId, isCurrent: true },
    });

    if (!profile) {
      throw new NotFoundException(`No current rights profile found for intake '${intakeId}'`);
    }

    return this.mapToDetail(profile);
  }

  async listByIntake(intakeId: string) {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw new NotFoundException(`Rights intake with ID '${intakeId}' not found`);
    }

    const profiles = await this.rp.findMany({
      where: { rightsIntakeId: intakeId },
      orderBy: { createdAt: 'desc' },
    });

    return profiles.map((p) => this.mapToSummary(p));
  }

  async getById(profileId: string) {
    const profile = await this.rp.findUnique({ where: { id: profileId } });

    if (!profile) {
      throw new NotFoundException(`Rights profile with ID '${profileId}' not found`);
    }

    return this.mapToDetail(profile);
  }

  private mapToSummary(profile: Record<string, unknown>) {
    return {
      id: profile['id'] as string,
      rightsIntakeId: profile['rightsIntakeId'] as string,
      currentReviewImportId: (profile['currentReviewImportId'] as string) ?? null,
      status: profile['status'] as string,
      isCurrent: profile['isCurrent'] as boolean,
      overallStatus: profile['overallStatus'] as string,
      publicationGate: profile['publicationGate'] as string,
      confidence: profile['confidence'] as string,
      summaryRu: profile['summaryRu'] as string,
      conclusionRu: profile['conclusionRu'] as string,
      reasoningRu: (profile['reasoningRu'] as string) ?? null,
      nextReviewAt: profile['nextReviewAt']
        ? new Date(profile['nextReviewAt'] as string).toISOString()
        : null,
      supersededAt: profile['supersededAt']
        ? new Date(profile['supersededAt'] as string).toISOString()
        : null,
      archivedAt: profile['archivedAt']
        ? new Date(profile['archivedAt'] as string).toISOString()
        : null,
      createdAt: new Date(profile['createdAt'] as string).toISOString(),
      updatedAt: new Date(profile['updatedAt'] as string).toISOString(),
    } as RightsProfileSummaryDto;
  }

  private async mapToDetail(profile: Record<string, unknown>) {
    const profileId = profile['id'] as string;

    const sourceEditionRecord = await this.se.findUnique({
      where: { rightsProfileId: profileId },
    });

    // WP-7.1: прав на издание столько, сколько оценённых языков.
    let editionRightsRecords: Array<Record<string, unknown>> = [];
    if (sourceEditionRecord) {
      editionRightsRecords = await this.er.findMany({
        where: { sourceEditionId: sourceEditionRecord['id'] as string },
        orderBy: { languageCode: 'asc' },
      });
    }

    const reviews = (await (this.prisma as unknown as Record<string, unknown>)['rightsReview']) as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const reviewsData = await reviews.findMany({
      where: { rightsProfileId: profileId },
      include: {
        approvedByUser: { select: { id: true, name: true, email: true } },
        rejectedByUser: { select: { id: true, name: true, email: true } },
        approvals: {
          include: {
            decidedByUser: { select: { id: true, name: true, email: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    const components = (await (this.prisma as unknown as Record<string, unknown>)[
      'rightsComponent'
    ]) as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const componentsData = await components.findMany({
      where: { rightsProfileId: profileId },
      include: {
        territoryAssessments: {
          orderBy: [{ countryCode: 'asc' }],
        },
        contributors: {
          include: {
            person: true,
          },
        },
      },
    });

    const territoryDecisions = (await (this.prisma as unknown as Record<string, unknown>)[
      'territoryDecision'
    ]) as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const territoryData = await territoryDecisions.findMany({
      where: { rightsProfileId: profileId },
    });

    const evidence = (await (this.prisma as unknown as Record<string, unknown>)[
      'rightsEvidence'
    ]) as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const evidenceData = await evidence.findMany({
      where: { rightsProfileId: profileId },
    });

    const actions = (await (this.prisma as unknown as Record<string, unknown>)['rightsAction']) as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const actionsData = await actions.findMany({
      where: { rightsProfileId: profileId },
    });

    const contributorsModel = (await (this.prisma as unknown as Record<string, unknown>)[
      'rightsProfileContributor'
    ]) as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const contributorsData = await contributorsModel.findMany({
      where: { rightsProfileId: profileId },
      include: {
        person: true,
      },
    });

    const licenseLinks = await this.loadProfileLicenseLinks(profileId);
    const licenseMetrics = this.buildLicenseMetrics(licenseLinks);
    const licenseCoverage = await this.licenseCoverageService.evaluateProfileCoverage(profileId);
    const licensesByComponentId = this.groupLicensesByComponent(licenseLinks, componentsData);
    const licenseByAssessmentId = new Map(
      licenseLinks
        .filter((link) => link.componentTerritoryAssessmentId)
        .map((link) => [link.componentTerritoryAssessmentId as string, link.rightsLicense]),
    );

    const authorsCount = contributorsData.filter((c) => c['role'] === 'AUTHOR').length;
    const translatorsCount = contributorsData.filter((c) => c['role'] === 'TRANSLATOR').length;
    const narratorsCount = contributorsData.filter((c) => c['role'] === 'NARRATOR').length;
    const contributorsWithoutPersonCount = contributorsData.filter((c) => !c['personId']).length;

    return {
      id: profileId,
      rightsIntakeId: profile['rightsIntakeId'] as string,
      currentReviewImportId: (profile['currentReviewImportId'] as string) ?? null,
      status: profile['status'] as string,
      isCurrent: profile['isCurrent'] as boolean,
      overallStatus: profile['overallStatus'] as string,
      publicationGate: profile['publicationGate'] as string,
      confidence: profile['confidence'] as string,
      summaryRu: profile['summaryRu'] as string,
      conclusionRu: profile['conclusionRu'] as string,
      reasoningRu: (profile['reasoningRu'] as string) ?? null,
      nextReviewAt: profile['nextReviewAt']
        ? new Date(profile['nextReviewAt'] as string).toISOString()
        : null,
      sourceEdition: sourceEditionRecord
        ? this.mapSourceEdition(sourceEditionRecord, editionRightsRecords)
        : null,
      reviews: reviewsData.map((r: Record<string, unknown>) => this.mapReview(r)),
      territoryDecisions: territoryData.map((t: Record<string, unknown>) =>
        this.mapTerritoryDecision(t),
      ),
      regionalTerritorySummary:
        this.regionAggregationService.aggregateTerritoryDecisions(territoryData),
      components: componentsData.map((c: Record<string, unknown>) =>
        this.mapComponent(c, licensesByComponentId, licenseByAssessmentId),
      ),
      licenses: licenseMetrics.licenses,
      licenseCoverage,
      licensesCount: licenseMetrics.licensesCount,
      activeLicensesCount: licenseMetrics.activeLicensesCount,
      expiredLicensesCount: licenseMetrics.expiredLicensesCount,
      revokedLicensesCount: licenseMetrics.revokedLicensesCount,
      expiringSoonLicensesCount: licenseMetrics.expiringSoonLicensesCount,
      licenseRequiredCountriesCount: licenseCoverage.requiredCountryCodes.length,
      licenseCoveredCountriesCount: licenseCoverage.coveredCountryCodes.length,
      licenseUncoveredCountriesCount: licenseCoverage.uncoveredCountryCodes.length,
      evidence: evidenceData.map((e: Record<string, unknown>) => this.mapEvidence(e)),
      actions: actionsData.map((a: Record<string, unknown>) => this.mapAction(a)),
      contributors: contributorsData.map((c: Record<string, unknown>) => this.mapContributor(c)),
      contributorsCount: contributorsData.length,
      authorsCount,
      translatorsCount,
      narratorsCount,
      contributorsWithoutPersonCount,
      // Phase 19: снимок риска и юридического утверждения — прямо из загруженной записи.
      riskLevel: (profile['riskLevel'] as string) ?? undefined,
      riskFactors: Array.isArray(profile['riskFactors'])
        ? (profile['riskFactors'] as Record<string, unknown>[])
        : undefined,
      riskAssessedAt: profile['riskAssessedAt']
        ? new Date(profile['riskAssessedAt'] as string).toISOString()
        : null,
      lawyerReviewRequired: (profile['lawyerReviewRequired'] as boolean) ?? undefined,
      lawyerReviewBlocking: (profile['lawyerReviewBlocking'] as boolean) ?? undefined,
      currentLawyerReviewId: (profile['currentLawyerReviewId'] as string) ?? null,
      lawyerApprovedAt: profile['lawyerApprovedAt']
        ? new Date(profile['lawyerApprovedAt'] as string).toISOString()
        : null,
      lawyerApprovedLawyerName: (profile['lawyerApprovedLawyerName'] as string) ?? null,
      lawyerOpinionValidUntil: profile['lawyerOpinionValidUntil']
        ? new Date(profile['lawyerOpinionValidUntil'] as string).toISOString()
        : null,
      supersededAt: profile['supersededAt']
        ? new Date(profile['supersededAt'] as string).toISOString()
        : null,
      archivedAt: profile['archivedAt']
        ? new Date(profile['archivedAt'] as string).toISOString()
        : null,
      createdAt: new Date(profile['createdAt'] as string).toISOString(),
      updatedAt: new Date(profile['updatedAt'] as string).toISOString(),
    } as RightsProfileDetailDto;
  }

  private mapSourceEdition(
    record: Record<string, unknown>,
    editionRightsRecords: Array<Record<string, unknown>>,
  ) {
    return {
      id: record['id'] as string,
      rightsProfileId: record['rightsProfileId'] as string,
      provider: record['provider'] as string,
      externalId: (record['externalId'] as string) ?? null,
      sourceUrl: (record['sourceUrl'] as string) ?? null,
      sourceTitle: (record['sourceTitle'] as string) ?? null,
      sourceLanguage: (record['sourceLanguage'] as string) ?? null,
      sourceTextType: record['sourceTextType'] as string,
      gutenbergStatus: (record['gutenbergStatus'] as string) ?? null,
      status: record['status'] as string,
      notesRu: (record['notesRu'] as string) ?? null,
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
      editionRights: editionRightsRecords.map((r) => this.mapEditionRights(r)),
    };
  }

  private mapEditionRights(record: Record<string, unknown>) {
    return {
      id: record['id'] as string,
      sourceEditionId: record['sourceEditionId'] as string,
      languageCode: record['languageCode'] as string,
      status: record['status'] as string,
      notesRu: (record['notesRu'] as string) ?? null,
      legalBasisRu: (record['legalBasisRu'] as string) ?? null,
      translationOrigin: (record['translationOrigin'] as string) ?? 'UNKNOWN',
      translationSourceLanguage: (record['translationSourceLanguage'] as string) ?? null,
      requiresGeoBlock: (record['requiresGeoBlock'] as boolean) ?? false,
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
    };
  }

  private mapReview(record: Record<string, unknown>): RightsReviewDto {
    const approvedByUserRaw = record['approvedByUser'] as Record<string, unknown> | null;
    const rejectedByUserRaw = record['rejectedByUser'] as Record<string, unknown> | null;
    const approvalsRaw = record['approvals'] as Array<Record<string, unknown>> | null;

    return {
      id: record['id'] as string,
      rightsProfileId: record['rightsProfileId'] as string,
      rightsReviewImportId: record['rightsReviewImportId'] as string,
      status: record['status'] as string,
      schemaVersion: (record['schemaVersion'] as string | null) ?? null,
      reviewerType: record['reviewerType'] as string,
      overallStatus: record['overallStatus'] as string,
      publicationGate: record['publicationGate'] as string,
      confidence: record['confidence'] as string,
      summaryRu: record['summaryRu'] as string,
      conclusionRu: record['conclusionRu'] as string,
      reasoningRu: (record['reasoningRu'] as string | null) ?? null,
      nextReviewAt: record['nextReviewAt']
        ? new Date(record['nextReviewAt'] as string).toISOString()
        : null,
      // Phase 18: review history chain
      previousReviewId: (record['previousReviewId'] as string | null) ?? null,
      chainRootReviewId: (record['chainRootReviewId'] as string | null) ?? null,
      revisionNumber: (record['revisionNumber'] as number | null) ?? 1,
      approvedByUserId: (record['approvedByUserId'] as string | null) ?? null,
      approvedByUser: approvedByUserRaw
        ? {
            id: approvedByUserRaw['id'] as string,
            name: approvedByUserRaw['name'] as string | undefined,
            email: approvedByUserRaw['email'] as string,
          }
        : null,
      approvedAt: record['approvedAt']
        ? new Date(record['approvedAt'] as string).toISOString()
        : null,
      approvalNotesRu: (record['approvalNotesRu'] as string | null) ?? null,
      rejectedByUserId: (record['rejectedByUserId'] as string | null) ?? null,
      rejectedByUser: rejectedByUserRaw
        ? {
            id: rejectedByUserRaw['id'] as string,
            name: rejectedByUserRaw['name'] as string | undefined,
            email: rejectedByUserRaw['email'] as string,
          }
        : null,
      rejectedAt: record['rejectedAt']
        ? new Date(record['rejectedAt'] as string).toISOString()
        : null,
      rejectionReasonRu: (record['rejectionReasonRu'] as string | null) ?? null,
      approvals: approvalsRaw
        ? approvalsRaw.map((a) => {
            const decidedByUserRaw = a['decidedByUser'] as Record<string, unknown> | null;
            const dto: RightsReviewApprovalDto = {
              id: a['id'] as string,
              rightsReviewId: a['rightsReviewId'] as string,
              rightsProfileId: a['rightsProfileId'] as string,
              rightsIntakeId: a['rightsIntakeId'] as string,
              decision: a['decision'] as string,
              decidedByUser: decidedByUserRaw
                ? {
                    id: decidedByUserRaw['id'] as string,
                    name: decidedByUserRaw['name'] as string | undefined,
                    email: decidedByUserRaw['email'] as string,
                  }
                : null,
              notesRu: (a['notesRu'] as string | null) ?? null,
              createdAt: new Date(a['createdAt'] as string).toISOString(),
            };
            return dto;
          })
        : null,
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
    } as RightsReviewDto;
  }

  /**
   * Loads every license reachable from the profile: linked to the profile itself, to its
   * components, their per-country assessments, territory decisions or the source edition.
   */
  private async loadProfileLicenseLinks(rightsProfileId: string): Promise<ProfileLicenseLink[]> {
    const linkDelegate = (this.prisma as unknown as Record<string, unknown>)[
      'rightsLicenseLink'
    ] as {
      findMany: (args: Record<string, unknown>) => Promise<ProfileLicenseLink[]>;
    };

    return linkDelegate.findMany({
      where: {
        OR: [
          { rightsProfileId },
          { rightsComponent: { rightsProfileId } },
          { componentTerritoryAssessment: { rightsComponent: { rightsProfileId } } },
          { territoryDecision: { rightsProfileId } },
          { sourceEdition: { rightsProfileId } },
        ],
      },
      include: { rightsLicense: true },
    });
  }

  private buildLicenseMetrics(links: ProfileLicenseLink[]): {
    licenses: RightsLicenseSummaryDto[];
    licensesCount: number;
    activeLicensesCount: number;
    expiredLicensesCount: number;
    revokedLicensesCount: number;
    expiringSoonLicensesCount: number;
  } {
    const at = new Date();
    const uniqueLicenses = new Map<string, RightsLicenseRecord>();
    for (const link of links) {
      if (link.rightsLicense && !uniqueLicenses.has(link.rightsLicenseId)) {
        uniqueLicenses.set(link.rightsLicenseId, link.rightsLicense);
      }
    }

    const records = [...uniqueLicenses.values()];
    const licenses = records.map((license) => this.licensesService.mapSummary(license, at));

    return {
      licenses,
      licensesCount: licenses.length,
      activeLicensesCount: licenses.filter((l) => l.effectiveStatus === RightsLicenseStatus.ACTIVE)
        .length,
      expiredLicensesCount: licenses.filter(
        (l) => l.effectiveStatus === RightsLicenseStatus.EXPIRED,
      ).length,
      revokedLicensesCount: licenses.filter(
        (l) => l.effectiveStatus === RightsLicenseStatus.REVOKED,
      ).length,
      expiringSoonLicensesCount: records.filter((license) => {
        if (license.isPerpetual || !license.expiresAt) return false;
        if (!this.licenseCoverageService.isActiveAt(license, at)) return false;
        const daysLeft = (license.expiresAt.getTime() - at.getTime()) / MS_PER_DAY;
        return daysLeft >= 0 && daysLeft <= EXPIRING_SOON_DAYS;
      }).length,
    };
  }

  /**
   * A license counts for a component when it is linked to the component itself or to any
   * of the component's per-country assessments.
   */
  private groupLicensesByComponent(
    links: ProfileLicenseLink[],
    componentsData: Array<Record<string, unknown>>,
  ): Map<string, RightsLicenseSummaryDto[]> {
    const at = new Date();
    const assessmentToComponent = new Map<string, string>();
    for (const component of componentsData) {
      const assessments = component['territoryAssessments'];
      if (!Array.isArray(assessments)) continue;
      for (const assessment of assessments as Array<Record<string, unknown>>) {
        assessmentToComponent.set(assessment['id'] as string, component['id'] as string);
      }
    }

    const byComponent = new Map<string, Map<string, RightsLicenseRecord>>();
    for (const link of links) {
      if (!link.rightsLicense) continue;
      const componentId =
        link.rightsComponentId ??
        (link.componentTerritoryAssessmentId
          ? assessmentToComponent.get(link.componentTerritoryAssessmentId)
          : undefined);
      if (!componentId) continue;

      const bucket = byComponent.get(componentId) ?? new Map<string, RightsLicenseRecord>();
      bucket.set(link.rightsLicenseId, link.rightsLicense);
      byComponent.set(componentId, bucket);
    }

    return new Map(
      [...byComponent.entries()].map(([componentId, bucket]) => [
        componentId,
        [...bucket.values()].map((license) => this.licensesService.mapSummary(license, at)),
      ]),
    );
  }

  private mapComponent(
    record: Record<string, unknown>,
    licensesByComponentId: Map<string, RightsLicenseSummaryDto[]> = new Map(),
    licenseByAssessmentId: Map<string, RightsLicenseRecord> = new Map(),
  ) {
    return {
      id: record['id'],
      rightsProfileId: record['rightsProfileId'],
      componentType: record['componentType'],
      titleRu: record['titleRu'],
      languageCode: (record['languageCode'] as string | null) ?? null,
      status: record['status'],
      requiredAction: record['requiredAction'],
      confidence: record['confidence'],
      notesRu: record['notesRu'] ?? null,
      licenses: licensesByComponentId.get(record['id'] as string) ?? [],
      territoryAssessments: Array.isArray(record['territoryAssessments'])
        ? (record['territoryAssessments'] as Array<Record<string, unknown>>).map((assessment) =>
            this.mapComponentTerritoryAssessment(assessment, licenseByAssessmentId),
          )
        : [],
      contributors: Array.isArray(record['contributors'])
        ? (record['contributors'] as Array<Record<string, unknown>>).map((contributor) =>
            this.mapContributor(contributor),
          )
        : [],
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
    };
  }

  private mapContributor(record: Record<string, unknown>) {
    const personRaw = record['person'] as Record<string, unknown> | null;
    return {
      id: record['id'] as string,
      rightsProfileId: record['rightsProfileId'] as string,
      rightsComponentId: (record['rightsComponentId'] as string) ?? null,
      personId: (record['personId'] as string) ?? null,
      role: record['role'] as string,
      roleOtherRu: (record['roleOtherRu'] as string) ?? null,
      displayName: record['displayName'] as string,
      canonicalName: (record['canonicalName'] as string) ?? null,
      creditedName: (record['creditedName'] as string) ?? null,
      birthYear: (record['birthYear'] as number) ?? null,
      deathYear: (record['deathYear'] as number) ?? null,
      nationalityCountryCode: (record['nationalityCountryCode'] as string) ?? null,
      wikidataId: (record['wikidataId'] as string) ?? null,
      viafId: (record['viafId'] as string) ?? null,
      isni: (record['isni'] as string) ?? null,
      gutenbergAgentId: (record['gutenbergAgentId'] as string) ?? null,
      creditedLanguage: (record['creditedLanguage'] as string) ?? null,
      sourceEvidenceIds: Array.isArray(record['sourceEvidenceIds'])
        ? (record['sourceEvidenceIds'] as string[])
        : null,
      publicDomainFromYear: (record['publicDomainFromYear'] as number) ?? null,
      confidence: (record['confidence'] as string) ?? null,
      notesRu: (record['notesRu'] as string) ?? null,
      person: personRaw
        ? {
            id: personRaw['id'] as string,
            type: personRaw['type'] as string,
            canonicalName: personRaw['canonicalName'] as string,
            sortName: (personRaw['sortName'] as string) ?? null,
            slug: (personRaw['slug'] as string) ?? null,
            birthYear: (personRaw['birthYear'] as number) ?? null,
            deathYear: (personRaw['deathYear'] as number) ?? null,
            nationalityCountryCode: (personRaw['nationalityCountryCode'] as string) ?? null,
            wikidataId: (personRaw['wikidataId'] as string) ?? null,
            viafId: (personRaw['viafId'] as string) ?? null,
            isni: (personRaw['isni'] as string) ?? null,
            gutenbergAgentId: (personRaw['gutenbergAgentId'] as string) ?? null,
          }
        : null,
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
    };
  }

  private mapComponentTerritoryAssessment(
    record: Record<string, unknown>,
    licenseByAssessmentId: Map<string, RightsLicenseRecord> = new Map(),
  ) {
    const license = licenseByAssessmentId.get(record['id'] as string) ?? null;
    return {
      id: record['id'],
      rightsComponentId: record['rightsComponentId'],
      licenseId: license ? license.id : null,
      licenseTitle: license ? license.title : null,
      countryCode: record['countryCode'],
      status: record['status'],
      accessPolicy: record['accessPolicy'],
      geoBlockRequired: record['geoBlockRequired'],
      reasonRu: record['reasonRu'] ?? null,
      legalBasisRu: record['legalBasisRu'] ?? null,
      publicDomainFromYear: record['publicDomainFromYear'] ?? null,
      rightsExpireAt: record['rightsExpireAt']
        ? new Date(record['rightsExpireAt'] as string).toISOString()
        : null,
      sourceEvidenceIds: Array.isArray(record['sourceEvidenceIds'])
        ? (record['sourceEvidenceIds'] as string[])
        : null,
      confidence: record['confidence'] ?? null,
      notesRu: record['notesRu'] ?? null,
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
    };
  }

  private mapTerritoryDecision(record: Record<string, unknown>) {
    return {
      id: record['id'],
      rightsProfileId: record['rightsProfileId'],
      countryCode: record['countryCode'],
      finalStatus: record['finalStatus'],
      accessPolicy: record['accessPolicy'],
      geoBlockRequired: record['geoBlockRequired'],
      geoBlockScope: record['geoBlockScope'] ?? null,
      reasonRu: record['reasonRu'],
      legalBasisRu: record['legalBasisRu'] ?? null,
      confidence: record['confidence'],
      nextReviewAt: record['nextReviewAt']
        ? new Date(record['nextReviewAt'] as string).toISOString()
        : null,
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
    };
  }

  private mapEvidence(record: Record<string, unknown>) {
    return {
      id: record['id'],
      rightsProfileId: record['rightsProfileId'],
      evidenceType: record['evidenceType'],
      sourceLevel: record['sourceLevel'],
      title: record['title'],
      authority: record['authority'],
      url: record['url'] ?? null,
      jurisdictionCode: record['jurisdictionCode'] ?? null,
      accessedAt: record['accessedAt']
        ? new Date(record['accessedAt'] as string).toISOString()
        : null,
      relevantExcerpt: record['relevantExcerpt'] ?? null,
      summaryRu: record['summaryRu'],
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
    };
  }

  private mapAction(record: Record<string, unknown>) {
    return mapRightsAction(record);
  }
}
