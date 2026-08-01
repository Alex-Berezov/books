import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';
import {
  ComponentTerritoryAggregationService,
  type ComponentTerritoryAggregationComponent,
} from './component-territory-aggregation.service';

const createComponent = (
  overrides: Partial<ComponentTerritoryAggregationComponent> = {},
): ComponentTerritoryAggregationComponent => ({
  rightsComponentId: 'component-1',
  componentType: 'ORIGINAL_TEXT',
  titleRu: 'Оригинальный текст',
  status: 'PUBLIC_DOMAIN',
  requiredAction: 'KEEP',
  confidence: 'HIGH',
  territoryAssessments: [
    {
      countryCode: 'US',
      status: 'ALLOWED',
      accessPolicy: 'ALLOW',
      geoBlockRequired: false,
      confidence: 'HIGH',
    },
  ],
  ...overrides,
});

describe('ComponentTerritoryAggregationService', () => {
  const service = new ComponentTerritoryAggregationService();

  it('allows a country when all applicable components are allowed', () => {
    const result = service.aggregateTerritoryDecisionsFromComponents({
      rightsProfileId: 'profile-1',
      components: [createComponent()],
      targetCountryCodes: ['US'],
    });

    expect(result).toEqual([
      expect.objectContaining({
        countryCode: 'US',
        finalStatus: 'ALLOWED',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
      }),
    ]);
  });

  // WP-3.2: a country the aggregation marks BLOCKED is closed as a whole. Deriving the scope from
  // the blocking component left the audio edition of a forbidden text reachable (R6-01).
  it('blocks the whole edition when one text component is blocked', () => {
    const result = service.aggregateTerritoryDecisionsFromComponents({
      rightsProfileId: 'profile-1',
      components: [
        createComponent({
          territoryAssessments: [
            {
              countryCode: 'GB',
              status: 'BLOCKED',
              accessPolicy: 'BLOCK',
              geoBlockRequired: true,
              confidence: 'MEDIUM',
              legalBasisRu: 'Translation term is active.',
            },
          ],
        }),
      ],
    });

    expect(result[0]).toEqual(
      expect.objectContaining({
        finalStatus: 'BLOCKED',
        accessPolicy: 'BLOCK',
        geoBlockRequired: true,
        geoBlockScope: GeoBlockScope.LANGUAGE_EDITION,
        confidence: 'MEDIUM',
        legalBasisRu: 'Translation term is active.',
      }),
    );
    expect(result[0].reasonRu).toContain('Оригинальный текст');
  });

  it('blocks the whole edition when an audio component is blocked', () => {
    const result = service.aggregateTerritoryDecisionsFromComponents({
      rightsProfileId: 'profile-1',
      components: [
        createComponent({
          componentType: 'AUDIO_RECORDING',
          titleRu: 'Аудиозапись',
          territoryAssessments: [
            {
              countryCode: 'GB',
              status: 'BLOCKED',
              accessPolicy: 'BLOCK',
              geoBlockRequired: true,
            },
          ],
        }),
      ],
    });

    expect(result[0].geoBlockScope).toBe(GeoBlockScope.LANGUAGE_EDITION);
  });

  it('uses LANGUAGE_EDITION scope when different component types are blocked', () => {
    const result = service.aggregateTerritoryDecisionsFromComponents({
      rightsProfileId: 'profile-1',
      components: [
        createComponent({
          territoryAssessments: [
            {
              countryCode: 'GB',
              status: 'BLOCKED',
              accessPolicy: 'BLOCK',
              geoBlockRequired: true,
            },
          ],
        }),
        createComponent({
          rightsComponentId: 'component-2',
          componentType: 'COVER',
          titleRu: 'Обложка',
          territoryAssessments: [
            {
              countryCode: 'GB',
              status: 'BLOCKED',
              accessPolicy: 'BLOCK',
              geoBlockRequired: true,
            },
          ],
        }),
      ],
    });

    expect(result[0].geoBlockScope).toBe(GeoBlockScope.LANGUAGE_EDITION);
  });

  it('creates pending review and uses the lowest problematic confidence', () => {
    const result = service.aggregateTerritoryDecisionsFromComponents({
      rightsProfileId: 'profile-1',
      components: [
        createComponent({
          territoryAssessments: [
            {
              countryCode: 'GB',
              status: 'PENDING_REVIEW',
              accessPolicy: 'REVIEW_REQUIRED',
              geoBlockRequired: false,
              confidence: 'LOW',
              reasonRu: 'Нужно проверить срок.',
            },
          ],
        }),
      ],
    });

    expect(result[0]).toEqual(
      expect.objectContaining({
        finalStatus: 'PENDING_REVIEW',
        accessPolicy: 'REVIEW_REQUIRED',
        confidence: 'LOW',
      }),
    );
  });

  it('creates pending review when a target country misses an applicable component assessment', () => {
    const result = service.aggregateTerritoryDecisionsFromComponents({
      rightsProfileId: 'profile-1',
      components: [createComponent()],
      targetCountryCodes: ['GB'],
    });

    expect(result[0]).toEqual(
      expect.objectContaining({
        countryCode: 'GB',
        finalStatus: 'PENDING_REVIEW',
        accessPolicy: 'REVIEW_REQUIRED',
      }),
    );
    expect(result[0].reasonRu).toContain('Нет компонентной оценки');
  });

  it('does not allow an assessment whose rights date has expired', () => {
    const result = service.aggregateTerritoryDecisionsFromComponents({
      rightsProfileId: 'profile-1',
      components: [
        createComponent({
          territoryAssessments: [
            {
              countryCode: 'US',
              status: 'ALLOWED',
              accessPolicy: 'ALLOW',
              geoBlockRequired: false,
              rightsExpireAt: new Date('2026-01-01T00:00:00.000Z'),
            },
          ],
        }),
      ],
      now: new Date('2026-07-27T00:00:00.000Z'),
    });

    expect(result[0].accessPolicy).toBe('REVIEW_REQUIRED');
    expect(result[0].finalStatus).toBe('PENDING_REVIEW');
  });

  it('keeps a component blocker over a top-level allow decision', () => {
    const result = service.aggregateTerritoryDecisionsFromComponents({
      rightsProfileId: 'profile-1',
      components: [
        createComponent({
          territoryAssessments: [
            {
              countryCode: 'GB',
              status: 'BLOCKED',
              accessPolicy: 'BLOCK',
              geoBlockRequired: true,
            },
          ],
        }),
      ],
      existingTerritoryDecisions: [
        {
          countryCode: 'GB',
          finalStatus: 'ALLOWED',
          accessPolicy: 'ALLOW',
          geoBlockRequired: false,
          reasonRu: 'Profile says allow.',
          confidence: 'HIGH',
        },
      ],
    });

    expect(result[0].accessPolicy).toBe('BLOCK');
  });

  it('keeps a stricter profile-level block as an explicit override', () => {
    const result = service.aggregateTerritoryDecisionsFromComponents({
      rightsProfileId: 'profile-1',
      components: [createComponent()],
      existingTerritoryDecisions: [
        {
          countryCode: 'US',
          finalStatus: 'BLOCKED',
          accessPolicy: 'BLOCK',
          geoBlockRequired: true,
          geoBlockScope: 'ENTIRE_BOOK',
          reasonRu: 'Separate profile restriction.',
          confidence: 'MEDIUM',
        },
      ],
    });

    expect(result[0]).toEqual(
      expect.objectContaining({
        accessPolicy: 'BLOCK',
        geoBlockScope: GeoBlockScope.ENTIRE_BOOK,
        reasonRu: 'Profile-level override: Separate profile restriction.',
      }),
    );
  });
  // Phase 15: ALLOWED_BY_LICENSE
  describe('license-based clearance', () => {
    const licensedComponent = (overrides: Partial<ComponentTerritoryAggregationComponent> = {}) =>
      createComponent({
        rightsComponentId: 'component-licensed',
        componentType: 'TRANSLATION',
        titleRu: 'Перевод',
        status: 'LICENSED',
        territoryAssessments: [
          {
            countryCode: 'US',
            status: 'ALLOWED_BY_LICENSE',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            confidence: 'HIGH',
          },
        ],
        ...overrides,
      });

    it('aggregates a fully licensed country to ALLOWED_BY_LICENSE', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [licensedComponent()],
        targetCountryCodes: ['US'],
      });

      expect(result[0]).toEqual(
        expect.objectContaining({
          countryCode: 'US',
          finalStatus: 'ALLOWED_BY_LICENSE',
          accessPolicy: 'ALLOW',
          geoBlockRequired: false,
        }),
      );
      expect(result[0].reasonRu).toContain('лицензии');
    });

    it('reports ALLOWED_BY_LICENSE when public-domain and licensed components are mixed', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [createComponent(), licensedComponent()],
        targetCountryCodes: ['US'],
      });

      expect(result[0].finalStatus).toBe('ALLOWED_BY_LICENSE');
      expect(result[0].accessPolicy).toBe('ALLOW');
    });

    it('lets a blocking component win over a licensed one', () => {
      const blocked = createComponent({
        rightsComponentId: 'component-blocked',
        componentType: 'ILLUSTRATION',
        titleRu: 'Иллюстрации',
        status: 'COPYRIGHTED',
        territoryAssessments: [
          {
            countryCode: 'US',
            status: 'BLOCKED',
            accessPolicy: 'BLOCK',
            geoBlockRequired: true,
            reasonRu: 'Иллюстрации под охраной.',
            confidence: 'HIGH',
          },
        ],
      });

      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [licensedComponent(), blocked],
        targetCountryCodes: ['US'],
      });

      expect(result[0].finalStatus).toBe('BLOCKED');
      expect(result[0].accessPolicy).toBe('BLOCK');
    });
  });
});
