import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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

import { PersonResolverService } from '../persons/person-resolver.service';
import { ContributorRole } from '../persons/person-interface';
import { RightsConfidence, Prisma } from '@prisma/client';

type NormalizedContributorConfidence = RightsConfidence | null;

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

@Injectable()
export class RightsMaterializationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly componentTerritoryAggregationService: ComponentTerritoryAggregationService,
    private readonly personResolverService: PersonResolverService,
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

  async materializeFromImport(importId: string) {
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

      await rrTx.create({
        data: {
          rightsProfileId: profile['id'] as string,
          rightsReviewImportId: importId,
          status: 'HUMAN_REVIEW_REQUIRED',
          schemaVersion: reportJson['schemaVersion'] as string,
          overallStatus: reportJson['overallStatus'] as string,
          publicationGate: reportJson['publicationGate'] as string,
          confidence: reportJson['confidence'] as string,
          summaryRu: reportJson['summaryRu'] as string,
          conclusionRu: reportJson['conclusionRu'] as string,
          reasoningRu: (reportJson['reasoningRu'] as string) ?? null,
          nextReviewAt: this.parseDateOrNull(reportJson['nextReviewAt']),
        },
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
          },
        });

        await erTx.create({
          data: {
            sourceEditionId: sourceEdition['id'] as string,
            status: sourceAssessment['status'] as string,
            notesRu: (sourceAssessment['notesRu'] as string) ?? null,
          },
        });
      }

      const aggregationComponents: ComponentTerritoryAggregationComponent[] = [];
      const createdComponentMap = new Map<string, string>();
      let hasComponentTerritoryAssessments = false;
      if (componentAssessments && componentAssessments.length > 0) {
        for (let idx = 0; idx < componentAssessments.length; idx++) {
          const component = componentAssessments[idx];
          const createdComponent = await rcTx.create({
            data: {
              rightsProfileId: profile['id'] as string,
              componentType: component['componentType'] as string,
              titleRu: component['titleRu'] as string,
              status: component['status'] as string,
              requiredAction: component['requiredAction'] as string,
              confidence: component['confidence'] as string,
              notesRu: (component['notesRu'] as string) ?? null,
            },
          });
          createdComponentMap.set(`comp-${idx}`, createdComponent['id'] as string);

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

            await ctaTx.create({
              data: {
                rightsComponentId: createdComponent['id'] as string,
                ...normalizedAssessment,
              },
            });
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

      const existingTerritoryDecisions = this.mapExistingTerritoryDecisions(territoryDecisions);
      const decisionsToCreate = hasComponentTerritoryAssessments
        ? this.componentTerritoryAggregationService.aggregateTerritoryDecisionsFromComponents({
            rightsProfileId: profile['id'] as string,
            components: aggregationComponents,
            targetCountryCodes: Array.isArray(intake.targetCountryCodes)
              ? (intake.targetCountryCodes as string[])
              : [],
            existingTerritoryDecisions,
          })
        : existingTerritoryDecisions.map((territory) => ({
            rightsProfileId: profile['id'] as string,
            ...territory,
          }));

      if (decisionsToCreate.length > 0) {
        for (const territory of decisionsToCreate) {
          await tdTx.create({
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
        }
      }

      if (evidence && evidence.length > 0) {
        for (const ev of evidence) {
          await reTx.create({
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
        }
      }

      if (requiredActions && requiredActions.length > 0) {
        for (const action of requiredActions) {
          const suggestedStatus = action['suggestedStatus'] as string | undefined;
          const validStatuses = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'WAIVED', 'CANCELLED'];
          const finalStatus =
            suggestedStatus && validStatuses.includes(suggestedStatus)
              ? suggestedStatus
              : 'PENDING';

          await raTx.create({
            data: {
              rightsProfileId: profile['id'] as string,
              actionType: action['actionType'] as string,
              status: finalStatus,
              descriptionRu: action['descriptionRu'] as string,
              affectedCountryCodes: (action['affectedCountryCodes'] as unknown[]) ?? [],
              isBlocking: (action['isBlocking'] as boolean) ?? false,
            },
          });
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

  private mapExistingTerritoryDecisions(
    territoryDecisions: Array<Record<string, unknown>> | undefined,
  ): ExistingTerritoryDecisionInput[] {
    return (territoryDecisions ?? []).map((territory) => ({
      countryCode: territory['countryCode'] as string,
      finalStatus: territory['finalStatus'] as ComponentTerritoryFinalStatus,
      accessPolicy: territory['accessPolicy'] as ComponentTerritoryAccessPolicy,
      geoBlockRequired: (territory['geoBlockRequired'] as boolean) ?? false,
      geoBlockScope: (territory['geoBlockScope'] as string) ?? null,
      reasonRu: territory['reasonRu'] as string,
      legalBasisRu: (territory['legalBasisRu'] as string) ?? null,
      confidence: territory['confidence'] as ComponentTerritoryConfidence,
      nextReviewAt: this.parseDateOrNull(territory['nextReviewAt']),
    }));
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
