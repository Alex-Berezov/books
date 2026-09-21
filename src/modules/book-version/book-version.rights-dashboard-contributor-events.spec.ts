import { BookVersionService } from './book-version.service';
import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { TerritoryRegionAggregationService } from '../rights-intake/territory-region-aggregation.service';
import { CONTRIBUTOR_EVENTS_LIMIT } from '../rights-intake/rights-profile-contributor-event.mapper';
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
 * `LEGACY-037`. Дашборд версии — **второй** путь, которым админка получает профиль прав,
 * и собирает он его своей выборкой мимо `RightsProfileService.mapToDetail`. Поле, добавленное
 * в ручку профиля, сюда само не попадает: вкладка «Права» книжной карточки молча оставалась
 * без истории, а поле необязательное, так что отказ был невидимым.
 *
 * Решение арбитра 21.09.2026 (`decisions-log.md`): выборка, потолок и проекция берутся
 * из общей точки; класть события через `include` сырой выборки нельзя — под тем же именем
 * уехали бы `payload` сырым `Json` и `createdAt` объектом `Date`.
 */
describe('BookVersionService.getRightsDashboard — журнал связей участников (LEGACY-037)', () => {
  const PROFILE_ID = 'profile-1';
  const VERSION_ID = 'version-1';

  const makeEventRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'event-1',
    rightsProfileId: PROFILE_ID,
    rightsProfileContributorId: 'link-1',
    rightsComponentId: null,
    sourceEditionId: 'se-1',
    personId: 'person-1',
    eventType: 'UNLINKED',
    role: 'TRANSLATOR',
    displayName: 'Иван Иванов',
    creditedName: 'И. Иванов',
    payload: {
      canonicalName: 'Иванов, Иван',
      birthYear: 1901,
      deathYear: 1975,
      nationalityCountryCode: 'RU',
      notesRu: 'перевод с французского',
      linkedAt: '2026-08-01T00:00:00.000Z',
    },
    createdByUserId: 'admin-1',
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  });

  const emptyFindMany = () => jest.fn().mockResolvedValue([]);

  const buildService = (eventRows: Array<Record<string, unknown>>) => {
    const contributorEventFindMany = jest.fn().mockResolvedValue(eventRows);

    const prisma = {
      bookVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: VERSION_ID,
          bookId: 'book-1',
          rightsProfileId: PROFILE_ID,
          book: {
            id: 'book-1',
            slug: 'test-book',
            rightsIntakeId: null,
            currentRightsProfileId: PROFILE_ID,
            approvedRightsReviewId: null,
            rightsCreatedAt: null,
          },
        }),
        findMany: emptyFindMany(),
      },
      rightsIntake: { findUnique: jest.fn().mockResolvedValue(null) },
      rightsReviewApproval: { findMany: emptyFindMany() },
      rightsProfile: {
        findUnique: jest.fn().mockResolvedValue({
          id: PROFILE_ID,
          sourceEdition: null,
          components: [],
          territoryDecisions: [],
          evidence: [],
          actions: [],
          contributors: [],
        }),
      },
      rightsProfileContributorEvent: { findMany: contributorEventFindMany },
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
        evaluateVersionCoverage: jest.fn().mockReturnValue({
          status: 'NOT_REQUIRED',
          requiredCountryCodes: [],
          coveredCountryCodes: [],
          uncoveredCountryCodes: [],
        }),
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
      new TerritoryRegionAggregationService(),
    );

    return { service, contributorEventFindMany };
  };

  const dashboardProfile = async (
    eventRows: Array<Record<string, unknown>>,
  ): Promise<{
    events: Array<Record<string, unknown>>;
    contributorEventFindMany: jest.Mock;
  }> => {
    const { service, contributorEventFindMany } = buildService(eventRows);
    const dashboard = (await service.getRightsDashboard(VERSION_ID)) as unknown as {
      currentProfile: { contributorEvents: Array<Record<string, unknown>> } | null;
    };
    return {
      events: dashboard.currentProfile?.contributorEvents ?? [],
      contributorEventFindMany,
    };
  };

  it('отдаёт журнал связей в профиле дашборда, а не оставляет вкладку без истории', async () => {
    const { events } = await dashboardProfile([makeEventRow()]);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('UNLINKED');
    expect(events[0].rightsProfileContributorId).toBe('link-1');
  });

  it('раскладывает payload в типизированный snapshot, а не отдаёт сырой Json', async () => {
    const { events } = await dashboardProfile([makeEventRow()]);

    expect(events[0]).not.toHaveProperty('payload');
    expect(events[0].snapshot).toEqual({
      canonicalName: 'Иванов, Иван',
      birthYear: 1901,
      deathYear: 1975,
      nationalityCountryCode: 'RU',
      notesRu: 'перевод с французского',
      linkedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('отдаёт createdAt строкой ISO, а не объектом Date', async () => {
    const { events } = await dashboardProfile([makeEventRow()]);

    expect(events[0].createdAt).toBe('2026-09-01T10:00:00.000Z');
    expect(events[0].createdAt).not.toBeInstanceOf(Date);
  });

  it('режет историю тем же потолком и порядком, что ручка профиля', async () => {
    const { contributorEventFindMany } = await dashboardProfile([]);

    expect(contributorEventFindMany).toHaveBeenCalledTimes(1);
    expect(contributorEventFindMany).toHaveBeenCalledWith({
      where: { rightsProfileId: PROFILE_ID },
      orderBy: { createdAt: 'desc' },
      take: CONTRIBUTOR_EVENTS_LIMIT,
    });
  });
});
