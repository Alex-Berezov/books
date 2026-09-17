import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  BookType,
  GeoBlockScope,
  Language,
  RightsClaimBlockStatus,
  RightsClaimSeverity,
  RightsClaimStatus,
  RightsClaimType,
  RightsLicenseLinkType,
  RightsLicenseMediaFormat,
  RightsLicenseTerritoryScope,
  type PrismaClient,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CLAIM_SEVERITY_RANK } from '../src/modules/rights-claims/rights-claim.constants';
import { RightsLicenseCoverageService } from '../src/modules/rights-licenses/rights-license-coverage.service';
import {
  RightsLicenseMediaFormat as CoverageMediaFormat,
  type RightsLicenseRecord,
} from '../src/modules/rights-licenses/rights-license-interface';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';

/**
 * `LEGACY-377`, остаток ревью `T10`. Общие списки претензий и лицензий резали страницу
 * в памяти после выборки без `take`, сводка дашборда считалась по первым 50 претензиям,
 * список претензий несуществующей книги отвечал 200. Посадка: фильтры в базе дают тот же
 * набор, что прежние предикаты в памяти, сводка равна подсчёту по полному списку.
 */
type ClaimRow = {
  id: string;
  isOpen: boolean;
  isOverdue: boolean;
  severity: string;
  blocksPublication: boolean;
  activeBlocksCount: number;
  hasWorldwideBlock: boolean;
  blockedCountryCodes: string[];
  affectedCountryCodes: string[];
  deadlineAt: string | null;
};
type ListBody<T> = {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

const DAY = 24 * 60 * 60 * 1000;

describe('Admin rights lists: filters in the database (LEGACY-377) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let coverage: RightsLicenseCoverageService;
  let adminAccess: string;
  let bookId: string;
  let versionId: string;
  let profileId: string;
  const claimIds: Record<string, string> = {};
  const licenseIds: Record<string, string> = {};

  const stamp = Date.now();
  const slug = `rights-filters-e2e-${stamp}`;
  const claimPrefix = `${slug}-c`;
  const licensePrefix = `${slug}-l`;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const get = async <T>(path: string, status = 200): Promise<T> => {
    const res = await request(http())
      .get(path)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(status);
    return res.body as T;
  };

  const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id).sort();
  const named = (map: Record<string, string>, names: string[]): string[] =>
    names.map((name) => map[name]).sort();

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    coverage = moduleRef.get(RightsLicenseCoverageService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const created = await createBookWithRights(prisma as unknown as PrismaClient, slug);
    bookId = created.book.id;
    profileId = created.profile.id;
    const version = await prisma.bookVersion.create({
      data: {
        bookId,
        language: Language.en,
        title: slug,
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: BookType.text,
        isFree: true,
        status: 'draft',
        rightsProfileId: profileId,
      },
    });
    versionId = version.id;

    const now = Date.now();
    const claimSeeds: Array<{
      name: string;
      status: RightsClaimStatus;
      severity: RightsClaimSeverity;
      countries?: string[];
      deadlineAt: Date | null;
      blocksPublication?: boolean;
      blocks: Array<{
        countryCode: string | null;
        status?: RightsClaimBlockStatus;
        expiresAt?: Date;
      }>;
    }> = [
      {
        name: 'c1',
        status: RightsClaimStatus.RECEIVED,
        severity: RightsClaimSeverity.LOW,
        countries: [],
        deadlineAt: new Date(now - 2 * DAY),
        blocksPublication: true,
        blocks: [{ countryCode: null }],
      },
      {
        name: 'c2',
        status: RightsClaimStatus.UNDER_REVIEW,
        severity: RightsClaimSeverity.HIGH,
        countries: ['DE'],
        deadlineAt: new Date(now + 3 * DAY),
        blocks: [{ countryCode: 'DE' }],
      },
      {
        name: 'c3',
        status: RightsClaimStatus.CLOSED,
        severity: RightsClaimSeverity.CRITICAL,
        countries: ['FR'],
        deadlineAt: new Date(now - 5 * DAY),
        blocks: [{ countryCode: 'FR', expiresAt: new Date(now - DAY) }],
      },
      {
        name: 'c4',
        status: RightsClaimStatus.ACTION_REQUIRED,
        severity: RightsClaimSeverity.MEDIUM,
        deadlineAt: null,
        blocks: [{ countryCode: 'IT', status: RightsClaimBlockStatus.LIFTED }],
      },
      {
        name: 'c5',
        status: RightsClaimStatus.RESOLVED_VALID,
        severity: RightsClaimSeverity.MEDIUM,
        countries: ['DE', 'FR'],
        deadlineAt: new Date(now + 30 * DAY),
        blocks: [{ countryCode: 'DE', expiresAt: new Date(now + 10 * DAY) }],
      },
      {
        name: 'c6',
        status: RightsClaimStatus.RECEIVED,
        severity: RightsClaimSeverity.LOW,
        countries: ['ES'],
        deadlineAt: new Date(now + 10 * DAY),
        blocks: [],
      },
    ];
    for (const seed of claimSeeds) {
      const claim = await prisma.rightsClaim.create({
        data: {
          claimNumber: `${claimPrefix}${seed.name}`,
          claimType: RightsClaimType.COPYRIGHT_INFRINGEMENT,
          status: seed.status,
          severity: seed.severity,
          deadlineAt: seed.deadlineAt,
          blocksPublication: seed.blocksPublication ?? false,
          ...(seed.countries ? { affectedCountryCodes: seed.countries } : {}),
          claimantName: 'Claimant',
          descriptionRu: 'Претензия',
          bookId,
          bookVersionId: versionId,
        },
      });
      claimIds[seed.name] = claim.id;
      for (const block of seed.blocks) {
        await prisma.rightsClaimAccessBlock.create({
          data: {
            rightsClaimId: claim.id,
            bookVersionId: versionId,
            scope: GeoBlockScope.TEXT_READER,
            countryCode: block.countryCode,
            status: block.status ?? RightsClaimBlockStatus.ACTIVE,
            expiresAt: block.expiresAt ?? null,
            reasonRu: 'Блокировка',
          },
        });
      }
    }
    // Закрытые критические идут первыми в порядке списка: первые 50 не содержат ни одной
    // открытой претензии, и сводка по странице разошлась бы с полной.
    await prisma.rightsClaim.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({
        claimNumber: `bulk-${stamp}-${index}`,
        claimType: RightsClaimType.COPYRIGHT_INFRINGEMENT,
        status: RightsClaimStatus.CLOSED,
        severity: RightsClaimSeverity.CRITICAL,
        claimantName: 'Claimant',
        descriptionRu: 'Претензия',
        bookId,
        bookVersionId: versionId,
      })),
    });

    const licenseSeeds: Array<{
      name: string;
      territoryScope: RightsLicenseTerritoryScope;
      countryCodes?: string[];
      excludedCountryCodes?: string[];
      languageCodes?: string[];
      mediaFormats?: RightsLicenseMediaFormat[];
      link?: 'profile' | 'version';
    }> = [
      { name: 'l1', territoryScope: RightsLicenseTerritoryScope.WORLDWIDE, link: 'profile' },
      {
        name: 'l2',
        territoryScope: RightsLicenseTerritoryScope.COUNTRY_LIST,
        countryCodes: ['DE'],
        languageCodes: ['ru'],
        mediaFormats: [RightsLicenseMediaFormat.AUDIO_STREAMING],
        link: 'version',
      },
      {
        name: 'l3',
        territoryScope: RightsLicenseTerritoryScope.EXCEPT_COUNTRY_LIST,
        excludedCountryCodes: ['DE'],
        languageCodes: [],
        mediaFormats: [RightsLicenseMediaFormat.TEXT_ONLINE],
      },
      {
        name: 'l4',
        territoryScope: RightsLicenseTerritoryScope.EXCEPT_COUNTRY_LIST,
        languageCodes: ['en'],
      },
      { name: 'l5', territoryScope: RightsLicenseTerritoryScope.UNKNOWN, link: 'version' },
    ];
    for (const [index, seed] of licenseSeeds.entries()) {
      const license = await prisma.rightsLicense.create({
        data: {
          title: `${licensePrefix}${seed.name}`,
          licensor: 'Licensor',
          createdAt: new Date(2026, 0, 1 + index),
          territoryScope: seed.territoryScope,
          ...(seed.countryCodes ? { countryCodes: seed.countryCodes } : {}),
          ...(seed.excludedCountryCodes ? { excludedCountryCodes: seed.excludedCountryCodes } : {}),
          ...(seed.languageCodes ? { languageCodes: seed.languageCodes } : {}),
          ...(seed.mediaFormats ? { mediaFormats: seed.mediaFormats } : {}),
        },
      });
      licenseIds[seed.name] = license.id;
      if (seed.link === 'profile') {
        await prisma.rightsLicenseLink.create({
          data: {
            rightsLicenseId: license.id,
            linkType: RightsLicenseLinkType.RIGHTS_PROFILE,
            rightsProfileId: profileId,
          },
        });
      }
      if (seed.link === 'version') {
        await prisma.rightsLicenseLink.create({
          data: {
            rightsLicenseId: license.id,
            linkType: RightsLicenseLinkType.BOOK_VERSION,
            bookVersionId: versionId,
          },
        });
      }
    }

    const password = 'password123';
    const registration = await request(http())
      .post('/auth/register')
      .send({ email: 'admin@example.com', password });
    if (registration.status === 201) {
      adminAccess = (registration.body as { accessToken: string }).accessToken;
    } else {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: 'admin@example.com', password })
        .expect(200);
      adminAccess = (login.body as { accessToken: string }).accessToken;
    }
  });

  afterAll(async () => {
    await prisma.rightsClaim.deleteMany({ where: { bookId } });
    await prisma.rightsLicense.deleteMany({ where: { id: { in: Object.values(licenseIds) } } });
    await prisma.bookVersion.deleteMany({ where: { id: versionId } });
    await cleanupBookWithRights(prisma as unknown as PrismaClient, slug);
    await app.close();
  });

  describe('GET /admin/rights/claims', () => {
    // Прежние предикаты `applyInMemoryFilters` над той же выдачей - эталон для фильтров в базе.
    const byOldPredicate = async (predicate: (row: ClaimRow) => boolean): Promise<string[]> =>
      ids(
        (
          await get<ListBody<ClaimRow>>(`/admin/rights/claims?q=${claimPrefix}&limit=100`)
        ).items.filter(predicate),
      );

    it('filters by country in the database, an empty list meaning every country', async () => {
      const body = await get<ListBody<ClaimRow>>(
        `/admin/rights/claims?q=${claimPrefix}&limit=100&countryCode=de`,
      );
      expect(ids(body.items)).toEqual(named(claimIds, ['c1', 'c2', 'c4', 'c5']));
      expect(ids(body.items)).toEqual(
        await byOldPredicate(
          (row) => row.affectedCountryCodes.length === 0 || row.affectedCountryCodes.includes('DE'),
        ),
      );
      expect(body.pagination.total).toBe(4);
    });

    it('filters overdue, active-block and deadline-horizon claims in the database', async () => {
      const overdue = await get<ListBody<ClaimRow>>(
        `/admin/rights/claims?q=${claimPrefix}&limit=100&overdueOnly=true`,
      );
      expect(ids(overdue.items)).toEqual(named(claimIds, ['c1']));
      expect(ids(overdue.items)).toEqual(await byOldPredicate((row) => row.isOverdue));

      const blocked = await get<ListBody<ClaimRow>>(
        `/admin/rights/claims?q=${claimPrefix}&limit=100&hasActiveBlock=true`,
      );
      expect(ids(blocked.items)).toEqual(named(claimIds, ['c1', 'c2', 'c5']));
      expect(ids(blocked.items)).toEqual(await byOldPredicate((row) => row.activeBlocksCount > 0));

      const horizon = Date.now() + 5 * DAY;
      const soon = await get<ListBody<ClaimRow>>(
        `/admin/rights/claims?q=${claimPrefix}&limit=100&deadlineWithinDays=5`,
      );
      expect(ids(soon.items)).toEqual(named(claimIds, ['c1', 'c2', 'c3']));
      expect(ids(soon.items)).toEqual(
        await byOldPredicate(
          (row) => row.deadlineAt !== null && new Date(row.deadlineAt).getTime() <= horizon,
        ),
      );
    });

    it('combines a text search with the other filters instead of replacing it', async () => {
      const body = await get<ListBody<ClaimRow>>(
        `/admin/rights/claims?q=${claimPrefix}&limit=100&countryCode=DE&hasActiveBlock=true`,
      );
      expect(ids(body.items)).toEqual(named(claimIds, ['c1', 'c2', 'c5']));
    });

    it('cuts the page in the database and walks every claim once in the list order', async () => {
      const full = await get<ListBody<ClaimRow>>(`/admin/rights/claims?q=${claimPrefix}&limit=100`);
      expect(full.pagination.total).toBe(6);
      const walked: string[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const body = await get<ListBody<ClaimRow>>(
          `/admin/rights/claims?q=${claimPrefix}&page=${page}&limit=2`,
        );
        expect(body.pagination).toEqual({ page, limit: 2, total: 6, totalPages: 3 });
        walked.push(...body.items.map((row) => row.id));
      }
      expect(walked).toEqual(full.items.map((row) => row.id));
      expect(full.items.map((row) => row.id)).toEqual([
        claimIds.c3,
        claimIds.c2,
        claimIds.c5,
        claimIds.c4,
        claimIds.c1,
        claimIds.c6,
      ]);
    });
  });

  describe('GET /admin/versions/:id/rights-dashboard', () => {
    it('summarises every claim of the version, not the first page of 50', async () => {
      const list = await get<ListBody<ClaimRow>>(
        `/admin/versions/${versionId}/rights-claims?limit=100`,
      );
      expect(list.pagination.total).toBe(56);
      const claims = list.items;
      const open = claims.filter((claim) => claim.isOpen);
      // Прежний подсчёт `getRightsDashboard`, применённый к полному набору.
      const worst = open.reduce<string | null>(
        (acc, claim) =>
          (CLAIM_SEVERITY_RANK[claim.severity] ?? 0) > (acc ? (CLAIM_SEVERITY_RANK[acc] ?? 0) : -1)
            ? claim.severity
            : acc,
        null,
      );
      const expected = {
        claimsCount: claims.length,
        activeClaimsCount: open.length,
        blockingClaimsCount: open.filter((claim) => claim.blocksPublication).length,
        criticalClaimsCount: open.filter((claim) => claim.severity === 'CRITICAL').length,
        overdueClaimsCount: open.filter((claim) => claim.isOverdue).length,
        activeClaimBlocksCount: claims.reduce((sum, claim) => sum + claim.activeBlocksCount, 0),
        claimBlockedCountriesCount: new Set(claims.flatMap((claim) => claim.blockedCountryCodes))
          .size,
        hasWorldwideClaimBlock: claims.some((claim) => claim.hasWorldwideBlock),
        worstClaimSeverity: worst,
      };
      expect(expected).toEqual({
        claimsCount: 56,
        activeClaimsCount: 4,
        blockingClaimsCount: 1,
        criticalClaimsCount: 0,
        overdueClaimsCount: 1,
        activeClaimBlocksCount: 3,
        claimBlockedCountriesCount: 1,
        hasWorldwideClaimBlock: true,
        worstClaimSeverity: 'HIGH',
      });

      const dashboard = await get<{ summary: Record<string, unknown> }>(
        `/admin/versions/${versionId}/rights-dashboard`,
      );
      expect(dashboard.summary).toEqual(expect.objectContaining(expected));
    });
  });

  describe('GET /admin/books/:id/rights-claims', () => {
    it('answers 404 for a book that does not exist, like the version route', async () => {
      await get(`/admin/books/00000000-0000-4000-8000-000000000000/rights-claims`, 404);
      await get(`/admin/versions/00000000-0000-4000-8000-000000000000/rights-claims`, 404);
    });
  });

  describe('GET /admin/rights/licenses', () => {
    const records = async (): Promise<RightsLicenseRecord[]> =>
      (await prisma.rightsLicense.findMany({
        where: { id: { in: Object.values(licenseIds) } },
      })) as unknown as RightsLicenseRecord[];

    it('filters coverage in the database exactly like the coverage predicates', async () => {
      const all = await records();

      const country = await get<ListBody<{ id: string }>>(
        `/admin/rights/licenses?q=${licensePrefix}&limit=100&countryCode=de`,
      );
      expect(ids(country.items)).toEqual(named(licenseIds, ['l1', 'l2', 'l4']));
      expect(ids(country.items)).toEqual(
        ids(all.filter((license) => coverage.coversCountry(license, 'DE'))),
      );

      const language = await get<ListBody<{ id: string }>>(
        `/admin/rights/licenses?q=${licensePrefix}&limit=100&languageCode=RU`,
      );
      expect(ids(language.items)).toEqual(named(licenseIds, ['l1', 'l2', 'l3', 'l5']));
      expect(ids(language.items)).toEqual(
        ids(all.filter((license) => coverage.coversLanguage(license, 'RU'))),
      );

      const format = await get<ListBody<{ id: string }>>(
        `/admin/rights/licenses?q=${licensePrefix}&limit=100&mediaFormat=TEXT_ONLINE`,
      );
      expect(ids(format.items)).toEqual(named(licenseIds, ['l1', 'l3', 'l4', 'l5']));
      expect(ids(format.items)).toEqual(
        ids(
          all.filter((license) =>
            coverage.coversMediaFormats(license, [CoverageMediaFormat.TEXT_ONLINE]),
          ),
        ),
      );
    });

    it('filters by profile and by version through links, like the loaders', async () => {
      const byProfile = await get<ListBody<{ id: string }>>(
        `/admin/rights/licenses?q=${licensePrefix}&limit=100&rightsProfileId=${profileId}`,
      );
      expect(ids(byProfile.items)).toEqual(named(licenseIds, ['l1']));

      const byVersion = await get<ListBody<{ id: string }>>(
        `/admin/rights/licenses?q=${licensePrefix}&limit=100&bookVersionId=${versionId}`,
      );
      expect(ids(byVersion.items)).toEqual(named(licenseIds, ['l1', 'l2', 'l5']));
      expect(ids(byVersion.items)).toEqual(ids(await coverage.loadLicensesForVersion(versionId)));
    });

    it('cuts the page in the database, newest first', async () => {
      const walked: string[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const body = await get<ListBody<{ id: string }>>(
          `/admin/rights/licenses?q=${licensePrefix}&page=${page}&limit=2`,
        );
        expect(body.pagination).toEqual({ page, limit: 2, total: 5, totalPages: 3 });
        walked.push(...body.items.map((row) => row.id));
      }
      expect(walked).toEqual(['l5', 'l4', 'l3', 'l2', 'l1'].map((name) => licenseIds[name]));
    });
  });
});
