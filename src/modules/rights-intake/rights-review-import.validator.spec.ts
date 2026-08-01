import { RightsReviewImportValidator } from './rights-review-import.validator';
import { REQUIRED_REPORT_FIELDS } from './rights-review-required-fields';

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

  it('schemaVersion "1.0" is accepted by the version registry', () => {
    const payload = validPayload();
    payload.schemaVersion = '1.0';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.code === 'INVALID_SCHEMA_VERSION')).toBe(false);
  });

  it('schemaVersion "2.0" fails and the message lists the supported versions', () => {
    const payload = validPayload();
    payload.schemaVersion = '2.0';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    const issue = errors.find((e) => e.code === 'INVALID_SCHEMA_VERSION');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('"1.0"');
    expect(issue?.message).toContain('2.0');
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

  // WP-7.2: язык компонента необязателен (обложка общая для всех языков), но названный —
  // обязан быть целевым языком платформы.
  it('component languageCode is optional', () => {
    const payload = validPayload();
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.path === 'componentAssessments[0].languageCode')).toBe(false);
  });

  it('component languageCode outside SUPPORTED_LANGS fails', () => {
    const payload = validPayload();
    (payload.componentAssessments as Array<Record<string, unknown>>)[0].languageCode = 'de';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(
      errors.some(
        (e) => e.code === 'INVALID_ENUM' && e.path === 'componentAssessments[0].languageCode',
      ),
    ).toBe(true);
  });

  it('component languageCode from SUPPORTED_LANGS passes', () => {
    const payload = validPayload();
    (payload.componentAssessments as Array<Record<string, unknown>>)[0].languageCode = 'fr';
    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
    expect(errors.some((e) => e.path === 'componentAssessments[0].languageCode')).toBe(false);
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

  it('accepts nested component territory assessments and uses them for target coverage', () => {
    const payload = validPayload();
    payload.territoryDecisions = [];
    (payload.componentAssessments as Array<Record<string, unknown>>)[0].territoryAssessments = [
      {
        countryCode: 'us',
        status: 'ALLOWED',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
        publicDomainFromYear: 1928,
        sourceEvidenceIds: ['evidence-1'],
      },
      {
        countryCode: 'FR',
        status: 'PENDING_REVIEW',
        accessPolicy: 'REVIEW_REQUIRED',
        geoBlockRequired: false,
        reasonRu: 'Нужна дополнительная проверка.',
        rightsExpireAt: null,
        confidence: 'MEDIUM',
      },
      {
        countryCode: 'GB',
        status: 'ALLOWED',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
      },
    ];

    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);

    expect(errors).toEqual([]);
  });

  it('rejects invalid nested component territory assessment fields', () => {
    const payload = validPayload();
    (payload.componentAssessments as Array<Record<string, unknown>>)[0].territoryAssessments = [
      {
        countryCode: 'USA',
        status: 'UNKNOWN',
        accessPolicy: 'BLOCK',
        geoBlockRequired: 'yes',
        publicDomainFromYear: 1928.5,
        rightsExpireAt: 'not-a-date',
        sourceEvidenceIds: ['evidence-1', 2],
      },
    ];

    const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('countryCode') }),
        expect.objectContaining({ path: expect.stringContaining('status') }),
        expect.objectContaining({ path: expect.stringContaining('geoBlockRequired') }),
        expect.objectContaining({ path: expect.stringContaining('reasonRu') }),
        expect.objectContaining({ path: expect.stringContaining('publicDomainFromYear') }),
        expect.objectContaining({ path: expect.stringContaining('rightsExpireAt') }),
        expect.objectContaining({ path: expect.stringContaining('sourceEvidenceIds') }),
      ]),
    );
  });

  it('warns when a component restriction conflicts with a top-level allow', () => {
    const payload = validPayload();
    (payload.componentAssessments as Array<Record<string, unknown>>)[0].territoryAssessments = [
      {
        countryCode: 'US',
        status: 'BLOCKED',
        accessPolicy: 'BLOCK',
        geoBlockRequired: true,
        reasonRu: 'Компонент защищён.',
      },
    ];

    const { warnings } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);

    expect(warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'COMPONENT_TERRITORY_CONFLICT' })]),
    );
  });

  // WP-6.1 (R4-01): наличие полей, которые NOT NULL в schema.prisma. До правки отчёт без них
  // проходил как VALIDATED и ронял материализацию 500-й.
  describe('required fields of nested blocks', () => {
    const expectMissing = (payload: Record<string, unknown>, path: string): void => {
      const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
      expect(errors.some((e) => e.code === 'MISSING_FIELD' && e.path === path)).toBe(true);
    };

    it.each(REQUIRED_REPORT_FIELDS.territoryDecisions.filter((field) => field !== 'countryCode'))(
      'territoryDecisions[0] without %s fails',
      (field) => {
        const payload = validPayload();
        delete (payload.territoryDecisions as Array<Record<string, unknown>>)[0][field];
        expectMissing(payload, `territoryDecisions[0].${field}`);
      },
    );

    it.each(REQUIRED_REPORT_FIELDS.componentAssessments)(
      'componentAssessments[0] without %s fails',
      (field) => {
        const payload = validPayload();
        delete (payload.componentAssessments as Array<Record<string, unknown>>)[0][field];
        expectMissing(payload, `componentAssessments[0].${field}`);
      },
    );

    it.each(REQUIRED_REPORT_FIELDS.evidence)('evidence[0] without %s fails', (field) => {
      const payload = validPayload();
      delete (payload.evidence as Array<Record<string, unknown>>)[0][field];
      expectMissing(payload, `evidence[0].${field}`);
    });

    it('requiredActions[0] without actionType fails', () => {
      const payload = validPayload();
      payload.requiredActions = [{ descriptionRu: 'Удалить иллюстрации', isBlocking: false }];
      expectMissing(payload, 'requiredActions[0].actionType');
    });

    // descriptionRu — NOT NULL независимо от isBlocking; блокирующее действие сохраняет
    // собственный код ошибки ТЗ фазы 3.
    it('non-blocking requiredActions[0] without descriptionRu fails', () => {
      const payload = validPayload();
      payload.requiredActions = [{ actionType: 'RECHECK_LATER', isBlocking: false }];
      expectMissing(payload, 'requiredActions[0].descriptionRu');
    });

    it('sourceAssessment without status fails', () => {
      const payload = validPayload();
      delete (payload.sourceAssessment as Record<string, unknown>).status;
      expectMissing(payload, 'sourceAssessment.status');
    });

    // WP-7.1: языковой блок стал приёмником модели прав, поэтому обязательны все поля,
    // без которых запись `EditionRights` не имеет смысла.
    it.each(REQUIRED_REPORT_FIELDS.languageAssessments)(
      'languageAssessments[0] without %s fails',
      (field) => {
        const payload = validPayload();
        delete (payload.languageAssessments as Array<Record<string, unknown>>)[0][field];
        expectMissing(payload, `languageAssessments[0].${field}`);
      },
    );

    it('requiresGeoBlock=false is an answer, not a missing field', () => {
      const payload = validPayload();
      (payload.languageAssessments as Array<Record<string, unknown>>)[0].requiresGeoBlock = false;
      const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);
      expect(errors.some((e) => e.path === 'languageAssessments[0].requiresGeoBlock')).toBe(false);
    });

    // Промежуточный перевод — единственный случай, где цепочка прав идёт через третий язык.
    it('intermediate translation without translationSourceLanguage fails', () => {
      const payload = validPayload();
      (payload.languageAssessments as Array<Record<string, unknown>>)[1].translationOrigin =
        'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION';
      expectMissing(payload, 'languageAssessments[1].translationSourceLanguage');
    });

    it('blank string counts as missing', () => {
      const payload = validPayload();
      (payload.territoryDecisions as Array<Record<string, unknown>>)[0].reasonRu = '   ';
      expectMissing(payload, 'territoryDecisions[0].reasonRu');
    });

    it('a non-object array element is reported instead of crashing the validator', () => {
      const payload = validPayload();
      (payload.territoryDecisions as unknown[])[0] = null;

      const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);

      expect(
        errors.some((e) => e.code === 'INVALID_TYPE' && e.path === 'territoryDecisions[0]'),
      ).toBe(true);
    });

    it('a complete report produces no MISSING_FIELD errors', () => {
      const { errors } = validator.validate(
        validPayload(),
        INTAKE_ID,
        TARGET_LANGUAGES,
        TARGET_COUNTRIES,
      );
      expect(errors.filter((e) => e.code === 'MISSING_FIELD')).toEqual([]);
    });
  });

  // Phase 15: optional licenses[] block
  describe('licenses block', () => {
    const licensedPayload = (): Record<string, unknown> => {
      const payload = validPayload();
      payload.licenses = [
        {
          key: 'license:penguin-2019',
          licenseType: 'DIRECT_LICENSE',
          status: 'ACTIVE',
          title: 'Лицензия на перевод',
          licensor: 'Penguin Random House',
          territoryScope: 'COUNTRY_LIST',
          countryCodes: ['FR'],
          languageCodes: ['fr'],
          mediaFormats: ['TEXT_ONLINE'],
          translationAllowed: true,
          isPerpetual: true,
        },
      ];
      return payload;
    };

    it('accepts a valid licenses block without errors', () => {
      const { errors } = validator.validate(
        licensedPayload(),
        INTAKE_ID,
        TARGET_LANGUAGES,
        TARGET_COUNTRIES,
      );
      expect(errors).toEqual([]);
    });

    it('rejects an unknown licenseType', () => {
      const payload = licensedPayload();
      (payload.licenses as Array<Record<string, unknown>>)[0].licenseType = 'MADE_UP';

      const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);

      expect(
        errors.some((e) => e.code === 'INVALID_ENUM' && e.path === 'licenses[0].licenseType'),
      ).toBe(true);
    });

    it('rejects a duplicate license key', () => {
      const payload = licensedPayload();
      const licenses = payload.licenses as Array<Record<string, unknown>>;
      licenses.push({ ...licenses[0] });

      const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);

      expect(errors.some((e) => e.code === 'DUPLICATE_LICENSE_KEY')).toBe(true);
    });

    it('rejects a licenseRef pointing at an unknown key', () => {
      const payload = licensedPayload();
      (payload.territoryDecisions as Array<Record<string, unknown>>)[1].licenseRef =
        'license:does-not-exist';

      const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);

      expect(errors.some((e) => e.code === 'INVALID_REFERENCE')).toBe(true);
    });

    it('requires a licenseRef for an ALLOWED_BY_LICENSE country', () => {
      const payload = licensedPayload();
      (payload.territoryDecisions as Array<Record<string, unknown>>)[1].finalStatus =
        'ALLOWED_BY_LICENSE';

      const { errors } = validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);

      expect(errors.some((e) => e.code === 'MISSING_LICENSE_REF')).toBe(true);
    });

    it('warns when a LICENSE_REQUIRED country is not covered by any declared license', () => {
      const payload = licensedPayload();
      (payload.territoryDecisions as Array<Record<string, unknown>>)[0].finalStatus =
        'LICENSE_REQUIRED';

      const { warnings } = validator.validate(
        payload,
        INTAKE_ID,
        TARGET_LANGUAGES,
        TARGET_COUNTRIES,
      );

      expect(warnings.some((w) => w.code === 'LICENSE_REQUIRED_WITHOUT_LICENSE')).toBe(true);
    });

    it('leaves legacy reports without a licenses block untouched', () => {
      const { errors, warnings } = validator.validate(
        validPayload(),
        INTAKE_ID,
        TARGET_LANGUAGES,
        TARGET_COUNTRIES,
      );

      expect(errors).toEqual([]);
      expect(warnings.some((w) => w.code.startsWith('LICENSE'))).toBe(false);
      expect(warnings.some((w) => w.code === 'COMPONENT_LICENSED_WITHOUT_LICENSE_REF')).toBe(false);
    });
  });
});
