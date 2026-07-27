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
import { RightsConfidence, Prisma } from '@prisma/client';

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

        if (Array.isArray(sourceAssessment['contributors'])) {
          await this.materializeContributorsForSourceEdition(
            t,
            sourceEdition['id'] as string,
            sourceAssessment['contributors'] as Array<Record<string, unknown>>,
          );
        }
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

          if (Array.isArray(component['contributors'])) {
            await this.materializeContributorsForComponent(
              t,
              createdComponent['id'] as string,
              component['contributors'] as Array<Record<string, unknown>>,
            );
          }

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

  private async materializeContributorsForSourceEdition(
    tx: Record<string, unknown>,
    sourceEditionId: string,
    contributorsRaw: Array<Record<string, unknown>>,
  ) {
    const cTx = tx['contributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
    const secTx = tx['sourceEditionContributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    for (const c of contributorsRaw) {
      if (!c['displayName']) continue;
      let contributor = await cTx.findFirst({
        where: { displayName: c['displayName'] as string },
      });
      if (!contributor) {
        contributor = await cTx.create({
          data: {
            displayName: c['displayName'] as string,
            originalName: (c['originalName'] as string) ?? null,
            birthYear: typeof c['birthYear'] === 'number' ? c['birthYear'] : null,
            deathYear: typeof c['deathYear'] === 'number' ? c['deathYear'] : null,
            nationalityCountry: (c['nationalityCountry'] as string) ?? null,
            pseudonym: (c['pseudonym'] as string) ?? null,
            viafId: (c['viafId'] as string) ?? null,
            locAuthorityId: (c['locAuthorityId'] as string) ?? null,
            identityConfidence: (c['identityConfidence'] as string) ?? 'CONFIRMED',
            notesRu: (c['notesRu'] as string) ?? null,
          },
        });
      }

      await secTx.create({
        data: {
          sourceEditionId,
          contributorId: contributor['id'] as string,
          role: (c['role'] as string) ?? 'AUTHOR',
          creditedName: (c['creditedName'] as string) ?? null,
          notesRu: (c['notesRu'] as string) ?? null,
        },
      });
    }
  }

  private async materializeContributorsForComponent(
    tx: Record<string, unknown>,
    rightsComponentId: string,
    contributorsRaw: Array<Record<string, unknown>>,
  ) {
    const cTx = tx['contributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
    const rccTx = tx['rightsComponentContributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    for (const c of contributorsRaw) {
      if (!c['displayName']) continue;
      let contributor = await cTx.findFirst({
        where: { displayName: c['displayName'] as string },
      });
      if (!contributor) {
        contributor = await cTx.create({
          data: {
            displayName: c['displayName'] as string,
            originalName: (c['originalName'] as string) ?? null,
            birthYear: typeof c['birthYear'] === 'number' ? c['birthYear'] : null,
            deathYear: typeof c['deathYear'] === 'number' ? c['deathYear'] : null,
            nationalityCountry: (c['nationalityCountry'] as string) ?? null,
            pseudonym: (c['pseudonym'] as string) ?? null,
            viafId: (c['viafId'] as string) ?? null,
            locAuthorityId: (c['locAuthorityId'] as string) ?? null,
            identityConfidence: (c['identityConfidence'] as string) ?? 'CONFIRMED',
            notesRu: (c['notesRu'] as string) ?? null,
          },
        });
      }

      await rccTx.create({
        data: {
          rightsComponentId,
          contributorId: contributor['id'] as string,
          role: (c['role'] as string) ?? 'AUTHOR',
          creditedName: (c['creditedName'] as string) ?? null,
          notesRu: (c['notesRu'] as string) ?? null,
        },
      });
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

    const rawContributors = reportJson['contributors'] as
      | Array<Record<string, unknown>>
      | undefined;
    const componentAssessments = reportJson['componentAssessments'] as
      | Array<Record<string, unknown>>
      | undefined;

    const keyToContributorRecord = new Map<string, { id: string; personId: string | null }>();

    if (Array.isArray(rawContributors) && rawContributors.length > 0) {
      for (const c of rawContributors) {
        const key = (c['key'] as string) || `c-${Math.random()}`;
        const displayName =
          (c['displayName'] as string) || (c['canonicalName'] as string) || 'Unknown';
        const canonicalName = (c['canonicalName'] as string) || displayName;

        let personId: string | null = null;
        try {
          const person = await this.personResolverService.resolveOrCreatePerson({
            displayName,
            canonicalName,
            birthYear: typeof c['birthYear'] === 'number' ? c['birthYear'] : null,
            deathYear: typeof c['deathYear'] === 'number' ? c['deathYear'] : null,
            nationalityCountryCode: (c['nationalityCountryCode'] as string) || null,
            publicDomainFromYear:
              typeof c['publicDomainFromYear'] === 'number' ? c['publicDomainFromYear'] : null,
            wikidataId: (c['wikidataId'] as string) || null,
            viafId: (c['viafId'] as string) || null,
            isni: (c['isni'] as string) || null,
            gutenbergAgentId: (c['gutenbergAgentId'] as string) || null,
            notesRu: (c['notesRu'] as string) || null,
          });
          personId = person.id;
        } catch {
          // Keep null if resolution fails
        }

        const rpc = await rpcModel.create({
          data: {
            rightsProfileId,
            personId,
            role: (c['role'] as string) || 'AUTHOR',
            roleOtherRu: (c['roleOtherRu'] as string) || null,
            displayName,
            canonicalName,
            creditedName: (c['creditedName'] as string) || null,
            birthYear: typeof c['birthYear'] === 'number' ? c['birthYear'] : null,
            deathYear: typeof c['deathYear'] === 'number' ? c['deathYear'] : null,
            nationalityCountryCode: (c['nationalityCountryCode'] as string) || null,
            wikidataId: (c['wikidataId'] as string) || null,
            viafId: (c['viafId'] as string) || null,
            isni: (c['isni'] as string) || null,
            gutenbergAgentId: (c['gutenbergAgentId'] as string) || null,
            publicDomainFromYear:
              typeof c['publicDomainFromYear'] === 'number' ? c['publicDomainFromYear'] : null,
            sourceEvidenceIds: Array.isArray(c['sourceEvidenceIds'])
              ? c['sourceEvidenceIds']
              : null,
            confidence: (c['confidence'] as RightsConfidence) || null,
            notesRu: (c['notesRu'] as string) || null,
          },
        });

        const rpcId = rpc['id'] as string;
        keyToContributorRecord.set(key, { id: rpcId, personId });
      }

      if (Array.isArray(componentAssessments)) {
        for (let i = 0; i < componentAssessments.length; i++) {
          const ca = componentAssessments[i];
          const componentId = createdComponentMap.get(`comp-${i}`);
          if (!componentId) continue;

          const refs = ca['contributorRefs'] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(refs)) {
            for (const ref of refs) {
              const contributorKey = ref['contributorKey'] as string;
              const rec = keyToContributorRecord.get(contributorKey);
              if (rec) {
                await rpcModel.update({
                  where: { id: rec.id },
                  data: { rightsComponentId: componentId },
                });
              }
            }
          }
        }
      }
    } else if (intakeCandidateAuthor && intakeCandidateAuthor.trim()) {
      let personId: string | null = null;
      try {
        const person = await this.personResolverService.resolveOrCreatePerson({
          displayName: intakeCandidateAuthor.trim(),
          canonicalName: intakeCandidateAuthor.trim(),
        });
        personId = person.id;
      } catch {
        // Keep null
      }

      await rpcModel.create({
        data: {
          rightsProfileId,
          personId,
          role: 'AUTHOR',
          displayName: intakeCandidateAuthor.trim(),
          canonicalName: intakeCandidateAuthor.trim(),
        },
      });
    }
  }
}
