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
  // WP-5.5: a component the report only *promises* to remove is still part of the edition until a
  // human closes the matching removal action. Clearing the country on the promise declared a market
  // open while the illustration or preface that closed it was physically still there (R6-06).
  describe('components promised for removal', () => {
    const blockingIllustration = () =>
      createComponent({
        rightsComponentId: 'component-illustration',
        componentType: 'ILLUSTRATION',
        titleRu: 'Иллюстрации',
        status: 'COPYRIGHTED',
        requiredAction: 'REMOVE',
        territoryAssessments: [
          {
            countryCode: 'GB',
            status: 'BLOCKED',
            accessPolicy: 'BLOCK',
            geoBlockRequired: true,
            reasonRu: 'Иллюстрации под охраной.',
            confidence: 'HIGH',
          },
        ],
      });

    it('counts a component marked for removal while the removal is unconfirmed', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [blockingIllustration()],
        targetCountryCodes: ['GB'],
      });

      expect(result[0]).toEqual(
        expect.objectContaining({
          countryCode: 'GB',
          finalStatus: 'BLOCKED',
          accessPolicy: 'BLOCK',
        }),
      );
      expect(result[0].reasonRu).toContain('Иллюстрации');
    });

    it('counts an EXCLUDED component while the removal is unconfirmed', () => {
      const excluded = blockingIllustration();
      excluded.status = 'EXCLUDED';
      excluded.requiredAction = 'KEEP';

      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [excluded],
        targetCountryCodes: ['GB'],
      });

      expect(result[0].finalStatus).toBe('BLOCKED');
    });

    it('drops the component once the removal is confirmed', () => {
      const allowedText = createComponent({
        territoryAssessments: [
          {
            countryCode: 'GB',
            status: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            confidence: 'HIGH',
          },
        ],
      });

      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [allowedText, blockingIllustration()],
        targetCountryCodes: ['GB'],
        componentRemovalsConfirmed: true,
      });

      expect(result[0]).toEqual(
        expect.objectContaining({
          countryCode: 'GB',
          finalStatus: 'ALLOWED',
          accessPolicy: 'ALLOW',
        }),
      );
    });
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

    // WP-4.1: a component that needs a license is an actionable verdict, not an open question.
    // Reporting the country as PENDING_REVIEW dropped it out of the coverage check of Phase 15,
    // and its gate blocker is one no license can lift (R6-02).
    const licenseRequiredComponent = (
      overrides: Partial<ComponentTerritoryAggregationComponent> = {},
    ) =>
      createComponent({
        rightsComponentId: 'component-license-required',
        componentType: 'TRANSLATION',
        titleRu: 'Немецкий перевод',
        status: 'COPYRIGHTED',
        requiredAction: 'OBTAIN_LICENSE',
        territoryAssessments: [
          {
            countryCode: 'DE',
            status: 'LICENSE_REQUIRED',
            accessPolicy: 'REVIEW_REQUIRED',
            geoBlockRequired: false,
            confidence: 'HIGH',
            legalBasisRu: 'Права на перевод у издательства.',
          },
        ],
        ...overrides,
      });

    it('reports a country that needs a license as LICENSE_REQUIRED', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [licenseRequiredComponent()],
        targetCountryCodes: ['DE'],
      });

      expect(result[0]).toEqual(
        expect.objectContaining({
          countryCode: 'DE',
          finalStatus: 'LICENSE_REQUIRED',
          accessPolicy: 'REVIEW_REQUIRED',
          geoBlockRequired: false,
          geoBlockScope: null,
          legalBasisRu: 'Права на перевод у издательства.',
          confidence: 'HIGH',
        }),
      );
      expect(result[0].reasonRu).toContain('Немецкий перевод');
    });

    it('keeps the geo-block requirement of the license-required assessment', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [
          licenseRequiredComponent({
            territoryAssessments: [
              {
                countryCode: 'DE',
                status: 'LICENSE_REQUIRED',
                accessPolicy: 'REVIEW_REQUIRED',
                geoBlockRequired: true,
                confidence: 'MEDIUM',
              },
            ],
          }),
        ],
        targetCountryCodes: ['DE'],
      });

      expect(result[0]).toEqual(
        expect.objectContaining({
          finalStatus: 'LICENSE_REQUIRED',
          geoBlockRequired: true,
          geoBlockScope: GeoBlockScope.LANGUAGE_EDITION,
        }),
      );
    });

    // WP-B.1: компонент берётся защищённый и уже оценённый по другой стране — именно такой
    // пробел остаётся проблемой. Пропуск оценки у public-domain компонента с этого пакета
    // проблемой не считается.
    it('still reports PENDING_REVIEW when another component is unassessed', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [
          licenseRequiredComponent(),
          createComponent({ status: 'COPYRIGHTED', requiredAction: 'VERIFY' }),
        ],
        targetCountryCodes: ['DE'],
      });

      expect(result[0].finalStatus).toBe('PENDING_REVIEW');
      expect(result[0].reasonRu).toContain('Нет компонентной оценки');
    });

    it('still reports PENDING_REVIEW when the rights of the license-required component expired', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [
          licenseRequiredComponent({
            territoryAssessments: [
              {
                countryCode: 'DE',
                status: 'LICENSE_REQUIRED',
                accessPolicy: 'REVIEW_REQUIRED',
                geoBlockRequired: false,
                rightsExpireAt: new Date('2026-01-01T00:00:00.000Z'),
              },
            ],
          }),
        ],
        targetCountryCodes: ['DE'],
        now: new Date('2026-08-01T00:00:00.000Z'),
      });

      expect(result[0].finalStatus).toBe('PENDING_REVIEW');
    });

    it('lets a blocking component win over a license-required one', () => {
      const blocked = createComponent({
        rightsComponentId: 'component-blocked',
        componentType: 'ILLUSTRATION',
        titleRu: 'Иллюстрации',
        status: 'COPYRIGHTED',
        territoryAssessments: [
          {
            countryCode: 'DE',
            status: 'BLOCKED',
            accessPolicy: 'BLOCK',
            geoBlockRequired: true,
          },
        ],
      });

      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [licenseRequiredComponent(), blocked],
        targetCountryCodes: ['DE'],
      });

      expect(result[0].finalStatus).toBe('BLOCKED');
      expect(result[0].accessPolicy).toBe('BLOCK');
    });

    it('keeps the profile-level license requirement over an allowed component decision', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [createComponent()],
        existingTerritoryDecisions: [
          {
            countryCode: 'US',
            finalStatus: 'LICENSE_REQUIRED',
            accessPolicy: 'REVIEW_REQUIRED',
            geoBlockRequired: false,
            reasonRu: 'Нужна лицензия на публикацию в США.',
            confidence: 'HIGH',
          },
        ],
      });

      expect(result[0].finalStatus).toBe('LICENSE_REQUIRED');
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

  // WP-B: манифест до WP-F безусловно заказывал агенту обложку и озвучку, поэтому честный
  // подробный отчёт оказывался хуже пустого — компонент, которого в издании нет, ронял все
  // страны в PENDING_REVIEW. Ослабление сужено: страна без единой компонентной оценки и
  // компонент, помеченный к удалению без подтверждения, остаются проблемой (R6-06).
  describe('WP-B: missing component assessment', () => {
    const originalText = (countryCodes: string[]) =>
      createComponent({
        rightsComponentId: 'component-text',
        territoryAssessments: countryCodes.map((countryCode) => ({
          countryCode,
          status: 'ALLOWED' as const,
          accessPolicy: 'ALLOW' as const,
          geoBlockRequired: false,
          confidence: 'HIGH' as const,
          legalBasisRu: 'Автор умер в 1849 году.',
        })),
      });

    const speculativeCover = () =>
      createComponent({
        rightsComponentId: 'component-cover',
        componentType: 'COVER',
        titleRu: 'Обложка',
        status: 'UNCERTAIN',
        requiredAction: 'VERIFY',
        confidence: 'LOW',
        territoryAssessments: [],
      });

    it('B.1: does not treat a component the agent never assessed by country as a problem', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [originalText(['US', 'GB']), speculativeCover()],
        targetCountryCodes: ['US', 'GB'],
      });

      expect(result).toHaveLength(2);
      for (const decision of result) {
        expect(decision.finalStatus).toBe('ALLOWED');
        expect(decision.accessPolicy).toBe('ALLOW');
      }
    });

    it('B.1: keeps PENDING_REVIEW when an assessed protected component skips a target country', () => {
      const illustrations = createComponent({
        rightsComponentId: 'component-illustration',
        componentType: 'ILLUSTRATION',
        titleRu: 'Иллюстрации',
        status: 'COPYRIGHTED',
        requiredAction: 'VERIFY',
        territoryAssessments: [
          {
            countryCode: 'US',
            status: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            confidence: 'HIGH',
          },
        ],
      });

      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [originalText(['US', 'GB']), illustrations],
        targetCountryCodes: ['GB'],
      });

      const gb = result.find((decision) => decision.countryCode === 'GB');
      expect(gb?.finalStatus).toBe('PENDING_REVIEW');
      expect(gb?.reasonRu).toContain('Иллюстрации');
    });

    it('B.1: keeps PENDING_REVIEW when no component assessed the country at all', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [originalText(['US']), speculativeCover()],
        targetCountryCodes: ['FR'],
      });

      const fr = result.find((decision) => decision.countryCode === 'FR');
      expect(fr?.finalStatus).toBe('PENDING_REVIEW');
      expect(fr?.accessPolicy).toBe('REVIEW_REQUIRED');
    });

    it('B.1: an EXCLUDED component assessed elsewhere still blocks an unassessed country until removal is confirmed', () => {
      const excludedWrapper = createComponent({
        rightsComponentId: 'component-wrapper',
        componentType: 'OTHER',
        titleRu: 'Обвязка Gutenberg',
        status: 'EXCLUDED',
        requiredAction: 'REMOVE',
        territoryAssessments: [
          {
            countryCode: 'US',
            status: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            confidence: 'HIGH',
          },
        ],
      });

      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [originalText(['US', 'GB']), excludedWrapper],
        targetCountryCodes: ['GB'],
      });

      const gb = result.find((decision) => decision.countryCode === 'GB');
      expect(gb?.finalStatus).toBe('PENDING_REVIEW');
      expect(gb?.reasonRu).toContain('Обвязка Gutenberg');
    });

    it('B.2: marks a decision derived only from missing assessments', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [
          originalText(['US']),
          createComponent({
            rightsComponentId: 'component-translation',
            componentType: 'TRANSLATION',
            titleRu: 'Перевод',
            status: 'COPYRIGHTED',
            requiredAction: 'VERIFY',
            territoryAssessments: [
              {
                countryCode: 'FR',
                status: 'ALLOWED',
                accessPolicy: 'ALLOW',
                geoBlockRequired: false,
                confidence: 'HIGH',
              },
            ],
          }),
        ],
        targetCountryCodes: ['US'],
      });

      const us = result.find((decision) => decision.countryCode === 'US');
      expect(us?.finalStatus).toBe('PENDING_REVIEW');
      expect(us?.derivedFromMissingAssessment).toBe(true);
    });

    it('B.2: does not mark a decision that rests on a real REVIEW_REQUIRED assessment', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [
          createComponent({
            status: 'UNCERTAIN',
            requiredAction: 'VERIFY',
            territoryAssessments: [
              {
                countryCode: 'US',
                status: 'PENDING_REVIEW',
                accessPolicy: 'REVIEW_REQUIRED',
                geoBlockRequired: false,
                reasonRu: 'Нужна проверка срока охраны.',
                confidence: 'MEDIUM',
              },
            ],
          }),
        ],
        targetCountryCodes: ['US'],
      });

      expect(result[0].finalStatus).toBe('PENDING_REVIEW');
      expect(result[0].derivedFromMissingAssessment).not.toBe(true);
    });

    it('B.3: a substantiated agent decision survives a review derived from emptiness', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [
          originalText(['US']),
          createComponent({
            rightsComponentId: 'component-translation',
            componentType: 'TRANSLATION',
            titleRu: 'Перевод',
            status: 'COPYRIGHTED',
            requiredAction: 'VERIFY',
            territoryAssessments: [
              {
                countryCode: 'FR',
                status: 'ALLOWED',
                accessPolicy: 'ALLOW',
                geoBlockRequired: false,
                confidence: 'HIGH',
              },
            ],
          }),
        ],
        targetCountryCodes: ['US'],
        existingTerritoryDecisions: [
          {
            countryCode: 'US',
            finalStatus: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            reasonRu: 'Public domain: автор умер в 1849 году.',
            legalBasisRu: '17 U.S.C. § 304, публикация до 1929 года.',
            confidence: 'HIGH',
          },
        ],
      });

      const us = result.find((decision) => decision.countryCode === 'US');
      expect(us?.accessPolicy).toBe('ALLOW');
      expect(us?.finalStatus).toBe('ALLOWED');
      expect(us?.reasonRu).toContain('Public domain');
    });

    it('B.3: an agent decision without reasoning does not survive', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [
          originalText(['US']),
          createComponent({
            rightsComponentId: 'component-translation',
            componentType: 'TRANSLATION',
            titleRu: 'Перевод',
            status: 'COPYRIGHTED',
            requiredAction: 'VERIFY',
            territoryAssessments: [
              {
                countryCode: 'FR',
                status: 'ALLOWED',
                accessPolicy: 'ALLOW',
                geoBlockRequired: false,
                confidence: 'HIGH',
              },
            ],
          }),
        ],
        targetCountryCodes: ['US'],
        existingTerritoryDecisions: [
          {
            countryCode: 'US',
            finalStatus: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            reasonRu: '   ',
            legalBasisRu: null,
            confidence: 'HIGH',
          },
        ],
      });

      const us = result.find((decision) => decision.countryCode === 'US');
      expect(us?.accessPolicy).toBe('REVIEW_REQUIRED');
      expect(us?.finalStatus).toBe('PENDING_REVIEW');
    });

    it('B.3: an agent decision with LOW confidence does not survive', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [
          originalText(['US']),
          createComponent({
            rightsComponentId: 'component-translation',
            componentType: 'TRANSLATION',
            titleRu: 'Перевод',
            status: 'COPYRIGHTED',
            requiredAction: 'VERIFY',
            territoryAssessments: [
              {
                countryCode: 'FR',
                status: 'ALLOWED',
                accessPolicy: 'ALLOW',
                geoBlockRequired: false,
                confidence: 'HIGH',
              },
            ],
          }),
        ],
        targetCountryCodes: ['US'],
        existingTerritoryDecisions: [
          {
            countryCode: 'US',
            finalStatus: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            reasonRu: 'Скорее всего public domain.',
            legalBasisRu: 'Предположительно срок истёк.',
            confidence: 'LOW',
          },
        ],
      });

      const us = result.find((decision) => decision.countryCode === 'US');
      expect(us?.accessPolicy).toBe('REVIEW_REQUIRED');
    });

    it('B.3: a substantiated agent allow does not survive a real component review', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [
          createComponent({
            status: 'UNCERTAIN',
            requiredAction: 'VERIFY',
            territoryAssessments: [
              {
                countryCode: 'US',
                status: 'PENDING_REVIEW',
                accessPolicy: 'REVIEW_REQUIRED',
                geoBlockRequired: false,
                reasonRu: 'Нужна проверка срока охраны.',
                confidence: 'MEDIUM',
              },
            ],
          }),
        ],
        targetCountryCodes: ['US'],
        existingTerritoryDecisions: [
          {
            countryCode: 'US',
            finalStatus: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            reasonRu: 'Public domain: автор умер в 1849 году.',
            legalBasisRu: '17 U.S.C. § 304.',
            confidence: 'HIGH',
          },
        ],
      });

      expect(result[0].accessPolicy).toBe('REVIEW_REQUIRED');
      expect(result[0].finalStatus).toBe('PENDING_REVIEW');
    });
  });

  describe('WP-C.2: страны вне плана публикации', () => {
    it('C.2: a country mentioned only in passing becomes NOT_TARGETED instead of PENDING_REVIEW', () => {
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
                confidence: 'HIGH',
              },
            ],
          }),
          createComponent({
            rightsComponentId: 'component-cover',
            componentType: 'COVER',
            titleRu: 'Обложка',
            status: 'UNCERTAIN',
            requiredAction: 'VERIFY',
            territoryAssessments: [
              {
                countryCode: 'JP',
                status: 'PENDING_REVIEW',
                accessPolicy: 'REVIEW_REQUIRED',
                geoBlockRequired: false,
                reasonRu: 'Нужна проверка.',
                confidence: 'LOW',
              },
            ],
          }),
        ],
        targetCountryCodes: ['US'],
      });

      const jp = result.find((decision) => decision.countryCode === 'JP');
      expect(jp?.finalStatus).toBe('NOT_TARGETED');
      expect(jp?.accessPolicy).not.toBe('BLOCK');
      expect(jp?.geoBlockRequired).toBe(false);
    });

    it('C.2: обратная сторона — явный запрет вне плана публикации остаётся запретом', () => {
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
                confidence: 'HIGH',
              },
              {
                countryCode: 'DE',
                status: 'BLOCKED',
                accessPolicy: 'BLOCK',
                geoBlockRequired: true,
                legalBasisRu: 'Срок охраны перевода не истёк.',
                confidence: 'HIGH',
              },
            ],
          }),
        ],
        targetCountryCodes: ['US'],
      });

      const de = result.find((decision) => decision.countryCode === 'DE');
      expect(de?.finalStatus).toBe('BLOCKED');
      expect(de?.accessPolicy).toBe('BLOCK');
    });

    it('C.2: обратная сторона — запрет из решения агента вне плана публикации остаётся запретом', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [createComponent()],
        targetCountryCodes: ['US'],
        existingTerritoryDecisions: [
          {
            countryCode: 'DE',
            finalStatus: 'BLOCKED',
            accessPolicy: 'BLOCK',
            geoBlockRequired: true,
            reasonRu: 'Права на перевод активны.',
            confidence: 'HIGH',
          },
        ],
      });

      const de = result.find((decision) => decision.countryCode === 'DE');
      expect(de?.finalStatus).toBe('BLOCKED');
      expect(de?.accessPolicy).toBe('BLOCK');
    });

    it('C.2: без плана публикации набор стран прежний — ни одна не считается нецелевой', () => {
      const result = service.aggregateTerritoryDecisionsFromComponents({
        rightsProfileId: 'profile-1',
        components: [
          createComponent({
            status: 'UNCERTAIN',
            requiredAction: 'VERIFY',
            territoryAssessments: [
              {
                countryCode: 'JP',
                status: 'PENDING_REVIEW',
                accessPolicy: 'REVIEW_REQUIRED',
                geoBlockRequired: false,
                reasonRu: 'Нужна проверка.',
                confidence: 'LOW',
              },
            ],
          }),
        ],
      });

      expect(result[0].countryCode).toBe('JP');
      expect(result[0].finalStatus).toBe('PENDING_REVIEW');
    });
  });
});
