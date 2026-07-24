import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  RightsProfileDetailDto,
  RightsProfileSummaryDto,
} from './dto/rights-profile-response.dto';

@Injectable()
export class RightsProfileService {
  constructor(private readonly prisma: PrismaService) {}

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

    const reviews = (await (this.prisma as unknown as Record<string, unknown>)['rightsReview']) as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const reviewsData = await reviews.findMany({
      where: { rightsProfileId: profileId },
    });

    const components = (await (this.prisma as unknown as Record<string, unknown>)[
      'rightsComponent'
    ]) as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const componentsData = await components.findMany({
      where: { rightsProfileId: profileId },
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
      sourceEdition: sourceEditionRecord ? this.mapSourceEdition(sourceEditionRecord) : null,
      reviews: reviewsData.map((r: Record<string, unknown>) => this.mapReview(r)),
      territoryDecisions: territoryData.map((t: Record<string, unknown>) =>
        this.mapTerritoryDecision(t),
      ),
      components: componentsData.map((c: Record<string, unknown>) => this.mapComponent(c)),
      evidence: evidenceData.map((e: Record<string, unknown>) => this.mapEvidence(e)),
      actions: actionsData.map((a: Record<string, unknown>) => this.mapAction(a)),
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

  private mapSourceEdition(record: Record<string, unknown>) {
    return {
      id: record['id'],
      rightsProfileId: record['rightsProfileId'],
      provider: record['provider'],
      externalId: record['externalId'] ?? null,
      sourceUrl: record['sourceUrl'] ?? null,
      sourceTitle: record['sourceTitle'] ?? null,
      sourceLanguage: record['sourceLanguage'] ?? null,
      sourceTextType: record['sourceTextType'],
      gutenbergStatus: record['gutenbergStatus'] ?? null,
      status: record['status'],
      notesRu: record['notesRu'] ?? null,
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
    };
  }

  private mapReview(record: Record<string, unknown>) {
    return {
      id: record['id'],
      rightsProfileId: record['rightsProfileId'],
      rightsReviewImportId: record['rightsReviewImportId'],
      status: record['status'],
      schemaVersion: record['schemaVersion'] ?? null,
      reviewerType: record['reviewerType'],
      overallStatus: record['overallStatus'],
      publicationGate: record['publicationGate'],
      confidence: record['confidence'],
      summaryRu: record['summaryRu'],
      conclusionRu: record['conclusionRu'],
      reasoningRu: record['reasoningRu'] ?? null,
      nextReviewAt: record['nextReviewAt']
        ? new Date(record['nextReviewAt'] as string).toISOString()
        : null,
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
    };
  }

  private mapComponent(record: Record<string, unknown>) {
    return {
      id: record['id'],
      rightsProfileId: record['rightsProfileId'],
      componentType: record['componentType'],
      titleRu: record['titleRu'],
      status: record['status'],
      requiredAction: record['requiredAction'],
      confidence: record['confidence'],
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
    return {
      id: record['id'],
      rightsProfileId: record['rightsProfileId'],
      actionType: record['actionType'],
      status: record['status'],
      descriptionRu: record['descriptionRu'],
      affectedCountryCodes: record['affectedCountryCodes'],
      isBlocking: record['isBlocking'],
      createdAt: new Date(record['createdAt'] as string).toISOString(),
      updatedAt: new Date(record['updatedAt'] as string).toISOString(),
    };
  }
}
