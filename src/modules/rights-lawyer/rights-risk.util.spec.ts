import {
  RightsLawyerReviewTrigger,
  RightsRiskFactorCode,
  RightsRiskLevel,
} from './rights-lawyer-interface';
import {
  EMPTY_RISK_ASSESSMENT_INPUT,
  computeRiskAssessment,
  meetsRiskThreshold,
  parseBooleanFlag,
  parseRiskLevel,
  type RiskAssessmentInput,
} from './rights-risk.util';

const input = (overrides: Partial<RiskAssessmentInput> = {}): RiskAssessmentInput => ({
  ...EMPTY_RISK_ASSESSMENT_INPUT,
  ...overrides,
  profile: { ...EMPTY_RISK_ASSESSMENT_INPUT.profile, ...(overrides.profile ?? {}) },
});

const component = (overrides: Partial<RiskAssessmentInput['components'][number]> = {}) => ({
  id: 'component-1',
  componentType: 'MAIN_TEXT',
  status: 'PUBLIC_DOMAIN',
  requiredAction: 'KEEP',
  confidence: 'HIGH',
  titleRu: 'Основной текст',
  territoryAssessmentCount: 1,
  ...overrides,
});

const codesOf = (result: ReturnType<typeof computeRiskAssessment>) =>
  result.factors.map((factor) => factor.code);

describe('computeRiskAssessment', () => {
  it('returns LOW with no factors for an empty input', () => {
    const result = computeRiskAssessment(EMPTY_RISK_ASSESSMENT_INPUT);
    expect(result.riskLevel).toBe(RightsRiskLevel.LOW);
    expect(result.factors).toHaveLength(0);
    expect(result.explicitLawyerRequest).toBe(false);
    expect(result.suggestedTrigger).toBe(RightsLawyerReviewTrigger.HIGH_RISK_POLICY);
  });

  it('is deterministic: the same input twice yields the same result', () => {
    const payload = input({
      profile: {
        overallStatus: 'LICENSE_REQUIRED',
        publicationGate: 'ALLOW',
        confidence: 'LOW',
        status: 'IMPORTED',
      },
      territoryDecisions: [{ countryCode: 'US', finalStatus: 'LICENSE_REQUIRED' }],
    });
    expect(computeRiskAssessment(payload)).toEqual(computeRiskAssessment(payload));
  });

  describe('CRITICAL factors', () => {
    it('flags PUBLICATION_GATE_BLOCK', () => {
      const result = computeRiskAssessment(
        input({ profile: { ...EMPTY_RISK_ASSESSMENT_INPUT.profile, publicationGate: 'BLOCK' } }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.CRITICAL);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.PUBLICATION_GATE_BLOCK);
    });

    it('flags OVERALL_STATUS_REJECTED', () => {
      const result = computeRiskAssessment(
        input({ profile: { ...EMPTY_RISK_ASSESSMENT_INPUT.profile, overallStatus: 'REJECTED' } }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.CRITICAL);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.OVERALL_STATUS_REJECTED);
    });

    it('flags CLAIM_ESCALATED_TO_LAWYER by status', () => {
      const result = computeRiskAssessment(
        input({
          claims: [
            {
              id: 'c1',
              status: 'ESCALATED_TO_LAWYER',
              severity: 'LOW',
              requiresLawyerReview: false,
            },
          ],
        }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.CRITICAL);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.CLAIM_ESCALATED_TO_LAWYER);
      expect(result.explicitLawyerRequest).toBe(true);
      expect(result.suggestedTrigger).toBe(RightsLawyerReviewTrigger.RIGHTS_CLAIM);
    });

    it('flags CLAIM_ESCALATED_TO_LAWYER by requiresLawyerReview on an open claim', () => {
      const result = computeRiskAssessment(
        input({
          claims: [
            { id: 'c1', status: 'UNDER_REVIEW', severity: 'LOW', requiresLawyerReview: true },
          ],
        }),
      );
      expect(codesOf(result)).toContain(RightsRiskFactorCode.CLAIM_ESCALATED_TO_LAWYER);
    });

    it('flags CRITICAL_CLAIM_OPEN', () => {
      const result = computeRiskAssessment(
        input({
          claims: [
            { id: 'c1', status: 'UNDER_REVIEW', severity: 'CRITICAL', requiresLawyerReview: false },
          ],
        }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.CRITICAL);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.CRITICAL_CLAIM_OPEN);
      expect(result.explicitLawyerRequest).toBe(false);
      expect(result.suggestedTrigger).toBe(RightsLawyerReviewTrigger.RIGHTS_CLAIM);
    });

    it('ignores resolved and closed claims', () => {
      const result = computeRiskAssessment(
        input({
          claims: [
            { id: 'c1', status: 'RESOLVED', severity: 'CRITICAL', requiresLawyerReview: true },
            { id: 'c2', status: 'CLOSED', severity: 'CRITICAL', requiresLawyerReview: true },
          ],
        }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.LOW);
      expect(result.factors).toHaveLength(0);
    });
  });

  describe('HIGH factors', () => {
    it('flags AGENT_REQUESTED_LAWYER_REVIEW and suggests AGENT_REQUESTED', () => {
      const result = computeRiskAssessment(
        input({ actions: [{ actionType: 'LAWYER_REVIEW', status: 'PENDING', isBlocking: false }] }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.AGENT_REQUESTED_LAWYER_REVIEW);
      expect(result.explicitLawyerRequest).toBe(true);
      expect(result.suggestedTrigger).toBe(RightsLawyerReviewTrigger.AGENT_REQUESTED);
    });

    it('flags CONFIDENCE_LOW at HIGH when a target country is contested', () => {
      const result = computeRiskAssessment(
        input({
          profile: { ...EMPTY_RISK_ASSESSMENT_INPUT.profile, confidence: 'LOW' },
          territoryDecisions: [{ countryCode: 'US', finalStatus: 'PENDING_REVIEW' }],
        }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.CONFIDENCE_LOW);
    });

    it('flags OVERALL_STATUS_INSUFFICIENT_DATA', () => {
      const result = computeRiskAssessment(
        input({
          profile: { ...EMPTY_RISK_ASSESSMENT_INPUT.profile, overallStatus: 'INSUFFICIENT_DATA' },
        }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.OVERALL_STATUS_INSUFFICIENT_DATA);
    });

    it('flags OVERALL_STATUS_LICENSE_REQUIRED and suggests LICENSE_REQUIRED', () => {
      const result = computeRiskAssessment(
        input({
          profile: { ...EMPTY_RISK_ASSESSMENT_INPUT.profile, overallStatus: 'LICENSE_REQUIRED' },
        }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
      expect(result.suggestedTrigger).toBe(RightsLawyerReviewTrigger.LICENSE_REQUIRED);
    });

    it('flags UNCERTAIN_COMPONENT that is kept', () => {
      const result = computeRiskAssessment(
        input({ components: [component({ status: 'UNCERTAIN', requiredAction: 'KEEP' })] }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.UNCERTAIN_COMPONENT);
    });

    it('does not flag an UNCERTAIN component that is removed or replaced', () => {
      const removed = computeRiskAssessment(
        input({ components: [component({ status: 'UNCERTAIN', requiredAction: 'REMOVE' })] }),
      );
      const replaced = computeRiskAssessment(
        input({ components: [component({ status: 'UNCERTAIN', requiredAction: 'REPLACE' })] }),
      );
      expect(removed.factors).toHaveLength(0);
      expect(replaced.factors).toHaveLength(0);
    });

    it('flags COPYRIGHTED_COMPONENT_KEPT', () => {
      const result = computeRiskAssessment(
        input({ components: [component({ status: 'COPYRIGHTED', requiredAction: 'KEEP' })] }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.COPYRIGHTED_COMPONENT_KEPT);
    });

    it('flags LICENSE_REQUIRED_TERRITORY with the country list in details', () => {
      const result = computeRiskAssessment(
        input({ territoryDecisions: [{ countryCode: 'US', finalStatus: 'LICENSE_REQUIRED' }] }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
      const factor = result.factors.find(
        (item) => item.code === RightsRiskFactorCode.LICENSE_REQUIRED_TERRITORY,
      );
      expect(factor?.details).toEqual({ countryCodes: ['US'] });
    });
  });

  describe('MEDIUM factors', () => {
    it('flags UNRESOLVED_BLOCKING_ACTION', () => {
      const result = computeRiskAssessment(
        input({
          actions: [{ actionType: 'REMOVE_COMPONENT', status: 'PENDING', isBlocking: true }],
        }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.MEDIUM);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.UNRESOLVED_BLOCKING_ACTION);
    });

    it('ignores COMPLETED and WAIVED actions', () => {
      const result = computeRiskAssessment(
        input({
          actions: [
            { actionType: 'REMOVE_COMPONENT', status: 'COMPLETED', isBlocking: true },
            { actionType: 'LAWYER_REVIEW', status: 'WAIVED', isBlocking: true },
          ],
        }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.LOW);
      expect(result.factors).toHaveLength(0);
    });

    it('flags PENDING_REVIEW_TERRITORY for PENDING_REVIEW and NOT_CHECKED', () => {
      const result = computeRiskAssessment(
        input({
          territoryDecisions: [
            { countryCode: 'FR', finalStatus: 'PENDING_REVIEW' },
            { countryCode: 'DE', finalStatus: 'NOT_CHECKED' },
          ],
        }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.MEDIUM);
      const factor = result.factors.find(
        (item) => item.code === RightsRiskFactorCode.PENDING_REVIEW_TERRITORY,
      );
      expect(factor?.details).toEqual({ countryCodes: ['FR', 'DE'] });
    });

    it('flags CONFIDENCE_MEDIUM', () => {
      const result = computeRiskAssessment(
        input({ profile: { ...EMPTY_RISK_ASSESSMENT_INPUT.profile, confidence: 'MEDIUM' } }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.MEDIUM);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.CONFIDENCE_MEDIUM);
    });

    it('flags DERIVATIVE_SOURCE_TEXT for a translation', () => {
      const result = computeRiskAssessment(input({ sourceTextType: 'TRANSLATION' }));
      expect(result.riskLevel).toBe(RightsRiskLevel.MEDIUM);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.DERIVATIVE_SOURCE_TEXT);
    });

    it('does not flag an original source text', () => {
      const result = computeRiskAssessment(input({ sourceTextType: 'ORIGINAL_TEXT' }));
      expect(result.factors).toHaveLength(0);
    });

    it('flags CONTRIBUTOR_DEATH_YEAR_UNKNOWN only for risky roles', () => {
      const risky = computeRiskAssessment(
        input({ contributors: [{ role: 'TRANSLATOR', fullName: 'Иванов', deathYear: null }] }),
      );
      const harmless = computeRiskAssessment(
        input({ contributors: [{ role: 'RIGHTS_HOLDER', fullName: 'ООО', deathYear: null }] }),
      );
      expect(risky.riskLevel).toBe(RightsRiskLevel.MEDIUM);
      expect(codesOf(risky)).toContain(RightsRiskFactorCode.CONTRIBUTOR_DEATH_YEAR_UNKNOWN);
      expect(harmless.factors).toHaveLength(0);
    });
  });

  describe('LOW factors and aggregation', () => {
    it('flags BLOCKED_TERRITORY at LOW', () => {
      const result = computeRiskAssessment(
        input({ territoryDecisions: [{ countryCode: 'US', finalStatus: 'BLOCKED' }] }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.LOW);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.BLOCKED_TERRITORY);
    });

    it('takes the maximum level across factors (MEDIUM + CRITICAL -> CRITICAL)', () => {
      const result = computeRiskAssessment(
        input({
          profile: {
            ...EMPTY_RISK_ASSESSMENT_INPUT.profile,
            publicationGate: 'BLOCK',
            confidence: 'MEDIUM',
          },
        }),
      );
      expect(result.riskLevel).toBe(RightsRiskLevel.CRITICAL);
      expect(codesOf(result)).toEqual(
        expect.arrayContaining([
          RightsRiskFactorCode.PUBLICATION_GATE_BLOCK,
          RightsRiskFactorCode.CONFIDENCE_MEDIUM,
        ]),
      );
    });

    it('does not flag UNCERTAIN_COMPONENT for a component the agent never assessed by country', () => {
      const verify = computeRiskAssessment(
        input({
          components: [
            component({
              status: 'UNCERTAIN',
              requiredAction: 'VERIFY',
              territoryAssessmentCount: 0,
              titleRu: 'Обложка',
            }),
          ],
        }),
      );
      const none = computeRiskAssessment(
        input({
          components: [
            component({ status: 'UNCERTAIN', requiredAction: 'NONE', territoryAssessmentCount: 0 }),
          ],
        }),
      );

      expect(verify.factors).toHaveLength(0);
      expect(verify.riskLevel).toBe(RightsRiskLevel.LOW);
      expect(none.factors).toHaveLength(0);
    });

    it('still flags UNCERTAIN_COMPONENT once the agent assessed it by country', () => {
      const result = computeRiskAssessment(
        input({
          components: [
            component({
              status: 'UNCERTAIN',
              requiredAction: 'VERIFY',
              territoryAssessmentCount: 2,
            }),
          ],
        }),
      );

      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.UNCERTAIN_COMPONENT);
    });

    it('still flags UNCERTAIN_COMPONENT that is kept even without country assessments', () => {
      const result = computeRiskAssessment(
        input({
          components: [
            component({ status: 'UNCERTAIN', requiredAction: 'KEEP', territoryAssessmentCount: 0 }),
          ],
        }),
      );

      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
      expect(codesOf(result)).toContain(RightsRiskFactorCode.UNCERTAIN_COMPONENT);
    });

    it('keeps CONFIDENCE_LOW at MEDIUM when no target country is contested', () => {
      const result = computeRiskAssessment(
        input({
          profile: { ...EMPTY_RISK_ASSESSMENT_INPUT.profile, confidence: 'LOW' },
          territoryDecisions: [{ countryCode: 'US', finalStatus: 'ALLOWED' }],
          targetCountryCodes: ['US'],
        }),
      );

      expect(result.riskLevel).toBe(RightsRiskLevel.MEDIUM);
      const factor = result.factors.find(
        (item) => item.code === RightsRiskFactorCode.CONFIDENCE_LOW,
      );
      expect(factor?.level).toBe(RightsRiskLevel.MEDIUM);
    });

    it('raises CONFIDENCE_LOW back to HIGH for a blocked target country', () => {
      const result = computeRiskAssessment(
        input({
          profile: { ...EMPTY_RISK_ASSESSMENT_INPUT.profile, confidence: 'LOW' },
          territoryDecisions: [{ countryCode: 'US', finalStatus: 'BLOCKED' }],
          targetCountryCodes: ['US'],
        }),
      );

      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
      const factor = result.factors.find(
        (item) => item.code === RightsRiskFactorCode.CONFIDENCE_LOW,
      );
      expect(factor?.level).toBe(RightsRiskLevel.HIGH);
      expect(factor?.details).toEqual({ countryCodes: ['US'] });
    });

    it('ignores countries outside the target markets', () => {
      const result = computeRiskAssessment(
        input({
          profile: { ...EMPTY_RISK_ASSESSMENT_INPUT.profile, confidence: 'LOW' },
          territoryDecisions: [
            { countryCode: 'us', finalStatus: 'ALLOWED' },
            { countryCode: 'DE', finalStatus: 'LICENSE_REQUIRED' },
            { countryCode: 'MX', finalStatus: 'PENDING_REVIEW' },
          ],
          targetCountryCodes: ['US'],
        }),
      );

      expect(codesOf(result)).not.toContain(RightsRiskFactorCode.LICENSE_REQUIRED_TERRITORY);
      expect(codesOf(result)).not.toContain(RightsRiskFactorCode.PENDING_REVIEW_TERRITORY);
      expect(result.riskLevel).toBe(RightsRiskLevel.MEDIUM);
    });

    it('keeps territory factors for countries inside the target markets', () => {
      const result = computeRiskAssessment(
        input({
          territoryDecisions: [
            { countryCode: 'US', finalStatus: 'ALLOWED' },
            { countryCode: 'DE', finalStatus: 'LICENSE_REQUIRED' },
          ],
          targetCountryCodes: ['US', 'DE'],
        }),
      );

      expect(codesOf(result)).toContain(RightsRiskFactorCode.LICENSE_REQUIRED_TERRITORY);
      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
    });

    it('never counts a NOT_TARGETED decision as a pending territory', () => {
      const result = computeRiskAssessment(
        input({
          territoryDecisions: [{ countryCode: 'MX', finalStatus: 'NOT_TARGETED' }],
        }),
      );

      expect(result.factors).toHaveLength(0);
    });

    it('prefers AGENT_REQUESTED over RIGHTS_CLAIM when both are present', () => {
      const result = computeRiskAssessment(
        input({
          actions: [{ actionType: 'LAWYER_REVIEW', status: 'IN_PROGRESS', isBlocking: false }],
          claims: [
            { id: 'c1', status: 'UNDER_REVIEW', severity: 'CRITICAL', requiresLawyerReview: false },
          ],
        }),
      );
      expect(result.suggestedTrigger).toBe(RightsLawyerReviewTrigger.AGENT_REQUESTED);
    });
  });
});

describe('meetsRiskThreshold', () => {
  it('compares by rank, not by identity', () => {
    expect(meetsRiskThreshold(RightsRiskLevel.CRITICAL, RightsRiskLevel.HIGH)).toBe(true);
    expect(meetsRiskThreshold(RightsRiskLevel.HIGH, RightsRiskLevel.HIGH)).toBe(true);
    expect(meetsRiskThreshold(RightsRiskLevel.MEDIUM, RightsRiskLevel.HIGH)).toBe(false);
  });
});

describe('env parsers', () => {
  it('parseRiskLevel falls back on unknown values and accepts lower case', () => {
    expect(parseRiskLevel('critical', RightsRiskLevel.HIGH)).toBe(RightsRiskLevel.CRITICAL);
    expect(parseRiskLevel('nonsense', RightsRiskLevel.HIGH)).toBe(RightsRiskLevel.HIGH);
    expect(parseRiskLevel(undefined, RightsRiskLevel.MEDIUM)).toBe(RightsRiskLevel.MEDIUM);
  });

  it('parseBooleanFlag treats 0/false/off as disabled', () => {
    expect(parseBooleanFlag('0', true)).toBe(false);
    expect(parseBooleanFlag('false', true)).toBe(false);
    expect(parseBooleanFlag('off', true)).toBe(false);
    expect(parseBooleanFlag('1', false)).toBe(true);
    expect(parseBooleanFlag(undefined, true)).toBe(true);
    expect(parseBooleanFlag('', true)).toBe(true);
  });
});
