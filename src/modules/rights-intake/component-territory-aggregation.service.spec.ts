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

  it('blocks text access when one text component is blocked', () => {
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
        geoBlockScope: GeoBlockScope.TEXT_READER,
        confidence: 'MEDIUM',
        legalBasisRu: 'Translation term is active.',
      }),
    );
    expect(result[0].reasonRu).toContain('Оригинальный текст');
  });

  it('uses AUDIO scope for a blocked audio component', () => {
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

    expect(result[0].geoBlockScope).toBe(GeoBlockScope.AUDIO);
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
});
