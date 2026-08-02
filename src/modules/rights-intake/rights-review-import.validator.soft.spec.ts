import { RightsReviewImportValidator } from './rights-review-import.validator';

/**
 * WP-G: мягкая техническая валидация импорта. Каждый пункт проверяется с двух сторон —
 * смягчённый случай проходит, несмягчённый по-прежнему отклоняется.
 */

const TARGET_LANGUAGES = ['en', 'fr'];
const TARGET_COUNTRIES = ['US', 'FR'];
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
      status: 'NOT_TARGETED',
      translationOrigin: 'UNKNOWN',
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

const withComponentTerritory = (payload: Record<string, unknown>, patch: unknown): void => {
  const components = payload['componentAssessments'] as Array<Record<string, unknown>>;
  components[0]['territoryAssessments'] = patch;
};

describe('RightsReviewImportValidator — WP-G soft validation', () => {
  let validator: RightsReviewImportValidator;

  const run = (payload: Record<string, unknown>) =>
    validator.validate(payload, INTAKE_ID, TARGET_LANGUAGES, TARGET_COUNTRIES);

  beforeEach(() => {
    validator = new RightsReviewImportValidator();
  });

  describe('G.1 — null читается как отсутствие поля', () => {
    it('contributors[].sourceEvidenceIds = null не является ошибкой типа', () => {
      const payload = validPayload();
      payload['contributors'] = [
        { key: 'a1', role: 'AUTHOR', displayName: 'Edgar Allan Poe', sourceEvidenceIds: null },
      ];

      const { errors } = run(payload);
      expect(errors).toEqual([]);
    });

    it('обратная сторона: строка вместо массива по-прежнему ошибка', () => {
      const payload = validPayload();
      payload['contributors'] = [
        { key: 'a1', role: 'AUTHOR', displayName: 'Edgar Allan Poe', sourceEvidenceIds: 'ev-1' },
      ];

      const { errors } = run(payload);
      expect(
        errors.some(
          (e) => e.code === 'INVALID_TYPE' && e.path === 'contributors[0].sourceEvidenceIds',
        ),
      ).toBe(true);
    });

    it('territoryAssessments = null читается как отсутствие блока', () => {
      const payload = validPayload();
      withComponentTerritory(payload, null);

      const { errors } = run(payload);
      expect(errors).toEqual([]);
    });

    it('обратная сторона: строка вместо territoryAssessments по-прежнему ошибка', () => {
      const payload = validPayload();
      withComponentTerritory(payload, 'нет');

      const { errors } = run(payload);
      expect(errors.some((e) => e.code === 'NOT_ARRAY')).toBe(true);
    });

    it('confidence = null во вложенной оценке читается как отсутствие', () => {
      const payload = validPayload();
      withComponentTerritory(payload, [
        {
          countryCode: 'US',
          status: 'ALLOWED',
          accessPolicy: 'ALLOW',
          geoBlockRequired: false,
          confidence: null,
          sourceEvidenceIds: null,
        },
      ]);

      const { errors } = run(payload);
      expect(errors).toEqual([]);
    });

    it('обратная сторона: неизвестное confidence во вложенной оценке по-прежнему ошибка', () => {
      const payload = validPayload();
      withComponentTerritory(payload, [
        {
          countryCode: 'US',
          status: 'ALLOWED',
          accessPolicy: 'ALLOW',
          geoBlockRequired: false,
          confidence: 'MAYBE',
        },
      ]);

      const { errors } = run(payload);
      expect(
        errors.some(
          (e) =>
            e.code === 'INVALID_ENUM' &&
            e.path === 'componentAssessments[0].territoryAssessments[0].confidence',
        ),
      ).toBe(true);
    });
  });

  describe('G.2 — reasonRu и confidence условны на верхнем уровне', () => {
    it('разрешающее решение не обязано объяснять, почему разрешено', () => {
      const payload = validPayload();
      payload['territoryDecisions'] = [
        { countryCode: 'US', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
        { countryCode: 'FR', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
      ];

      const { errors } = run(payload);
      expect(errors).toEqual([]);
    });

    it('обратная сторона: ограничивающее решение без reasonRu по-прежнему ошибка', () => {
      const payload = validPayload();
      payload['publicationGate'] = 'BLOCK';
      payload['overallStatus'] = 'REJECTED';
      payload['territoryDecisions'] = [
        { countryCode: 'US', finalStatus: 'BLOCKED', accessPolicy: 'BLOCK' },
        { countryCode: 'FR', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
      ];

      const { errors } = run(payload);
      expect(
        errors.some(
          (e) => e.code === 'MISSING_FIELD' && e.path === 'territoryDecisions[0].reasonRu',
        ),
      ).toBe(true);
      expect(
        errors.some(
          (e) => e.code === 'MISSING_FIELD' && e.path === 'territoryDecisions[0].confidence',
        ),
      ).toBe(true);
    });

    it('обратная сторона: разрешение с геоблокировкой по-прежнему требует объяснения', () => {
      const payload = validPayload();
      payload['publicationGate'] = 'ALLOW_AFTER_GEO_CONFIGURATION';
      payload['territoryDecisions'] = [
        {
          countryCode: 'US',
          finalStatus: 'ALLOWED',
          accessPolicy: 'ALLOW',
          geoBlockRequired: true,
          geoBlockScope: 'ENTIRE_BOOK',
        },
        { countryCode: 'FR', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
      ];

      const { errors } = run(payload);
      expect(
        errors.some(
          (e) => e.code === 'MISSING_FIELD' && e.path === 'territoryDecisions[0].reasonRu',
        ),
      ).toBe(true);
    });
  });

  describe('G.3 — регистр кода страны', () => {
    it('строчный код принимается и засчитывается за целевую страну', () => {
      const payload = validPayload();
      (payload['territoryDecisions'] as Array<Record<string, unknown>>)[0]['countryCode'] = 'us';

      const { errors } = run(payload);
      expect(errors).toEqual([]);
    });

    it('обратная сторона: код не из двух букв по-прежнему ошибка', () => {
      const payload = validPayload();
      (payload['territoryDecisions'] as Array<Record<string, unknown>>)[0]['countryCode'] = 'usa';

      const { errors } = run(payload);
      expect(
        errors.some(
          (e) =>
            e.code === 'INVALID_COUNTRY_CODE' && e.path === 'territoryDecisions[0].countryCode',
        ),
      ).toBe(true);
    });
  });

  describe('G.4 — синонимы enum', () => {
    it('finalStatus = PUBLIC_DOMAIN импортируется с предупреждением', () => {
      const payload = validPayload();
      (payload['territoryDecisions'] as Array<Record<string, unknown>>)[0]['finalStatus'] =
        'PUBLIC_DOMAIN';

      const { errors, warnings } = run(payload);
      expect(errors).toEqual([]);
      expect(warnings.some((w) => w.code === 'ENUM_SYNONYM_NORMALIZED')).toBe(true);
    });

    it('обратная сторона: незнакомое значение по-прежнему ошибка', () => {
      const payload = validPayload();
      (payload['territoryDecisions'] as Array<Record<string, unknown>>)[0]['finalStatus'] = 'PD';

      const { errors } = run(payload);
      expect(
        errors.some(
          (e) => e.code === 'INVALID_ENUM' && e.path === 'territoryDecisions[0].finalStatus',
        ),
      ).toBe(true);
    });
  });

  describe('G.5 — оценка целевого языка как предупреждение', () => {
    it('интейк на язык без реального перевода не требует фиктивной записи', () => {
      const payload = validPayload();
      payload['languageAssessments'] = [
        {
          languageCode: 'en',
          status: 'ALLOWED',
          translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
          requiresGeoBlock: false,
        },
      ];

      const { errors, warnings } = run(payload);
      expect(errors.some((e) => e.code === 'MISSING_LANGUAGE_ASSESSMENT')).toBe(false);
      expect(warnings.some((w) => w.code === 'MISSING_LANGUAGE_ASSESSMENT')).toBe(true);
    });

    it('обратная сторона: присланная оценка с неизвестным языком по-прежнему ошибка', () => {
      const payload = validPayload();
      (payload['languageAssessments'] as Array<Record<string, unknown>>)[1]['languageCode'] = 'de';

      const { errors } = run(payload);
      expect(
        errors.some(
          (e) => e.code === 'INVALID_ENUM' && e.path === 'languageAssessments[1].languageCode',
        ),
      ).toBe(true);
    });
  });

  describe('G.6 — отсутствующая коллекция равна пустой', () => {
    it('отчёт без requiredActions и evidence проходит валидацию', () => {
      const payload = validPayload();
      delete payload['requiredActions'];
      delete payload['evidence'];

      const { errors, warnings } = run(payload);
      expect(errors).toEqual([]);
      expect(warnings.some((w) => w.code === 'EMPTY_ARRAY' && w.path === 'evidence')).toBe(true);
    });

    it('обратная сторона: не массив по-прежнему ошибка', () => {
      const payload = validPayload();
      payload['requiredActions'] = 'нет действий';

      const { errors } = run(payload);
      expect(errors.some((e) => e.code === 'NOT_ARRAY' && e.path === 'requiredActions')).toBe(true);
    });
  });

  describe('G.7 — null в contributors не роняет валидатор', () => {
    it('даёт ошибку валидации вместо исключения', () => {
      const payload = validPayload();
      payload['contributors'] = [null];

      const { errors } = run(payload);
      expect(errors.some((e) => e.code === 'INVALID_TYPE' && e.path === 'contributors[0]')).toBe(
        true,
      );
    });

    it('обратная сторона: объект без обязательных полей по-прежнему ошибка', () => {
      const payload = validPayload();
      payload['contributors'] = [{}];

      const { errors } = run(payload);
      expect(errors.some((e) => e.path === 'contributors[0].key')).toBe(true);
      expect(errors.some((e) => e.path === 'contributors[0].displayName')).toBe(true);
    });
  });

  describe('G.8 — симметрия cross-field', () => {
    it('избыточный запрет — предупреждение, а не ошибка', () => {
      const payload = validPayload();
      payload['publicationGate'] = 'BLOCK';

      const { errors, warnings } = run(payload);
      expect(errors).toEqual([]);
      expect(warnings.some((w) => w.code === 'REDUNDANT_BLOCK_GATE')).toBe(true);
    });

    it('обратная сторона: избыточное разрешение по-прежнему ошибка', () => {
      const payload = validPayload();
      (payload['territoryDecisions'] as Array<Record<string, unknown>>)[0]['accessPolicy'] =
        'BLOCK';

      const { errors } = run(payload);
      expect(errors.some((e) => e.code === 'ALLOW_BLOCK_CONFLICT')).toBe(true);
    });
  });
});
