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
        finalStatus: 'ALLOWED',
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
      { countryCode: 'FR', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
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
      { countryCode: 'JP', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
      { countryCode: 'IN', finalStatus: 'BLOCKED', accessPolicy: 'BLOCK' },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const otherRegion = result.find((r) => r.regionCode === 'OTHER');

    expect(otherRegion).toBeDefined();
    expect(otherRegion?.status).toBe('MIXED');
    expect(otherRegion?.countries.map((c) => c.countryCode)).toEqual(['JP', 'IN']);
  });

  it('7. NOT_TARGETED when region has no matching countries', () => {
    const decisions = [{ countryCode: 'US', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' }];

    const result = service.aggregateTerritoryDecisions(decisions);
    const caRegion = result.find((r) => r.regionCode === 'CA');

    expect(caRegion).toBeDefined();
    expect(caRegion?.status).toBe('NOT_TARGETED');
    expect(caRegion?.targetedCountryCount).toBe(0);
    expect(caRegion?.notTargetedCountryCount).toBe(1);
  });

  it('8. No duplicate countries across groups (fixed group country does not appear in OTHER)', () => {
    const decisions = [
      { countryCode: 'US', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
      { countryCode: 'FR', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
      { countryCode: 'JP', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
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

  /**
   * WP-10.5 (R6-03): `NOT_TARGETED` — «этот рынок не обслуживается», а не «вопрос открыт».
   * До правки такая страна падала в `else`-ветку счётчиков, инкрементила
   * `pendingReviewCountryCount`, попадала в `blockingReasons` и переводила регион,
   * все целевые страны которого разрешены, из `ALLOWED` в `MIXED`.
   */
  it('does not treat a NOT_TARGETED country as pending or as a blocking reason', () => {
    const decisions = [
      {
        countryCode: 'AU',
        finalStatus: 'ALLOWED',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
        reasonRu: 'Общественное достояние.',
      },
      {
        countryCode: 'NZ',
        finalStatus: 'NOT_TARGETED',
        accessPolicy: 'REVIEW_REQUIRED',
        geoBlockRequired: false,
        reasonRu: 'Рынок не входит в план публикации.',
      },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const region = result.find((r) => r.regionCode === 'AU_NZ');

    expect(region?.pendingReviewCountryCount).toBe(0);
    expect(region?.blockingReasons).toHaveLength(0);
    expect(region?.targetedCountryCount).toBe(1);
    expect(region?.allowedCountryCount).toBe(1);
    expect(region?.notTargetedCountryCount).toBe(1);
    expect(region?.status).toBe('ALLOWED');
  });

  it('reports a region as NOT_TARGETED when every decision says the market is not served', () => {
    const decisions = [
      { countryCode: 'AU', finalStatus: 'NOT_TARGETED', accessPolicy: 'REVIEW_REQUIRED' },
      { countryCode: 'NZ', finalStatus: 'NOT_TARGETED', accessPolicy: 'REVIEW_REQUIRED' },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const region = result.find((r) => r.regionCode === 'AU_NZ');

    expect(region?.status).toBe('NOT_TARGETED');
    expect(region?.targetedCountryCount).toBe(0);
    expect(region?.notTargetedCountryCount).toBe(2);
    expect(region?.pendingReviewCountryCount).toBe(0);
  });

  /**
   * WP-10.5 (R6-04): статус региона считался только по странам, у которых есть решение,
   * поэтому ЕС с тремя разрешёнными странами из 27 отдавался как `ALLOWED` при
   * `notTargetedCountryCount: 24`. Зелёный ярлык на регионе, 89 % стран которого никто
   * не смотрел, — ложное разрешение.
   */
  it('does not report a region as ALLOWED while most of its countries have no decision at all', () => {
    const decisions = [
      { countryCode: 'FR', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
      { countryCode: 'DE', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
      { countryCode: 'IT', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const euRegion = result.find((r) => r.regionCode === 'EU');

    expect(euRegion?.status).toBe('MIXED');
    expect(euRegion?.targetedCountryCount).toBe(3);
    expect(euRegion?.allowedCountryCount).toBe(3);
    expect(euRegion?.notTargetedCountryCount).toBe(24);
    expect(euRegion?.undecidedCountryCount).toBe(24);
  });

  /**
   * WP-10.5 (R6-04): `notTargetedCountryCount` складывает две разные вещи — страну,
   * по которой решения нет вообще, и страну, по которой решение принято и звучит как
   * «рынок не обслуживается». Для редактора это противоположные задачи, поэтому доля
   * «никто не смотрел» отдаётся отдельным числом.
   */
  it('separates countries with no decision from countries deliberately not targeted', () => {
    const decisions = [
      { countryCode: 'FR', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
      { countryCode: 'DE', finalStatus: 'NOT_TARGETED', accessPolicy: 'REVIEW_REQUIRED' },
      { countryCode: 'IT', finalStatus: 'NOT_TARGETED', accessPolicy: 'REVIEW_REQUIRED' },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const euRegion = result.find((r) => r.regionCode === 'EU');

    expect(euRegion?.targetedCountryCount).toBe(1);
    expect(euRegion?.notTargetedCountryCount).toBe(26);
    expect(euRegion?.undecidedCountryCount).toBe(24);
  });

  /**
   * WP-10.4 (R6-05): агрегация писалась по `essence-of-copyright.md`, а не по
   * `schema.prisma`, и трактовала как «разрешено» значение `PUBLIC_DOMAIN`, которого
   * в enum'е `TerritoryRightsStatus` нет. Незнакомый статус обязан толковаться в пользу
   * проверки, а не публикации.
   */
  it('does not treat a status outside TerritoryRightsStatus as allowed', () => {
    const decisions = [
      {
        countryCode: 'US',
        finalStatus: 'PUBLIC_DOMAIN',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
        reasonRu: 'Значение вне enum TerritoryRightsStatus.',
      },
    ];

    const result = service.aggregateTerritoryDecisions(decisions);
    const usRegion = result.find((r) => r.regionCode === 'US');

    expect(usRegion?.allowedCountryCount).toBe(0);
    expect(usRegion?.pendingReviewCountryCount).toBe(1);
    expect(usRegion?.status).toBe('PENDING_REVIEW');
    expect(usRegion?.blockingReasons).toHaveLength(1);
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
