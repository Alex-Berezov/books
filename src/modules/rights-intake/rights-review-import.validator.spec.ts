import { RightsReviewImportValidator } from './rights-review-import.validator';

const TARGET_LANGUAGES = ['en', 'fr'];
const TARGET_COUNTRIES = ['US', 'FR', 'GB'];
const INTAKE_ID = 'intake-1';

const validPayload = (): Record<string, unknown> => ({
  schemaVersion: '1.0',
  intakeId: INTAKE_ID,
  overallStatus: 'PUBLISHABLE',
  publicationGate: 'ALLOW',
  summaryRu: 'Пригодно к публикации',
  conclusionRu: 'Все страны разрешены',
  sourceAssessment: {
    provider: 'PROJECT_GUTENBERG',
    status: 'ALLOWED',
    sourceTextType: 'ORIGINAL_TEXT',
  },
  languageAssessments: [
    {
      languageCode: 'en',
      status: 'ALLOWED',
      translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
      requiresGeoBlock: false,
    },
    {
      languageCode: 'fr',
      status: 'ALLOWED',
      translationOrigin: 'GUTENBERG_TRANSLATION',
      requiresGeoBlock: false,
    },
  ],
  componentAssessments: [
    {
      componentType: 'ORIGINAL_TEXT',
      titleRu: 'Текст',
      status: 'PUBLIC_DOMAIN',
      requiredAction: 'KEEP',
      confidence: 'HIGH',
    },
  ],
  territoryDecisions: [
    {
      countryCode: 'US',
      finalStatus: 'ALLOWED',
      accessPolicy: 'ALLOW',
      geoBlockRequired: false,
      reasonRu: 'PD',
      confidence: 'HIGH',
    },
    {
      countryCode: 'FR',
      finalStatus: 'ALLOWED',
      accessPolicy: 'ALLOW',
      geoBlockRequired: false,
      reasonRu: 'PD',
      confidence: 'HIGH',
    },
    {
      countryCode: 'GB',
      finalStatus: 'ALLOWED',
      accessPolicy: 'ALLOW',
      geoBlockRequired: false,
      reasonRu: 'PD',
      confidence: 'HIGH',
    },
  ],
  requiredActions: [],
  evidence: [
    {
      evidenceType: 'GUTENBERG_PAGE',
      sourceLevel: 'PRIMARY',
      title: 'PG page',
      authority: 'PG',
      summaryRu: 'Страница PG',
    },
  ],
  confidence: 'HIGH',
  nextReviewAt: '2027-01-01T00:00:00.000Z',
});

describe('RightsReviewImportValidator', () => {
  let validator: RightsReviewImportValidator;

  beforeEach(() => {
    validator = new RightsReviewImportValidator();
  });

  it('valid payload passes', () => {
    const { errors, warnings } = validator.validate(
      validPayload(),
      INTAKE_ID,
      TARGET_LANGUAGES,
      TARGET_COUNTRIES,
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('wrong schemaVersion fails', () => {
    const payload = validPayload();
    payload.schemaVersion = '0.9';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'INVALID_SCHEMA_VERSION')).toBe(true);
  });

  it('missing intakeId fails', () => {
    const payload = validPayload();
    delete payload.intakeId;
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'MISSING_FIELD' && e.path === 'intakeId')).toBe(true);
  });

  it('intakeId mismatch fails', () => {
    const payload = validPayload();
    payload.intakeId = 'wrong-id';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'INTAKE_ID_MISMATCH')).toBe(true);
  });

  it('missing target country decision fails', () => {
    const payload = validPayload();
    (payload.territoryDecisions as Array<Record<string, unknown>>) = [
      {
        countryCode: 'US',
        finalStatus: 'ALLOWED',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
        reasonRu: 'PD',
        confidence: 'HIGH',
      },
    ];
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'MISSING_COUNTRY_DECISION')).toBe(true);
  });

  it('missing target language assessment fails', () => {
    const payload = validPayload();
    (payload.languageAssessments as Array<Record<string, unknown>>) = [
      {
        languageCode: 'en',
        status: 'ALLOWED',
        translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
        requiresGeoBlock: false,
      },
    ];
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'MISSING_LANGUAGE_ASSESSMENT')).toBe(true);
  });

  it('invalid country code fails', () => {
    const payload = validPayload();
    (payload.territoryDecisions as Array<Record<string, unknown>>)[0].countryCode = 'us';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'INVALID_COUNTRY_CODE')).toBe(true);
  });

  it('invalid enum fails', () => {
    const payload = validPayload();
    payload.overallStatus = 'INVALID_STATUS';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'INVALID_ENUM' && e.path === 'overallStatus')).toBe(true);
  });

  it('REJECTED + ALLOW fails', () => {
    const payload = validPayload();
    payload.overallStatus = 'REJECTED';
    payload.publicationGate = 'ALLOW';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'REJECTED_NOT_BLOCKED')).toBe(true);
  });

  it('LICENSE_REQUIRED + ALLOW fails', () => {
    const payload = validPayload();
    payload.overallStatus = 'LICENSE_REQUIRED';
    payload.publicationGate = 'ALLOW';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'LICENSE_REQUIRED_ALLOW_CONFLICT')).toBe(true);
  });

  it('geo block without scope fails', () => {
    const payload = validPayload();
    (payload.territoryDecisions as Array<Record<string, unknown>>)[0].geoBlockRequired = true;
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'GEO_BLOCK_SCOPE_REQUIRED')).toBe(true);
  });

  it('empty evidence returns warning', () => {
    const payload = validPayload();
    (payload.evidence as Array<Record<string, unknown>>) = [];
    const { warnings } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(warnings.some((w) => w.code === 'EMPTY_ARRAY' && w.path === 'evidence')).toBe(true);
  });

  it('LOW confidence returns warning', () => {
    const payload = validPayload();
    payload.confidence = 'LOW';
    const { warnings } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(warnings.some((w) => w.code === 'LOW_CONFIDENCE')).toBe(true);
  });

  it('intermediate translation returns warning', () => {
    const payload = validPayload();
    (payload.languageAssessments as Array<Record<string, unknown>>)[1].translationOrigin =
      'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION';
    const { warnings } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(warnings.some((w) => w.code === 'INTERMEDIATE_TRANSLATION')).toBe(true);
  });

  it('blocking action without description fails', () => {
    const payload = validPayload();
    (payload.requiredActions as Array<Record<string, unknown>>) = [
      { actionType: 'REMOVE_COMPONENT', isBlocking: true, affectedCountryCodes: ['US'] },
    ];
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'BLOCKING_ACTION_NO_DESC')).toBe(true);
  });

  it('ALLOW + BLOCK conflict fails', () => {
    const payload = validPayload();
    (payload.territoryDecisions as Array<Record<string, unknown>>)[0].accessPolicy = 'BLOCK';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'ALLOW_BLOCK_CONFLICT')).toBe(true);
  });

  it('missing nextReviewAt returns warning', () => {
    const payload = validPayload();
    delete payload.nextReviewAt;
    const { warnings } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(warnings.some((w) => w.code === 'MISSING_NEXT_REVIEW')).toBe(true);
  });
});
