import { NotFoundException } from '@nestjs/common';
import { BookVersionService } from './book-version.service';
import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { TerritoryRegionAggregationService } from '../rights-intake/territory-region-aggregation.service';
import { RightsProfileService } from '../rights-intake/rights-profile.service';
import { AuthorService } from '../author/author.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoIpCountryService } from '../geo-block/geo-ip-country.service';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { RightsClaimsService } from '../rights-claims/rights-claims.service';
import { RightsRecheckService } from '../rights-recheck/rights-recheck.service';
import { RightsLawyerReviewService } from '../rights-lawyer/rights-lawyer-review.service';
import { RightsClearanceLockService } from '../rights-intake/rights-clearance-lock.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * `LEGACY-412`. Дашборд версии раньше собирал профиль прав своей выборкой Prisma мимо
 * `RightsProfileService.mapToDetail`, и поле, добавленное в контракт ручки профиля, само на
 * дашборд не попадало (так уже вышло с журналом участников — `LEGACY-037`, регрессия жила
 * тут же под этим именем до сведения путей). Теперь дашборд зовёт `RightsProfileService.getById`
 * напрямую: этот файл сторожит саму делегацию (тот же `profileId`, ровно один вызов, отсутствие
 * блока при отсутствии клиренса и при удалённой строке профиля), а не форму ответа — форму
 * профиля, включая журнал участников, проверяет `rights-intake/rights-profile.service.spec.ts`.
 */
describe('BookVersionService.getRightsDashboard — один источник профиля прав (LEGACY-412)', () => {
  const PROFILE_ID = 'profile-1';
  const VERSION_ID = 'version-1';

  const emptyFindMany = () => jest.fn().mockResolvedValue([]);

  const buildService = (
    getById: jest.Mock,
    profileId: string | null,
    versionCoverage: Record<string, unknown> = {
      status: 'NOT_REQUIRED',
      requiredCountryCodes: [],
      coveredCountryCodes: [],
      uncoveredCountryCodes: [],
    },
  ) => {
    const prisma = {
      bookVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: VERSION_ID,
          bookId: 'book-1',
          rightsProfileId: profileId,
          book: {
            id: 'book-1',
            slug: 'test-book',
            rightsIntakeId: null,
            currentRightsProfileId: profileId,
            approvedRightsReviewId: null,
            rightsCreatedAt: null,
          },
        }),
        findMany: emptyFindMany(),
      },
      rightsIntake: { findUnique: jest.fn().mockResolvedValue(null) },
      rightsReviewApproval: { findMany: emptyFindMany() },
      rightsReview: { findMany: emptyFindMany() },
      rightsClaim: { findMany: emptyFindMany() },
      rightsLicense: { findMany: emptyFindMany() },
      rightsLicenseLink: { findMany: emptyFindMany() },
      geoBlockRule: { findMany: emptyFindMany() },
    };

    const service = new BookVersionService(
      prisma as unknown as PrismaService,
      {
        checkVersionCanPublish: jest.fn().mockResolvedValue({ canPublish: true, reasons: [] }),
      } as unknown as PublicationGateService,
      {
        checkVersionStaleness: jest.fn().mockResolvedValue({ isStale: false }),
      } as unknown as RightsContentHashService,
      { assertAccess: jest.fn() } as unknown as GeoBlockRuleService,
      {
        loadLicensesForProfile: jest.fn().mockResolvedValue([]),
        evaluateVersionCoverage: jest.fn().mockResolvedValue(versionCoverage),
        effectiveStatus: jest.fn().mockReturnValue('ACTIVE'),
        isActiveAt: jest.fn().mockReturnValue(false),
      } as unknown as RightsLicenseCoverageService,
      {
        listForVersion: jest.fn().mockResolvedValue([]),
        summarizeForVersion: jest.fn().mockResolvedValue(null),
      } as unknown as RightsClaimsService,
      {
        getVersionRecheck: jest.fn().mockResolvedValue({ tasks: [], schedule: null }),
      } as unknown as RightsRecheckService,
      {
        getVersionLawyerReview: jest.fn().mockResolvedValue(null),
      } as unknown as RightsLawyerReviewService,
      { getSourceHealth: jest.fn().mockReturnValue(null) } as unknown as GeoIpCountryService,
      {} as unknown as SlugRedirectService,
      {} as unknown as AdminAuditService,
      {} as unknown as RightsClearanceLockService,
      {} as unknown as AuthorService,
      { getById } as unknown as RightsProfileService,
      new TerritoryRegionAggregationService(),
    );

    return service;
  };

  it('зовёт RightsProfileService.getById тем же id, что использует ручка профиля, и отдаёт его ответ как есть', async () => {
    const getById = jest.fn().mockResolvedValue({
      id: PROFILE_ID,
      overallStatus: 'PUBLISHABLE',
      confidence: 'HIGH',
      territoryDecisions: [],
      actions: [],
      components: [],
      evidence: [],
      contributors: [],
      // Поле, которого на этом пути раньше не было (LEGACY-037): проезжает без отдельной
      // проекции ровно потому, что дашборд больше не строит профиль сам.
      contributorEvents: [{ id: 'event-1', eventType: 'UNLINKED' }],
      regionalTerritorySummary: [],
    });
    const service = buildService(getById, PROFILE_ID);

    const dashboard = (await service.getRightsDashboard(VERSION_ID)) as unknown as {
      currentProfile: { contributorEvents: Array<Record<string, unknown>> } | null;
    };

    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith(PROFILE_ID);
    expect(dashboard.currentProfile?.contributorEvents).toEqual([
      { id: 'event-1', eventType: 'UNLINKED' },
    ]);
  });

  it('не зовёт getById и оставляет профиль пустым, когда клиренса нет', async () => {
    const getById = jest.fn();
    const service = buildService(getById, null);

    const dashboard = (await service.getRightsDashboard(VERSION_ID)) as unknown as {
      currentProfile: unknown;
    };

    expect(getById).not.toHaveBeenCalled();
    expect(dashboard.currentProfile).toBeNull();
  });

  it('не падает 500, если profileId указывает на уже удалённую строку профиля', async () => {
    const getById = jest.fn().mockRejectedValue(new NotFoundException('gone'));
    const service = buildService(getById, PROFILE_ID);

    const dashboard = (await service.getRightsDashboard(VERSION_ID)) as unknown as {
      currentProfile: unknown;
    };

    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith(PROFILE_ID);
    expect(dashboard.currentProfile).toBeNull();
  });

  it('берёт счётчики участников из проекции, а не считает их вторым правилом', async () => {
    const getById = jest.fn().mockResolvedValue({
      id: PROFILE_ID,
      // Состав намеренно расходится со счётчиками: источник числа — проекция, а не пересчёт.
      contributors: [],
      contributorsCount: 5,
      authorsCount: 2,
      translatorsCount: 1,
      narratorsCount: 1,
      contributorsWithoutPersonCount: 3,
    });
    const service = buildService(getById, PROFILE_ID);

    const dashboard = await service.getRightsDashboard(VERSION_ID);

    expect(dashboard.summary).toEqual(
      expect.objectContaining({
        contributorsCount: 5,
        authorsCount: 2,
        translatorsCount: 1,
        narratorsCount: 1,
        contributorsWithoutPersonCount: 3,
      }),
    );
  });

  it('держит счётчики стран лицензий в профиле согласованными с покрытием версии', async () => {
    const getById = jest.fn().mockResolvedValue({
      id: PROFILE_ID,
      // Посчитаны проекцией по профилю — на дашборде покрытие по версии, числа обязаны смениться.
      licenseRequiredCountriesCount: 0,
      licenseCoveredCountriesCount: 0,
      licenseUncoveredCountriesCount: 0,
    });
    const service = buildService(getById, PROFILE_ID, {
      status: 'PARTIAL',
      requiredCountryCodes: ['DE', 'FR'],
      coveredCountryCodes: ['DE'],
      uncoveredCountryCodes: ['FR'],
    });

    const dashboard = (await service.getRightsDashboard(VERSION_ID)) as unknown as {
      currentProfile: Record<string, unknown>;
    };

    expect(dashboard.currentProfile).toEqual(
      expect.objectContaining({
        licenseRequiredCountriesCount: 2,
        licenseCoveredCountriesCount: 1,
        licenseUncoveredCountriesCount: 1,
      }),
    );
  });

  it('считает сводку регионов по интейку книги из ответа, а не берёт сводку интейка профиля', async () => {
    const getById = jest.fn().mockResolvedValue({
      id: PROFILE_ID,
      territoryDecisions: [],
      regionalTerritorySummary: [{ regionCode: 'FROM_PROFILE_INTAKE', status: 'BLOCKED' }],
    });
    const service = buildService(getById, PROFILE_ID);

    const dashboard = (await service.getRightsDashboard(VERSION_ID)) as unknown as {
      currentProfile: { regionalTerritorySummary: unknown[] };
      summary: { regionCount: number; blockedRegionCount: number };
    };

    const expected = new TerritoryRegionAggregationService().aggregateTerritoryDecisions([], []);
    expect(dashboard.currentProfile.regionalTerritorySummary).toEqual(expected);
    expect(dashboard.summary.regionCount).toBe(expected.length);
    expect(dashboard.summary.blockedRegionCount).toBe(0);
  });

  it('не подменяет лицензии профиля узкой формой дашборда', async () => {
    const projectedLicense = {
      id: 'lic-1',
      effectiveStatus: 'ACTIVE',
      languageCodes: ['es'],
      mediaFormats: ['EBOOK'],
    };
    const getById = jest.fn().mockResolvedValue({ id: PROFILE_ID, licenses: [projectedLicense] });
    const service = buildService(getById, PROFILE_ID);

    const dashboard = (await service.getRightsDashboard(VERSION_ID)) as unknown as {
      currentProfile: { licenses: unknown[] };
    };

    expect(dashboard.currentProfile.licenses).toEqual([projectedLicense]);
  });

  // Отказ базы — не «профиля нет»: глушить его в пустой блок нельзя (L-013).
  it('пробрасывает прочие отказы getById, а не выдаёт их за отсутствие профиля', async () => {
    const failure = new Error('connection lost');
    const getById = jest.fn().mockRejectedValue(failure);
    const service = buildService(getById, PROFILE_ID);

    await expect(service.getRightsDashboard(VERSION_ID)).rejects.toBe(failure);
  });
});
