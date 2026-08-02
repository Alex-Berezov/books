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
  /**
   * WP-G.2 × WP-B.3: `reasonRu` и `confidence` — колонки `NOT NULL` (инцидент R4-01), поэтому
   * отсутствующие значения заполняются дефолтом приложения ещё до агрегации. Заполнитель — не
   * обоснование, поэтому источник каждого поля отмечается отдельно: `false` — значение
   * подставлено приложением, `true`/`undefined` — прислано агентом.
   */
  reasonRuFromAgent?: boolean;
  confidenceFromAgent?: boolean;
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
  /**
   * WP-B.2: решение выведено **только** из того, что часть компонентов не оценена по этой
   * стране, — ни одного собственного вердикта «на проверку» в оценках нет. Такой признак
   * нужен `applyProfileOverride`: пустота не должна затирать явное решение агента.
   */
  derivedFromMissingAssessment?: boolean;
}

export interface ComponentTerritoryAggregationInput {
  rightsProfileId: string;
  components: ComponentTerritoryAggregationComponent[];
  targetCountryCodes?: string[];
  existingTerritoryDecisions?: ExistingTerritoryDecisionInput[];
  /**
   * WP-5.5: подтверждено ли, что компоненты, помеченные к удалению, действительно убраны
   * из издания. Пока подтверждения нет, такой компонент участвует в оценке страны наравне
   * с остальными — правовой вердикт не может опираться на обещание (R6-06). Подтверждением
   * служит закрытие всех действий на удаление (`areComponentRemovalsConfirmed`).
   */
  componentRemovalsConfirmed?: boolean;
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
    const { targeted, extra } = this.collectCountries(input);
    const existingByCountry = new Map(
      (input.existingTerritoryDecisions ?? []).map((decision) => [
        decision.countryCode.toUpperCase(),
        decision,
      ]),
    );
    const now = input.now ?? new Date();
    const extraCountries = new Set(extra);

    return [...targeted, ...extra].sort().map((countryCode) => {
      if (extraCountries.has(countryCode) && !this.hasExplicitBlock(input, countryCode)) {
        return this.createNotTargetedDecision(input.rightsProfileId, countryCode);
      }

      const componentDecision = this.aggregateCountry(input, countryCode, now);
      return this.applyProfileOverride(
        componentDecision,
        existingByCountry.get(countryCode),
        input.rightsProfileId,
      );
    });
  }

  /**
   * WP-C.2: целевые страны версии — ведущее множество. Страна, упомянутая агентом вскользь,
   * раньше проходила полную агрегацию наравне с рынком из плана публикации: любой компонент
   * без её оценки ронял её в `PENDING_REVIEW`, а `PENDING_TERRITORIES` запрещал релиз везде.
   * Пустой план публикации оставляет прежнее поведение — «нецелевых» стран тогда нет.
   */
  private collectCountries(input: ComponentTerritoryAggregationInput): {
    targeted: string[];
    extra: string[];
  } {
    const targetCountryCodes = (input.targetCountryCodes ?? []).map((countryCode) =>
      countryCode.toUpperCase(),
    );
    const targeted = new Set(targetCountryCodes);
    const mentioned = new Set<string>();

    for (const decision of input.existingTerritoryDecisions ?? []) {
      mentioned.add(decision.countryCode.toUpperCase());
    }
    for (const component of input.components) {
      for (const assessment of component.territoryAssessments) {
        mentioned.add(assessment.countryCode.toUpperCase());
      }
    }

    if (targeted.size === 0) {
      return { targeted: [...mentioned].sort(), extra: [] };
    }

    return {
      targeted: [...targeted].sort(),
      extra: [...mentioned].filter((countryCode) => !targeted.has(countryCode)).sort(),
    };
  }

  /**
   * Компенсация ослабления WP-C.2: страна с явным запретом не становится «нецелевой» молча.
   * Проверяются оба источника запрета — решение агента по стране и любая компонентная оценка.
   */
  private hasExplicitBlock(
    input: ComponentTerritoryAggregationInput,
    countryCode: string,
  ): boolean {
    const existing = (input.existingTerritoryDecisions ?? []).find(
      (decision) => decision.countryCode.toUpperCase() === countryCode,
    );
    if (existing && (existing.accessPolicy === 'BLOCK' || existing.finalStatus === 'BLOCKED')) {
      return true;
    }

    return input.components.some((component) =>
      component.territoryAssessments.some(
        (assessment) =>
          assessment.countryCode.toUpperCase() === countryCode &&
          (assessment.accessPolicy === 'BLOCK' || assessment.status === 'BLOCKED'),
      ),
    );
  }

  private createNotTargetedDecision(
    rightsProfileId: string,
    countryCode: string,
  ): AggregatedTerritoryDecision {
    return {
      rightsProfileId,
      countryCode,
      finalStatus: 'NOT_TARGETED',
      accessPolicy: 'REVIEW_REQUIRED',
      geoBlockRequired: false,
      geoBlockScope: null,
      reasonRu: `Страна ${countryCode} не входит в план публикации версии, решение по правам не требуется.`,
      legalBasisRu: null,
      confidence: 'HIGH',
      nextReviewAt: null,
    };
  }

  private aggregateCountry(
    input: ComponentTerritoryAggregationInput,
    countryCode: string,
    now: Date,
  ): AggregatedTerritoryDecision {
    // WP-5.5: компонент, который «должен быть удалён», остаётся частью издания, пока удаление
    // не подтверждено закрытием соответствующих действий. Безусловное исключение объявляло
    // рынок открытым, тогда как иллюстрация или предисловие физически оставались в версии
    // (R6-06). Обратной связи «компонент прав → контент версии» в модели нет, поэтому
    // подтверждение профильное — см. `areComponentRemovalsConfirmed`.
    const applicableComponents = input.componentRemovalsConfirmed
      ? input.components.filter(
          (component) => component.status !== 'EXCLUDED' && component.requiredAction !== 'REMOVE',
        )
      : input.components;
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
      // WP-4.1: `LICENSE_REQUIRED` is a known verdict with a known remedy, not an open question,
      // so it must not be folded into the review pile. Doing so turned every market that needed a
      // license into `PENDING_REVIEW`, whose gate blocker no license can lift, and dropped the
      // country out of the Phase 15 coverage check altogether (R6-02). Expired rights stay a
      // problem even here: the assessment itself says the term has run out.
      if (assessment.status === 'LICENSE_REQUIRED') {
        if (assessment.rightsExpireAt && assessment.rightsExpireAt.getTime() <= now.getTime()) {
          problems.push({
            component,
            assessment,
            reason: 'Срок указанных прав или лицензии истёк.',
          });
        }
        continue;
      }

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
      if (hasAssessment) continue;
      // WP-B.1: страна, по которой нет **ни одной** компонентной оценки, остаётся проблемой
      // всегда — иначе вердикт брался бы из пустоты.
      if (assessments.length > 0 && this.toleratesMissingAssessment(component)) continue;

      problems.push({
        component,
        assessment: null,
        reason: `Нет компонентной оценки для «${component.titleRu}».`,
      });
    }

    if (problems.length > 0) {
      return this.createReviewDecision(input.rightsProfileId, countryCode, problems);
    }

    // WP-4.1: nothing is unresolved for this country, but at least one component may only be used
    // under a license. The verdict says so, and the gate then asks the coverage check whether a
    // valid license is in place — that is the central scenario of Phase 15.
    const licenseRequired = assessments.filter(
      ({ assessment }) => assessment.status === 'LICENSE_REQUIRED',
    );
    if (licenseRequired.length > 0) {
      return this.createLicenseRequiredDecision(
        input.rightsProfileId,
        countryCode,
        licenseRequired,
        assessments,
      );
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

  /**
   * WP-B.1: отсутствие страновой оценки — не всегда пробел в проверке. Манифест безусловно
   * заказывал агенту обложку, озвучку и перевод, поэтому в отчёте появлялись компоненты,
   * которых в издании нет, и подробный честный отчёт оказывался хуже пустого: любой такой
   * компонент ронял все страны в `PENDING_REVIEW`.
   *
   * Это **сужение** R6-06, а не его отмена. Освобождается только компонент, про который по
   * стране сказать нечего: агент не оценивал его по странам вовсе, либо он объявлен public
   * domain, либо действий по нему не требуется. Компонент, помеченный к удалению, освобождается
   * не здесь, а фильтром `applicableComponents` — и только после подтверждения удаления: пока
   * контент физически в версии, вердикт на обещание не опирается. Компенсация ослабления —
   * предупреждение импорта `COMPONENT_WITHOUT_TERRITORY_ASSESSMENTS`.
   */
  private toleratesMissingAssessment(component: ComponentTerritoryAggregationComponent): boolean {
    if (component.territoryAssessments.length === 0) return true;
    if (component.status === 'PUBLIC_DOMAIN') return true;
    return component.requiredAction === 'NONE';
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

  private createLicenseRequiredDecision(
    rightsProfileId: string,
    countryCode: string,
    licenseRequired: Array<{
      component: ComponentTerritoryAggregationComponent;
      assessment: ComponentTerritoryAssessmentInput;
    }>,
    assessments: Array<{
      component: ComponentTerritoryAggregationComponent;
      assessment: ComponentTerritoryAssessmentInput;
    }>,
  ): AggregatedTerritoryDecision {
    const titles = licenseRequired.map(({ component }) => `«${component.titleRu}»`).join(', ');
    // The access policy stays `REVIEW_REQUIRED`: the market is not open, but it is not closed for
    // good either — a stricter profile-level decision still overrides it, and a valid license
    // clears it. Whether readers are geo-blocked meanwhile is what the assessment says.
    const geoBlockRequired = licenseRequired.some(
      ({ assessment }) => assessment.geoBlockRequired === true,
    );

    return {
      rightsProfileId,
      countryCode,
      finalStatus: 'LICENSE_REQUIRED',
      accessPolicy: 'REVIEW_REQUIRED',
      geoBlockRequired,
      geoBlockScope: geoBlockRequired ? GeoBlockScope.LANGUAGE_EDITION : null,
      reasonRu: `Требуется лицензия. Компоненты под лицензией: ${titles}.`,
      legalBasisRu: this.joinUnique(
        licenseRequired.map(({ assessment }) => assessment.legalBasisRu),
      ),
      confidence: this.getMinimumConfidence(
        assessments.map(
          ({ component, assessment }) => assessment.confidence ?? component.confidence,
        ),
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
      // WP-B.2: ни одна оценка сама по себе не потребовала проверки — «на проверку» вывела
      // только незаполненность.
      derivedFromMissingAssessment: problems.every(({ assessment }) => assessment === null),
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
    // WP-B.3: сужение R6-06. Правило «вердикт не опирается на обещание» остаётся: явное решение
    // агента переживает агрегацию только тогда, когда та ужесточила страну **исключительно**
    // из-за незаполненности, и только если решение обосновано — непустой `legalBasisRu`/
    // `reasonRu` и `confidence !== 'LOW'`. Решение без обоснования, как и любая настоящая
    // компонентная проверка или блок, по-прежнему сильнее.
    const substantiatedDecisionWins =
      componentDecision.derivedFromMissingAssessment === true &&
      existingRank < componentRank &&
      this.isSubstantiatedDecision(existingDecision);

    if (componentRank >= existingRank && !substantiatedDecisionWins) {
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

  private isSubstantiatedDecision(decision: ExistingTerritoryDecisionInput): boolean {
    // WP-G.2 × WP-B.3: обоснованность определяется по тому, что прислал агент, а не по тому, что
    // подставило приложение. Иначе дефолтный `reasonRu` и унаследованный от корня отчёта
    // `confidence` делали обоснованным любое голое разрешающее решение (регрессия R6-06).
    const hasAgentReason =
      decision.reasonRuFromAgent !== false && decision.reasonRu.trim().length > 0;
    const hasReasoning = (decision.legalBasisRu ?? '').trim().length > 0 || hasAgentReason;
    return hasReasoning && decision.confidenceFromAgent !== false && decision.confidence !== 'LOW';
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
