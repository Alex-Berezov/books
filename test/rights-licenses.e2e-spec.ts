/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookWithRights } from './helpers/book-with-rights';
import type { PrismaClient } from '@prisma/client';

/**
 * Phase 15 rights licenses e2e. Requires a live database, so it is not part of the
 * local unit run — execute on the VPS/CI with `yarn test:e2e:serial`.
 */
describe('Rights licenses e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let userAccess: string;
  let profileId: string;
  let versionId: string;
  let licenseId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const slug = `rights-licenses-e2e-${Date.now()}`;

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
    profileId = created.profile.id;

    const version = await prisma.bookVersion.create({
      data: {
        bookId: created.book.id,
        language: 'es',
        title: 'Licensed edition',
        author: 'Test Author',
        description: 'Version that needs a license in ES',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: 'text',
        isFree: true,
        status: 'draft',
        rightsProfileId: profileId,
        approvedRightsReviewId: created.review.id,
        rightsStatus: 'APPROVED_WITH_LICENSE_LIMITATIONS',
        rightsAllowedCountryCodes: [],
        rightsBlockedCountryCodes: [],
        rightsLicenseRequiredCountryCodes: ['ES'],
        rightsPendingCountryCodes: [],
        rightsRequiredActions: [],
      },
    });
    versionId = version.id;

    await prisma.territoryDecision.create({
      data: {
        rightsProfileId: profileId,
        countryCode: 'ES',
        finalStatus: 'LICENSE_REQUIRED',
        accessPolicy: 'REVIEW_REQUIRED',
        geoBlockRequired: false,
        reasonRu: 'Требуется лицензия на испанский перевод.',
        confidence: 'HIGH',
      },
    });

    const password = 'password123';
    const adminRegistration = await request(http())
      .post('/auth/register')
      .send({ email: 'admin@example.com', password });
    if (adminRegistration.status === 201) {
      adminAccess = adminRegistration.body.accessToken as string;
    } else {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: 'admin@example.com', password })
        .expect(200);
      adminAccess = login.body.accessToken as string;
    }

    const userRegistration = await request(http())
      .post('/auth/register')
      .send({ email: `licenses-user-${Date.now()}@example.com`, password });
    userAccess = userRegistration.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a license, links it to the profile and reports COVERED coverage', async () => {
    const created = await request(http())
      .post('/admin/rights/licenses')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        licenseKey: `license:e2e-${Date.now()}`,
        title: 'Лицензия на испанский перевод',
        licensor: 'Penguin Random House',
        status: 'ACTIVE',
        territoryScope: 'COUNTRY_LIST',
        countryCodes: ['ES'],
        languageCodes: ['es'],
        mediaFormats: ['TEXT_ONLINE'],
        isPerpetual: true,
      })
      .expect(201);

    licenseId = created.body.id as string;
    expect(created.body.effectiveStatus).toBe('ACTIVE');

    await request(http())
      .post(`/admin/rights/licenses/${licenseId}/links`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ linkType: 'RIGHTS_PROFILE', rightsProfileId: profileId })
      .expect(201);

    await request(http())
      .get(`/admin/rights/profiles/${profileId}/license-coverage`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('COVERED');
        expect(body.coveredCountryCodes).toContain('ES');
      });

    await request(http())
      .get(`/admin/versions/${versionId}/license-coverage`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('COVERED');
      });
  });

  it('blocks publication with LICENSE_REVOKED after the license is revoked', async () => {
    await request(http())
      .post(`/admin/rights/licenses/${licenseId}/revoke`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ reasonRu: 'Правообладатель расторг договор.' })
      .expect(201)
      .expect(({ body }) => {
        expect(body.effectiveStatus).toBe('REVOKED');
      });

    await request(http())
      .get(`/admin/versions/${versionId}/license-coverage`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('NOT_COVERED');
        expect(body.blockers.some((b: { code: string }) => b.code === 'LICENSE_REVOKED')).toBe(
          true,
        );
      });

    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400)
      .expect(({ body }) => {
        expect(
          body.blockingReasons.some((r: { code: string }) => r.code === 'LICENSE_REVOKED'),
        ).toBe(true);
        expect(
          body.blockingReasons.some((r: { code: string }) => r.code === 'LICENSE_REQUIRED'),
        ).toBe(false);
      });
  });

  it('refuses to edit a revoked license beyond its notes', async () => {
    await request(http())
      .patch(`/admin/rights/licenses/${licenseId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ title: 'Новое название' })
      .expect(400);
  });

  it('materializes licenses[] from an imported agent report into the rights profile', async () => {
    const intake = await prisma.rightsIntake.create({
      data: {
        candidateTitle: 'Licensed import',
        candidateAuthor: 'Test Author',
        targetLanguages: ['es'],
        targetCountryCodes: ['ES'],
        plannedContentTypes: ['TEXT'],
        workflowStatus: 'READY_FOR_AGENT',
      },
    });

    const reportJson = {
      schemaVersion: '1.0',
      intakeId: intake.id,
      overallStatus: 'LICENSE_REQUIRED',
      publicationGate: 'BLOCK',
      confidence: 'HIGH',
      summaryRu: 'Требуется лицензия',
      conclusionRu: 'Публикация только по лицензии',
      sourceAssessment: { provider: 'OTHER', status: 'LICENSE_REQUIRED' },
      languageAssessments: [
        {
          languageCode: 'es',
          status: 'LICENSE_REQUIRED',
          translationOrigin: 'THIRD_PARTY_LICENSED_TRANSLATION',
          requiresGeoBlock: false,
        },
      ],
      componentAssessments: [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Перевод',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          licenseRefs: ['license:imported'],
        },
      ],
      territoryDecisions: [
        {
          countryCode: 'ES',
          finalStatus: 'ALLOWED_BY_LICENSE',
          accessPolicy: 'ALLOW',
          geoBlockRequired: false,
          reasonRu: 'Есть лицензия',
          confidence: 'HIGH',
          licenseRef: 'license:imported',
        },
      ],
      requiredActions: [],
      evidence: [
        {
          evidenceType: 'LICENSE_DOCUMENT',
          sourceLevel: 'PRIMARY',
          title: 'Договор',
          authority: 'Penguin',
          summaryRu: 'Копия договора',
        },
      ],
      licenses: [
        {
          key: 'license:imported',
          title: 'Импортированная лицензия',
          licensor: 'Penguin Random House',
          status: 'ACTIVE',
          territoryScope: 'COUNTRY_LIST',
          countryCodes: ['ES'],
          languageCodes: ['es'],
          isPerpetual: true,
          translationAllowed: true,
        },
      ],
      nextReviewAt: '2028-01-01T00:00:00.000Z',
    };

    const imported = await request(http())
      .post(`/admin/rights/intakes/${intake.id}/review-imports`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ reportJson })
      .expect(201);

    const importId = imported.body.id as string;

    const materialized = await request(http())
      .post(`/admin/rights/review-imports/${importId}/materialize`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(201);

    const importedProfileId = materialized.body.id as string;

    await request(http())
      .get(`/admin/rights/profiles/${importedProfileId}/licenses`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.total).toBe(1);
        expect(body.items[0].licenseKey).toBe('license:imported');
      });
  });

  // WP-4.1 / R6-02: a component that may only be used under a license used to be aggregated into
  // PENDING_REVIEW, and the country then fell out of the coverage check entirely — the presence of
  // Phase 13 data switched off the central scenario of Phase 15.
  it('carries a license-required component through to the coverage check', async () => {
    const intake = await prisma.rightsIntake.create({
      data: {
        candidateTitle: 'Component needs a license',
        candidateAuthor: 'Test Author',
        targetLanguages: ['pt'],
        targetCountryCodes: ['BR'],
        plannedContentTypes: ['TEXT'],
        workflowStatus: 'READY_FOR_AGENT',
      },
    });

    const reportJson = {
      schemaVersion: '1.0',
      intakeId: intake.id,
      overallStatus: 'LICENSE_REQUIRED',
      publicationGate: 'BLOCK',
      confidence: 'HIGH',
      summaryRu: 'Требуется лицензия на перевод',
      conclusionRu: 'Публикация в Бразилии только по лицензии',
      sourceAssessment: { provider: 'OTHER', status: 'LICENSE_REQUIRED' },
      languageAssessments: [
        {
          languageCode: 'pt',
          status: 'LICENSE_REQUIRED',
          translationOrigin: 'THIRD_PARTY_LICENSED_TRANSLATION',
          requiresGeoBlock: false,
        },
      ],
      componentAssessments: [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Португальский перевод',
          status: 'COPYRIGHTED',
          requiredAction: 'OBTAIN_LICENSE',
          confidence: 'HIGH',
          territoryAssessments: [
            {
              countryCode: 'BR',
              status: 'LICENSE_REQUIRED',
              accessPolicy: 'REVIEW_REQUIRED',
              geoBlockRequired: false,
              reasonRu: 'Права на перевод принадлежат издательству.',
              confidence: 'HIGH',
            },
          ],
        },
      ],
      territoryDecisions: [
        {
          countryCode: 'BR',
          finalStatus: 'LICENSE_REQUIRED',
          accessPolicy: 'REVIEW_REQUIRED',
          geoBlockRequired: false,
          reasonRu: 'Нужна лицензия на португальское издание.',
          confidence: 'HIGH',
        },
      ],
      requiredActions: [],
      evidence: [
        {
          evidenceType: 'PERMISSION_LETTER',
          sourceLevel: 'PRIMARY',
          title: 'Ответ издательства',
          authority: 'Editora',
          summaryRu: 'Права на перевод не истекли',
        },
      ],
      nextReviewAt: '2028-01-01T00:00:00.000Z',
    };

    const imported = await request(http())
      .post(`/admin/rights/intakes/${intake.id}/review-imports`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ reportJson })
      .expect(201);

    const materialized = await request(http())
      .post(`/admin/rights/review-imports/${imported.body.id as string}/materialize`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(201);

    const componentProfileId = materialized.body.id as string;
    const decision = await prisma.territoryDecision.findFirst({
      where: { rightsProfileId: componentProfileId, countryCode: 'BR' },
      select: { finalStatus: true, accessPolicy: true },
    });

    expect(decision?.finalStatus).toBe('LICENSE_REQUIRED');
    expect(decision?.accessPolicy).toBe('REVIEW_REQUIRED');

    await request(http())
      .get(`/admin/rights/profiles/${componentProfileId}/license-coverage`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.requiredCountryCodes).toContain('BR');
        expect(body.status).toBe('NOT_COVERED');
        expect(
          body.blockers.some((b: { code: string }) => b.code === 'LICENSE_MISSING_FOR_COUNTRY'),
        ).toBe(true);
      });

    await prisma.rightsIntake.delete({ where: { id: intake.id } }).catch(() => undefined);
  });

  it('returns 403 for the user role on every license endpoint', async () => {
    const auth = { Authorization: `Bearer ${userAccess}` };

    await request(http()).get('/admin/rights/licenses').set(auth).expect(403);
    await request(http()).get(`/admin/rights/licenses/${licenseId}`).set(auth).expect(403);
    await request(http())
      .post('/admin/rights/licenses')
      .set(auth)
      .send({ title: 'X', licensor: 'Y' })
      .expect(403);
    await request(http())
      .patch(`/admin/rights/licenses/${licenseId}`)
      .set(auth)
      .send({ notesRu: 'X' })
      .expect(403);
    await request(http())
      .post(`/admin/rights/licenses/${licenseId}/revoke`)
      .set(auth)
      .send({ reasonRu: 'X' })
      .expect(403);
    await request(http())
      .post(`/admin/rights/licenses/${licenseId}/links`)
      .set(auth)
      .send({ linkType: 'RIGHTS_PROFILE', rightsProfileId: profileId })
      .expect(403);
    await request(http())
      .get(`/admin/rights/profiles/${profileId}/license-coverage`)
      .set(auth)
      .expect(403);
    await request(http())
      .get(`/admin/versions/${versionId}/license-coverage`)
      .set(auth)
      .expect(403);
  });
});
