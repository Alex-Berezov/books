import {
  CLOSED_ACTION_STATUSES,
  CLOSED_CLAIM_STATUSES,
  CONTESTED_TERRITORY_STATUSES,
  DERIVATIVE_SOURCE_TEXT_TYPES,
  PLANNED_MATERIAL_REQUIRED_ACTIONS,
  RISK_FACTOR_LEVELS,
  RISK_FACTOR_MESSAGES_RU,
  RISKY_CONTRIBUTOR_ROLES,
  riskLevelRank,
} from './rights-lawyer.constants';
import {
  RightsLawyerReviewTrigger,
  RightsRiskFactorCode,
  RightsRiskLevel,
} from './rights-lawyer-interface';

/**
 * Deterministic risk scoring of a rights profile.
 *
 * This file imports nothing but `./rights-lawyer-interface` and `./rights-lawyer.constants`,
 * both of which are import-free leaves. That is deliberate: the function is used by the lawyer
 * module AND by `RightsApprovalService` in `rights-intake`, and a heavier import would create a
 * module cycle (ADR-003). It also never reads the clock — "now" is not part of the model.
 */

export interface RiskAssessmentInput {
  profile: {
    overallStatus: string;
    publicationGate: string;
    confidence: string;
    status: string;
  };
  sourceTextType: string | null;
  components: Array<{
    id: string;
    componentType: string;
    status: string;
    requiredAction: string;
    confidence: string | null;
    titleRu: string;
    /** Сколько страновых оценок агент выставил компоненту. `0` — компонент по странам не оценивался. */
    territoryAssessmentCount: number;
  }>;
  territoryDecisions: Array<{ countryCode: string; finalStatus: string }>;
  /**
   * Целевые страны интейка. Пустой список — целевое множество неизвестно; тогда в риск идут
   * все страны, то есть поведение остаётся прежним (fail-closed).
   */
  targetCountryCodes: string[];
  actions: Array<{ actionType: string; status: string; isBlocking: boolean }>;
  contributors: Array<{ role: string; fullName: string; deathYear: number | null }>;
  claims: Array<{ id: string; status: string; severity: string; requiresLawyerReview: boolean }>;
}

export interface RiskFactor {
  code: RightsRiskFactorCode;
  level: RightsRiskLevel;
  messageRu: string;
  details?: Record<string, unknown>;
}

export interface RiskAssessmentResult {
  riskLevel: RightsRiskLevel;
  factors: RiskFactor[];
  /** true, если среди факторов есть AGENT_REQUESTED_LAWYER_REVIEW или CLAIM_ESCALATED_TO_LAWYER. */
  explicitLawyerRequest: boolean;
  suggestedTrigger: RightsLawyerReviewTrigger;
}

/** An empty input is a valid input: it simply yields LOW with no factors. */
export const EMPTY_RISK_ASSESSMENT_INPUT: RiskAssessmentInput = {
  profile: {
    overallStatus: '',
    publicationGate: '',
    confidence: '',
    status: '',
  },
  sourceTextType: null,
  components: [],
  territoryDecisions: [],
  targetCountryCodes: [],
  actions: [],
  contributors: [],
  claims: [],
};

const makeFactor = (
  code: RightsRiskFactorCode,
  details?: Record<string, unknown>,
  level?: RightsRiskLevel,
): RiskFactor => ({
  code,
  level: level ?? RISK_FACTOR_LEVELS[code],
  messageRu: RISK_FACTOR_MESSAGES_RU[code],
  ...(details ? { details } : {}),
});

const isOpenClaim = (status: string): boolean => !CLOSED_CLAIM_STATUSES.includes(status);
const isOpenAction = (status: string): boolean => !CLOSED_ACTION_STATUSES.includes(status);

const normaliseCountry = (code: string): string => code.trim().toUpperCase();

/**
 * WP-E.1: компонент, который агент не оценивал ни по одной стране и по которому не просит
 * ничего, кроме проверки, — это «материала ещё нет» (спекулятивные обложка, озвучка, перевод из
 * манифеста), а не правовая неопределённость. Компонент с оценками по странам или с действием
 * `KEEP` / `RETRANSLATE` / `OBTAIN_LICENSE` по-прежнему поднимает `UNCERTAIN_COMPONENT`.
 */
const isPlannedButUnassessedMaterial = (component: {
  requiredAction: string;
  territoryAssessmentCount: number;
}): boolean =>
  component.territoryAssessmentCount === 0 &&
  PLANNED_MATERIAL_REQUIRED_ACTIONS.includes(component.requiredAction);

export const computeRiskAssessment = (input: RiskAssessmentInput): RiskAssessmentResult => {
  const factors: RiskFactor[] = [];

  // WP-E.3: в риск идут только целевые рынки. Страна, упомянутая агентом вскользь, и страна,
  // помеченная `NOT_TARGETED`, юриста не требуют. Пустой список целевых стран означает «множество
  // неизвестно» — тогда считаются все страны, как раньше.
  const targetCountries = new Set(input.targetCountryCodes.map(normaliseCountry).filter(Boolean));
  const targetedDecisions = input.territoryDecisions.filter(
    (decision) =>
      decision.finalStatus !== 'NOT_TARGETED' &&
      (targetCountries.size === 0 || targetCountries.has(normaliseCountry(decision.countryCode))),
  );
  const contestedTargetCountries = targetedDecisions
    .filter((decision) => CONTESTED_TERRITORY_STATUSES.includes(decision.finalStatus))
    .map((decision) => decision.countryCode);

  // --- CRITICAL -----------------------------------------------------------
  if (input.profile.publicationGate === 'BLOCK') {
    factors.push(makeFactor(RightsRiskFactorCode.PUBLICATION_GATE_BLOCK));
  }

  if (input.profile.overallStatus === 'REJECTED') {
    factors.push(makeFactor(RightsRiskFactorCode.OVERALL_STATUS_REJECTED));
  }

  const escalatedClaims = input.claims.filter(
    (claim) =>
      claim.status === 'ESCALATED_TO_LAWYER' ||
      (claim.requiresLawyerReview && isOpenClaim(claim.status)),
  );
  if (escalatedClaims.length > 0) {
    factors.push(
      makeFactor(RightsRiskFactorCode.CLAIM_ESCALATED_TO_LAWYER, {
        claimIds: escalatedClaims.map((claim) => claim.id),
      }),
    );
  }

  const criticalClaims = input.claims.filter(
    (claim) => claim.severity === 'CRITICAL' && isOpenClaim(claim.status),
  );
  if (criticalClaims.length > 0) {
    factors.push(
      makeFactor(RightsRiskFactorCode.CRITICAL_CLAIM_OPEN, {
        claimIds: criticalClaims.map((claim) => claim.id),
      }),
    );
  }

  // --- HIGH ---------------------------------------------------------------
  const agentLawyerActions = input.actions.filter(
    (action) =>
      action.actionType === 'LAWYER_REVIEW' &&
      (action.status === 'PENDING' || action.status === 'IN_PROGRESS'),
  );
  if (agentLawyerActions.length > 0) {
    factors.push(
      makeFactor(RightsRiskFactorCode.AGENT_REQUESTED_LAWYER_REVIEW, {
        actionsCount: agentLawyerActions.length,
      }),
    );
  }

  // WP-E.2: осторожный `confidence` — HIGH только когда спорна хотя бы одна целевая страна.
  if (input.profile.confidence === 'LOW') {
    factors.push(
      contestedTargetCountries.length > 0
        ? makeFactor(
            RightsRiskFactorCode.CONFIDENCE_LOW,
            { countryCodes: contestedTargetCountries },
            RightsRiskLevel.HIGH,
          )
        : makeFactor(RightsRiskFactorCode.CONFIDENCE_LOW),
    );
  }

  if (input.profile.overallStatus === 'INSUFFICIENT_DATA') {
    factors.push(makeFactor(RightsRiskFactorCode.OVERALL_STATUS_INSUFFICIENT_DATA));
  }

  if (input.profile.overallStatus === 'LICENSE_REQUIRED') {
    factors.push(makeFactor(RightsRiskFactorCode.OVERALL_STATUS_LICENSE_REQUIRED));
  }

  const uncertainComponents = input.components.filter(
    (component) =>
      component.status === 'UNCERTAIN' &&
      component.requiredAction !== 'REMOVE' &&
      component.requiredAction !== 'REPLACE' &&
      !isPlannedButUnassessedMaterial(component),
  );
  if (uncertainComponents.length > 0) {
    factors.push(
      makeFactor(RightsRiskFactorCode.UNCERTAIN_COMPONENT, {
        componentIds: uncertainComponents.map((component) => component.id),
        titles: uncertainComponents.map((component) => component.titleRu),
      }),
    );
  }

  const keptCopyrighted = input.components.filter(
    (component) => component.status === 'COPYRIGHTED' && component.requiredAction === 'KEEP',
  );
  if (keptCopyrighted.length > 0) {
    factors.push(
      makeFactor(RightsRiskFactorCode.COPYRIGHTED_COMPONENT_KEPT, {
        componentIds: keptCopyrighted.map((component) => component.id),
        titles: keptCopyrighted.map((component) => component.titleRu),
      }),
    );
  }

  const licenseRequiredCountries = targetedDecisions
    .filter((decision) => decision.finalStatus === 'LICENSE_REQUIRED')
    .map((decision) => decision.countryCode);
  if (licenseRequiredCountries.length > 0) {
    factors.push(
      makeFactor(RightsRiskFactorCode.LICENSE_REQUIRED_TERRITORY, {
        countryCodes: licenseRequiredCountries,
      }),
    );
  }

  // --- MEDIUM -------------------------------------------------------------
  const unresolvedBlocking = input.actions.filter(
    (action) => action.isBlocking && isOpenAction(action.status),
  );
  if (unresolvedBlocking.length > 0) {
    factors.push(
      makeFactor(RightsRiskFactorCode.UNRESOLVED_BLOCKING_ACTION, {
        actionsCount: unresolvedBlocking.length,
      }),
    );
  }

  const pendingCountries = targetedDecisions
    .filter(
      (decision) =>
        decision.finalStatus === 'PENDING_REVIEW' || decision.finalStatus === 'NOT_CHECKED',
    )
    .map((decision) => decision.countryCode);
  if (pendingCountries.length > 0) {
    factors.push(
      makeFactor(RightsRiskFactorCode.PENDING_REVIEW_TERRITORY, {
        countryCodes: pendingCountries,
      }),
    );
  }

  if (input.profile.confidence === 'MEDIUM') {
    factors.push(makeFactor(RightsRiskFactorCode.CONFIDENCE_MEDIUM));
  }

  if (input.sourceTextType && DERIVATIVE_SOURCE_TEXT_TYPES.includes(input.sourceTextType)) {
    factors.push(
      makeFactor(RightsRiskFactorCode.DERIVATIVE_SOURCE_TEXT, {
        sourceTextType: input.sourceTextType,
      }),
    );
  }

  const unknownDeathYear = input.contributors.filter(
    (contributor) =>
      RISKY_CONTRIBUTOR_ROLES.includes(contributor.role) && contributor.deathYear === null,
  );
  if (unknownDeathYear.length > 0) {
    factors.push(
      makeFactor(RightsRiskFactorCode.CONTRIBUTOR_DEATH_YEAR_UNKNOWN, {
        contributors: unknownDeathYear.map((contributor) => ({
          role: contributor.role,
          fullName: contributor.fullName,
        })),
      }),
    );
  }

  // --- LOW ----------------------------------------------------------------
  const blockedCountries = targetedDecisions
    .filter((decision) => decision.finalStatus === 'BLOCKED')
    .map((decision) => decision.countryCode);
  if (blockedCountries.length > 0) {
    factors.push(
      makeFactor(RightsRiskFactorCode.BLOCKED_TERRITORY, { countryCodes: blockedCountries }),
    );
  }

  const riskLevel = factors.reduce<RightsRiskLevel>(
    (max, factor) => (riskLevelRank(factor.level) > riskLevelRank(max) ? factor.level : max),
    RightsRiskLevel.LOW,
  );

  const codes = new Set(factors.map((factor) => factor.code));
  const explicitLawyerRequest =
    codes.has(RightsRiskFactorCode.AGENT_REQUESTED_LAWYER_REVIEW) ||
    codes.has(RightsRiskFactorCode.CLAIM_ESCALATED_TO_LAWYER);

  return {
    riskLevel,
    factors,
    explicitLawyerRequest,
    suggestedTrigger: suggestTrigger(codes),
  };
};

const suggestTrigger = (codes: Set<RightsRiskFactorCode>): RightsLawyerReviewTrigger => {
  if (codes.has(RightsRiskFactorCode.AGENT_REQUESTED_LAWYER_REVIEW)) {
    return RightsLawyerReviewTrigger.AGENT_REQUESTED;
  }
  if (
    codes.has(RightsRiskFactorCode.CLAIM_ESCALATED_TO_LAWYER) ||
    codes.has(RightsRiskFactorCode.CRITICAL_CLAIM_OPEN)
  ) {
    return RightsLawyerReviewTrigger.RIGHTS_CLAIM;
  }
  if (
    codes.has(RightsRiskFactorCode.LICENSE_REQUIRED_TERRITORY) ||
    codes.has(RightsRiskFactorCode.OVERALL_STATUS_LICENSE_REQUIRED)
  ) {
    return RightsLawyerReviewTrigger.LICENSE_REQUIRED;
  }
  return RightsLawyerReviewTrigger.HIGH_RISK_POLICY;
};

/** Whether a risk level reaches the configured threshold. */
export const meetsRiskThreshold = (level: RightsRiskLevel, threshold: RightsRiskLevel): boolean =>
  riskLevelRank(level) >= riskLevelRank(threshold);

/** Parses `RIGHTS_LAWYER_MIN_RISK_LEVEL`; anything unrecognised falls back to the default. */
export const parseRiskLevel = (raw: unknown, fallback: RightsRiskLevel): RightsRiskLevel => {
  if (typeof raw !== 'string') return fallback;
  const normalised = raw.trim().toUpperCase();
  return (Object.values(RightsRiskLevel) as string[]).includes(normalised)
    ? (normalised as RightsRiskLevel)
    : fallback;
};

/** Reads a boolean env flag: `0`, `false` and `off` disable, everything else enables. */
export const parseBooleanFlag = (raw: unknown, fallback: boolean): boolean => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string' && typeof raw !== 'number') return fallback;
  const normalised = `${raw}`.trim().toLowerCase();
  if (normalised === '') return fallback;
  if (normalised === '0' || normalised === 'false' || normalised === 'off') return false;
  if (normalised === '1' || normalised === 'true' || normalised === 'on') return true;
  return fallback;
};

/** Reads a positive-integer env value, falling back when absent or malformed. */
export const parsePositiveIntOption = (raw: unknown, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export const MS_PER_DAY = 86_400_000;

export const addDays = (base: Date, days: number): Date =>
  new Date(base.getTime() + days * MS_PER_DAY);

/** Whole days remaining until `target`; negative once it is in the past. */
export const daysUntil = (target: Date, now: Date): number =>
  Math.ceil((target.getTime() - now.getTime()) / MS_PER_DAY);
