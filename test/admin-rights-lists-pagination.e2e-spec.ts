import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  BookType,
  Language,
  RightsClaimSeverity,
  RightsClaimType,
  RightsLicenseLinkType,
  type PrismaClient,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PAGINATION_MAX_LIMIT } from '../src/shared/dto/pagination.dto';
import { CLAIM_SEVERITY_RANK } from '../src/modules/rights-claims/rights-claim.constants';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';

/**
 * `LEGACY-377`, остаток. Три админских списка выбирали всё без `take` и отдавали одной
 * страницей. Посадка: страница режется в базе, `total` честный, обход страниц даёт
 * весь набор ровно один раз и в прежнем порядке, потолок `limit` отвечает 400.
 */
type ListBody = {
  items: Array<{ id: string }>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

describe('Admin rights lists pagination (LEGACY-377) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let bookId: string;
  let versionId: string;
  let profileId: string;
  const claimOrder: string[] = [];
  const licenseIds: string[] = [];

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const slug = `rights-lists-e2e-${Date.now()}`;

  const list = async (path: string): Promise<ListBody> => {
    const res = await request(http())
      .get(path)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    return res.body as ListBody;
  };

  const walk = async (path: string, limit: number, pages: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let page = 1; page <= pages; page += 1) {
      for (const row of (await list(`${path}?page=${page}&limit=${limit}`)).items) ids.push(row.id);
    }
    return ids;
  };

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
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
      },
    });
    versionId = version.id;

    // Порядок выдачи: severity по убыванию, срок по возрастанию с пустыми в конце, свежие первыми.
    const seeds: Array<{
      severity: RightsClaimSeverity;
      deadlineAt: Date | null;
      wholeBook?: true;
    }> = [
      { severity: RightsClaimSeverity.CRITICAL, deadlineAt: null },
      { severity: RightsClaimSeverity.HIGH, deadlineAt: new Date('2026-10-01T00:00:00.000Z') },
      { severity: RightsClaimSeverity.HIGH, deadlineAt: new Date('2026-11-01T00:00:00.000Z') },
      { severity: RightsClaimSeverity.HIGH, deadlineAt: null, wholeBook: true },
      { severity: RightsClaimSeverity.LOW, deadlineAt: new Date('2026-09-20T00:00:00.000Z') },
    ];
    // Создаются в обратном порядке, чтобы порядок вставки не совпадал с ожидаемым.
    const ids: string[] = [];
    for (const [index, seed] of [...seeds.entries()].reverse()) {
      const claim = await prisma.rightsClaim.create({
        data: {
          claimNumber: `${slug}-${index}`,
          claimType: RightsClaimType.COPYRIGHT_INFRINGEMENT,
          severity: seed.severity,
          deadlineAt: seed.deadlineAt,
          claimantName: 'Claimant',
          descriptionRu: 'Претензия',
          bookId,
          bookVersionId: seed.wholeBook ? null : versionId,
        },
      });
      ids[index] = claim.id;
    }
    claimOrder.push(...ids);

    for (let i = 0; i < 3; i += 1) {
      const license = await prisma.rightsLicense.create({
        data: {
          title: `${slug}-lic-${i}`,
          licensor: 'Licensor',
          createdAt: new Date(2026, 0, 1 + i),
        },
      });
      licenseIds.push(license.id);
      await prisma.rightsLicenseLink.create({
        data: {
          rightsLicenseId: license.id,
          linkType: RightsLicenseLinkType.RIGHTS_PROFILE,
          rightsProfileId: profileId,
        },
      });
    }
    // Вторая связь той же лицензии с профилем не даёт второй строки в выдаче.
    await prisma.rightsLicenseLink.create({
      data: {
        rightsLicenseId: licenseIds[0],
        linkType: RightsLicenseLinkType.RIGHTS_PROFILE,
        rightsProfileId: profileId,
      },
    });

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
    await prisma.rightsLicense.deleteMany({ where: { id: { in: licenseIds } } });
    await prisma.bookVersion.deleteMany({ where: { id: versionId } });
    await cleanupBookWithRights(prisma as unknown as PrismaClient, slug);
    await app.close();
  });

  it('keeps the physical order of RightsClaimSeverity equal to CLAIM_SEVERITY_RANK', async () => {
    // `orderBy: { severity }` сортирует по порядку значений enum в базе, `sortClaims` - по рангу.
    const rows = await prisma.$queryRaw<Array<{ value: string }>>`
      SELECT unnest(enum_range(NULL::"RightsClaimSeverity"))::text AS value
    `;
    const byRank = Object.keys(CLAIM_SEVERITY_RANK).sort(
      (left, right) => CLAIM_SEVERITY_RANK[left] - CLAIM_SEVERITY_RANK[right],
    );
    expect(rows.map((row) => row.value)).toEqual(byRank);
  });

  describe('GET /admin/versions/:id/rights-claims', () => {
    it('cuts the page in the database and reports the real total', async () => {
      const first = await list(`/admin/versions/${versionId}/rights-claims?page=1&limit=2`);
      expect(first.items).toHaveLength(2);
      expect(first.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
    });

    it('walks every claim exactly once, in the severity-deadline order', async () => {
      expect(await walk(`/admin/versions/${versionId}/rights-claims`, 2, 3)).toEqual(claimOrder);
    });

    it('answers the default page of 20 without query', async () => {
      const body = await list(`/admin/versions/${versionId}/rights-claims`);
      expect(body.pagination).toEqual({ page: 1, limit: 20, total: 5, totalPages: 1 });
    });

    it('refuses a limit above the ceiling with 400', async () => {
      await request(http())
        .get(`/admin/versions/${versionId}/rights-claims?limit=${PAGINATION_MAX_LIMIT + 1}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(400);
    });
  });

  describe('GET /admin/books/:id/rights-claims', () => {
    it('pages the claims of the book and walks them all once', async () => {
      const last = await list(`/admin/books/${bookId}/rights-claims?page=3&limit=2`);
      expect(last.items).toHaveLength(1);
      expect(last.pagination).toEqual({ page: 3, limit: 2, total: 5, totalPages: 3 });
      expect(await walk(`/admin/books/${bookId}/rights-claims`, 2, 3)).toEqual(claimOrder);
    });

    it('refuses a limit above the ceiling with 400', async () => {
      await request(http())
        .get(`/admin/books/${bookId}/rights-claims?limit=100000`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(400);
    });
  });

  describe('GET /admin/rights/profiles/:profileId/licenses', () => {
    it('counts a license linked twice once and pages newest first', async () => {
      const first = await list(`/admin/rights/profiles/${profileId}/licenses?page=1&limit=2`);
      expect(first.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(await walk(`/admin/rights/profiles/${profileId}/licenses`, 2, 2)).toEqual(
        [...licenseIds].reverse(),
      );
    });

    it('answers an empty page past the end with the honest total', async () => {
      const beyond = await list(`/admin/rights/profiles/${profileId}/licenses?page=5&limit=2`);
      expect(beyond.items).toEqual([]);
      expect(beyond.pagination.total).toBe(3);
    });

    it('refuses a limit above the ceiling with 400', async () => {
      await request(http())
        .get(`/admin/rights/profiles/${profileId}/licenses?limit=${PAGINATION_MAX_LIMIT + 1}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(400);
    });
  });
});
