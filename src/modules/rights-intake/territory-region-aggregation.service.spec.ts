import { TerritoryRegionAggregationService } from './territory-region-aggregation.service';

describe('TerritoryRegionAggregationService', () => {
  let service: TerritoryRegionAggregationService;

  beforeEach(() => {
    service = new TerritoryRegionAggregationService();
  });

  it('1. US allowed -> region US.status = ALLOWED', () => {
    const decisions = [
      {
        countryCode: 'US',
        finalStatus: 'PUBLIC_DOMAIN',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
        reasonRu: 'Public domain in US',
      },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const usRegion = result.find((r) => r.regionCode === 'US');

    expect(usRegion).toBeDefined();
    expect(usRegion?.status).toBe('ALLOWED');
    expect(usRegion?.targetedCountryCount).toBe(1);
    expect(usRegion?.allowedCountryCount).toBe(1);
    expect(usRegion?.blockingReasons).toHaveLength(0);
  });

  it('2. UK blocked -> UK.status = BLOCKED and blockingReasons contains GB', () => {
    const decisions = [
      {
        countryCode: 'GB',
        finalStatus: 'BLOCKED',
        accessPolicy: 'BLOCK',
        geoBlockRequired: true,
        reasonRu: 'Copyrighted in UK',
      },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const ukRegion = result.find((r) => r.regionCode === 'UK');

    expect(ukRegion).toBeDefined();
    expect(ukRegion?.status).toBe('BLOCKED');
    expect(ukRegion?.blockedCountryCount).toBe(1);
    expect(ukRegion?.blockingReasons).toHaveLength(1);
    expect(ukRegion?.blockingReasons[0].countryCode).toBe('GB');
  });

  it('3. EU mixed -> EU.status = MIXED with correct counts', () => {
    const decisions = [
      { countryCode: 'FR', finalStatus: 'PUBLIC_DOMAIN', accessPolicy: 'ALLOW' },
      { countryCode: 'DE', finalStatus: 'BLOCKED', accessPolicy: 'BLOCK' },
      { countryCode: 'ES', finalStatus: 'LICENSE_REQUIRED', accessPolicy: 'REVIEW_REQUIRED' },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const euRegion = result.find((r) => r.regionCode === 'EU');

    expect(euRegion).toBeDefined();
    expect(euRegion?.status).toBe('MIXED');
    expect(euRegion?.targetedCountryCount).toBe(3);
    expect(euRegion?.allowedCountryCount).toBe(1);
    expect(euRegion?.blockedCountryCount).toBe(1);
    expect(euRegion?.licenseRequiredCountryCount).toBe(1);
    expect(euRegion?.blockingReasons).toHaveLength(2); // DE & ES
  });

  it('4. LATAM license required -> LATAM.status = LICENSE_REQUIRED', () => {
    const decisions = [
      { countryCode: 'MX', finalStatus: 'LICENSE_REQUIRED', accessPolicy: 'REVIEW_REQUIRED' },
      { countryCode: 'BR', finalStatus: 'LICENSE_REQUIRED', accessPolicy: 'REVIEW_REQUIRED' },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const latamRegion = result.find((r) => r.regionCode === 'LATAM');

    expect(latamRegion).toBeDefined();
    expect(latamRegion?.status).toBe('LICENSE_REQUIRED');
    expect(latamRegion?.licenseRequiredCountryCount).toBe(2);
  });

  it('5. RU_MARKETS pending -> RU_MARKETS.status = PENDING_REVIEW', () => {
    const decisions = [
      { countryCode: 'RU', finalStatus: 'PENDING_REVIEW', accessPolicy: 'REVIEW_REQUIRED' },
      { countryCode: 'KZ', finalStatus: 'NOT_CHECKED', accessPolicy: 'REVIEW_REQUIRED' },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const ruRegion = result.find((r) => r.regionCode === 'RU_MARKETS');

    expect(ruRegion).toBeDefined();
    expect(ruRegion?.status).toBe('PENDING_REVIEW');
    expect(ruRegion?.pendingReviewCountryCount).toBe(2);
  });

  it('6. OTHER collects unknown grouped countries (JP, IN)', () => {
    const decisions = [
      { countryCode: 'JP', finalStatus: 'PUBLIC_DOMAIN', accessPolicy: 'ALLOW' },
      { countryCode: 'IN', finalStatus: 'BLOCKED', accessPolicy: 'BLOCK' },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const otherRegion = result.find((r) => r.regionCode === 'OTHER');

    expect(otherRegion).toBeDefined();
    expect(otherRegion?.status).toBe('MIXED');
    expect(otherRegion?.countries.map((c) => c.countryCode)).toEqual(['JP', 'IN']);
  });

  it('7. NOT_TARGETED when region has no matching countries', () => {
    const decisions = [{ countryCode: 'US', finalStatus: 'PUBLIC_DOMAIN', accessPolicy: 'ALLOW' }];

    const result = service.aggregateTerritoryDecisions(decisions);
    const caRegion = result.find((r) => r.regionCode === 'CA');

    expect(caRegion).toBeDefined();
    expect(caRegion?.status).toBe('NOT_TARGETED');
    expect(caRegion?.targetedCountryCount).toBe(0);
    expect(caRegion?.notTargetedCountryCount).toBe(1);
  });

  it('8. No duplicate countries across groups (fixed group country does not appear in OTHER)', () => {
    const decisions = [
      { countryCode: 'US', finalStatus: 'PUBLIC_DOMAIN', accessPolicy: 'ALLOW' },
      { countryCode: 'FR', finalStatus: 'PUBLIC_DOMAIN', accessPolicy: 'ALLOW' },
      { countryCode: 'JP', finalStatus: 'PUBLIC_DOMAIN', accessPolicy: 'ALLOW' },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const otherRegion = result.find((r) => r.regionCode === 'OTHER');

    expect(otherRegion).toBeDefined();
    expect(otherRegion?.countries.map((c) => c.countryCode)).toEqual(['JP']);
  });
  // Phase 15: ALLOWED_BY_LICENSE counts as allowed and is tracked separately
  it('counts ALLOWED_BY_LICENSE countries as allowed and licensed', () => {
    const decisions = [
      {
        countryCode: 'US',
        finalStatus: 'ALLOWED_BY_LICENSE',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
        reasonRu: 'Публикация разрешена на основании лицензии.',
      },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const usRegion = result.find((r) => r.regionCode === 'US');

    expect(usRegion?.status).toBe('ALLOWED');
    expect(usRegion?.allowedCountryCount).toBe(1);
    expect(usRegion?.licensedCountryCount).toBe(1);
    expect(usRegion?.blockingReasons).toHaveLength(0);
  });

  it('does not count a licensed country that is nevertheless blocked', () => {
    const decisions = [
      {
        countryCode: 'GB',
        finalStatus: 'ALLOWED_BY_LICENSE',
        accessPolicy: 'BLOCK',
        geoBlockRequired: true,
        reasonRu: 'Лицензия отозвана.',
      },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const ukRegion = result.find((r) => r.regionCode === 'UK');

    expect(ukRegion?.licensedCountryCount).toBe(0);
    expect(ukRegion?.blockedCountryCount).toBe(1);
  });
});
