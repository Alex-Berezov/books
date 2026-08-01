import { Injectable } from '@nestjs/common';
import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';

export type ComponentTerritoryAccessPolicy = 'ALLOW' | 'BLOCK' | 'REVIEW_REQUIRED';
export type ComponentTerritoryConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type ComponentTerritoryFinalStatus =
  | 'ALLOWED'
  | 'ALLOWED_AFTER_CHANGES'
  | 'ALLOWED_BY_LICENSE'
  | 'BLOCKED'
  | 'LICENSE_REQUIRED'
  | 'PENDING_REVIEW'
  | 'NOT_CHECKED'
  | 'NOT_TARGETED';

export interface ComponentTerritoryAssessmentInput {
  countryCode: string;
  status: ComponentTerritoryFinalStatus;
  accessPolicy: ComponentTerritoryAccessPolicy;
  geoBlockRequired: boolean;
  reasonRu?: string | null;
  legalBasisRu?: string | null;
  confidence?: ComponentTerritoryConfidence | null;
  rightsExpireAt?: Date | null;
}

export interface ComponentTerritoryAggregationComponent {
  rightsComponentId: string;
  componentType: string;
  titleRu: string;
  status: string;
  requiredAction: string;
  confidence: ComponentTerritoryConfidence;
  territoryAssessments: ComponentTerritoryAssessmentInput[];
}

export interface ExistingTerritoryDecisionInput {
  countryCode: string;
  finalStatus: ComponentTerritoryFinalStatus;
  accessPolicy: ComponentTerritoryAccessPolicy;
  geoBlockRequired: boolean;
  geoBlockScope?: string | null;
  reasonRu: string;
  legalBasisRu?: string | null;
  confidence: ComponentTerritoryConfidence;
  nextReviewAt?: Date | null;
}

export interface AggregatedTerritoryDecision {
  rightsProfileId: string;
  countryCode: string;
  finalStatus: ComponentTerritoryFinalStatus;
  accessPolicy: ComponentTerritoryAccessPolicy;
  geoBlockRequired: boolean;
  geoBlockScope: GeoBlockScope | null;
  reasonRu: string;
  legalBasisRu: string | null;
  confidence: ComponentTerritoryConfidence;
  nextReviewAt: Date | null;
}

export interface ComponentTerritoryAggregationInput {
  rightsProfileId: string;
  components: ComponentTerritoryAggregationComponent[];
  targetCountryCodes?: string[];
  existingTerritoryDecisions?: ExistingTerritoryDecisionInput[];
  now?: Date;
}

interface ProblematicComponent {
  component: ComponentTerritoryAggregationComponent;
  assessment: ComponentTerritoryAssessmentInput | null;
  reason: string;
}

const CONFIDENCE_RANK: Record<ComponentTerritoryConfidence, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
};

@Injectable()
export class ComponentTerritoryAggregationService {
  aggregateTerritoryDecisionsFromComponents(
    input: ComponentTerritoryAggregationInput,
  ): AggregatedTerritoryDecision[] {
    const countries = this.collectCountries(input);
    const existingByCountry = new Map(
      (input.existingTerritoryDecisions ?? []).map((decision) => [
        decision.countryCode.toUpperCase(),
        decision,
      ]),
    );
    const now = input.now ?? new Date();

    return countries.map((countryCode) => {
      const componentDecision = this.aggregateCountry(input, countryCode, now);
      return this.applyProfileOverride(
        componentDecision,
        existingByCountry.get(countryCode),
        input.rightsProfileId,
      );
    });
  }

  private collectCountries(input: ComponentTerritoryAggregationInput): string[] {
    const countries = new Set<string>();

    for (const countryCode of input.targetCountryCodes ?? []) {
      countries.add(countryCode.toUpperCase());
    }
    for (const decision of input.existingTerritoryDecisions ?? []) {
      countries.add(decision.countryCode.toUpperCase());
    }
    for (const component of input.components) {
      for (const assessment of component.territoryAssessments) {
        countries.add(assessment.countryCode.toUpperCase());
      }
    }

    return [...countries].sort();
  }

  private aggregateCountry(
    input: ComponentTerritoryAggregationInput,
    countryCode: string,
    now: Date,
  ): AggregatedTerritoryDecision {
    const applicableComponents = input.components.filter(
      (component) => component.status !== 'EXCLUDED' && component.requiredAction !== 'REMOVE',
    );
    const assessments = applicableComponents
      .map((component) => ({
        component,
        assessment:
          component.territoryAssessments.find(
            (assessment) => assessment.countryCode.toUpperCase() === countryCode,
          ) ?? null,
      }))
      .filter(
        (
          item,
        ): item is {
          component: ComponentTerritoryAggregationComponent;
          assessment: ComponentTerritoryAssessmentInput;
        } => item.assessment !== null,
      );

    const blockers = assessments.filter(({ assessment }) => assessment.accessPolicy === 'BLOCK');
    if (blockers.length > 0) {
      return this.createBlockedDecision(input.rightsProfileId, countryCode, blockers);
    }

    const problems: ProblematicComponent[] = [];
    for (const { component, assessment } of assessments) {
      if (assessment.accessPolicy === 'REVIEW_REQUIRED') {
        problems.push({
          component,
          assessment,
          reason: assessment.reasonRu ?? 'Требуется дополнительная проверка.',
        });
      } else if (
        assessment.rightsExpireAt &&
        assessment.rightsExpireAt.getTime() <= now.getTime()
      ) {
        problems.push({
          component,
          assessment,
          reason: 'Срок указанных прав или лицензии истёк.',
        });
      }
    }

    for (const component of applicableComponents) {
      const hasAssessment = assessments.some(
        (item) => item.component.rightsComponentId === component.rightsComponentId,
      );
      if (!hasAssessment) {
        problems.push({
          component,
          assessment: null,
          reason: `Нет компонентной оценки для «${component.titleRu}».`,
        });
      }
    }

    if (problems.length > 0) {
      return this.createReviewDecision(input.rightsProfileId, countryCode, problems);
    }

    // Phase 15: a country cleared only thanks to a license is reported as such, so the
    // editor sees that publication there depends on the license staying valid.
    const licensed = assessments.filter(
      ({ assessment }) => assessment.status === 'ALLOWED_BY_LICENSE',
    );
    const licensedTitles = licensed.map(({ component }) => `«${component.titleRu}»`).join(', ');

    return {
      rightsProfileId: input.rightsProfileId,
      countryCode,
      finalStatus: licensed.length > 0 ? 'ALLOWED_BY_LICENSE' : 'ALLOWED',
      accessPolicy: 'ALLOW',
      geoBlockRequired: false,
      geoBlockScope: null,
      reasonRu:
        licensed.length > 0
          ? `Публикация разрешена на основании лицензии. Лицензированные компоненты: ${licensedTitles}.`
          : `Все проверенные компоненты разрешены для страны ${countryCode}.`,
      legalBasisRu: this.joinUnique(licensed.map(({ assessment }) => assessment.legalBasisRu)),
      confidence: this.getMinimumConfidence(
        assessments.map(
          ({ component, assessment }) => assessment.confidence ?? component.confidence,
        ),
      ),
      nextReviewAt: null,
    };
  }

  private createBlockedDecision(
    rightsProfileId: string,
    countryCode: string,
    blockers: Array<{
      component: ComponentTerritoryAggregationComponent;
      assessment: ComponentTerritoryAssessmentInput;
    }>,
  ): AggregatedTerritoryDecision {
    const titles = blockers.map(({ component }) => `«${component.titleRu}»`).join(', ');
    const legalBasisRu = this.joinUnique(blockers.map(({ assessment }) => assessment.legalBasisRu));

    return {
      rightsProfileId,
      countryCode,
      finalStatus: 'BLOCKED',
      accessPolicy: 'BLOCK',
      geoBlockRequired: true,
      // WP-3.2: the verdict for the country is `BLOCK`, so the block covers the whole edition.
      // Narrowing the scope to the blocking component's type left the audio edition of a text
      // forbidden in that country fully reachable, while the gate and the admin UI both reported
      // the market as closed (R6-01). Which components caused it stays in `reasonRu`.
      geoBlockScope: GeoBlockScope.LANGUAGE_EDITION,
      reasonRu: `Блокирующие компоненты: ${titles}.`,
      legalBasisRu,
      confidence: this.getMinimumConfidence(
        blockers.map(({ component, assessment }) => assessment.confidence ?? component.confidence),
      ),
      nextReviewAt: null,
    };
  }

  private createReviewDecision(
    rightsProfileId: string,
    countryCode: string,
    problems: ProblematicComponent[],
  ): AggregatedTerritoryDecision {
    const reasonRu = problems
      .map(({ component, reason }) => `«${component.titleRu}»: ${reason}`)
      .join(' ');
    const legalBasisRu = this.joinUnique(
      problems.map(({ assessment }) => assessment?.legalBasisRu),
    );
    const geoBlockRequired = problems.some(
      ({ assessment }) => assessment?.geoBlockRequired === true,
    );

    return {
      rightsProfileId,
      countryCode,
      finalStatus: 'PENDING_REVIEW',
      accessPolicy: 'REVIEW_REQUIRED',
      geoBlockRequired,
      geoBlockScope: geoBlockRequired ? GeoBlockScope.LANGUAGE_EDITION : null,
      reasonRu,
      legalBasisRu,
      confidence: this.getMinimumConfidence(
        problems.map(({ component, assessment }) => assessment?.confidence ?? component.confidence),
      ),
      nextReviewAt: null,
    };
  }

  private applyProfileOverride(
    componentDecision: AggregatedTerritoryDecision,
    existingDecision: ExistingTerritoryDecisionInput | undefined,
    rightsProfileId: string,
  ): AggregatedTerritoryDecision {
    if (!existingDecision) {
      return componentDecision;
    }

    const componentRank = this.getPolicyRank(componentDecision.accessPolicy);
    const existingRank = this.getPolicyRank(existingDecision.accessPolicy);
    if (componentRank >= existingRank) {
      return componentDecision;
    }

    return {
      rightsProfileId,
      countryCode: existingDecision.countryCode.toUpperCase(),
      finalStatus: existingDecision.finalStatus,
      accessPolicy: existingDecision.accessPolicy,
      geoBlockRequired: existingDecision.geoBlockRequired,
      geoBlockScope: this.normalizeScope(existingDecision.geoBlockScope),
      reasonRu: `Profile-level override: ${existingDecision.reasonRu}`,
      legalBasisRu: existingDecision.legalBasisRu ?? null,
      confidence: existingDecision.confidence,
      nextReviewAt: existingDecision.nextReviewAt ?? null,
    };
  }

  private getPolicyRank(accessPolicy: ComponentTerritoryAccessPolicy): number {
    if (accessPolicy === 'BLOCK') return 2;
    if (accessPolicy === 'REVIEW_REQUIRED') return 1;
    return 0;
  }

  private normalizeScope(scope: string | null | undefined): GeoBlockScope | null {
    if (!scope) return null;
    if (Object.values(GeoBlockScope).includes(scope as GeoBlockScope)) {
      return scope as GeoBlockScope;
    }
    return GeoBlockScope.LANGUAGE_EDITION;
  }

  private getMinimumConfidence(
    confidences: ComponentTerritoryConfidence[],
  ): ComponentTerritoryConfidence {
    if (confidences.length === 0) return 'LOW';
    return confidences.reduce((minimum, confidence) =>
      CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[minimum] ? confidence : minimum,
    );
  }

  private joinUnique(values: Array<string | null | undefined>): string | null {
    const uniqueValues = [...new Set(values.filter((value): value is string => Boolean(value)))];
    return uniqueValues.length > 0 ? uniqueValues.join('\n') : null;
  }
}
