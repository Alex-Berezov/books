/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookWithRights } from './helpers/book-with-rights';
import type { PrismaClient } from '@prisma/client';

/**
 * Phase 16 rights claims / DMCA e2e. Requires a live database, so it is not part of the
 * local unit run — execute on the VPS/CI with `yarn test:e2e:serial`.
 */
describe('Rights claims e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let bookId: string;
  let versionId: string;
  let chapterId: string;
  let claimId: string;
  let worldwideBlockId: string;
  let countryBlockId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const slug = `rights-claims-e2e-${Date.now()}`;

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

    // The version stays `published` for the whole suite: a draft version is not served
    // publicly at all (404 before any enforcement runs), so 451 would be unreachable.
    const version = await prisma.bookVersion.create({
      data: {
        bookId: created.book.id,
        language: 'en',
        title: 'Claimed edition',
        author: 'Test Author',
        description: 'Version that will receive a DMCA notice',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: 'text',
        isFree: true,
        status: 'published',
        rightsProfileId: created.profile.id,
        approvedRightsReviewId: created.review.id,
        rightsStatus: 'APPROVED',
        rightsAllowedCountryCodes: [],
        rightsBlockedCountryCodes: [],
        rightsLicenseRequiredCountryCodes: [],
        rightsPendingCountryCodes: [],
        rightsRequiredActions: [],
      },
    });
    versionId = version.id;

    const chapter = await prisma.chapter.create({
      data: {
        bookVersionId: versionId,
        number: 1,
        title: 'Chapter one',
        content: 'Claimed text',
      },
    });
    chapterId = chapter.id;

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers a claim that blocks publication with ACTIVE_RIGHTS_CLAIM', async () => {
    const created = await request(http())
      .post('/admin/rights/claims')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        claimType: 'DMCA_TAKEDOWN',
        severity: 'HIGH',
        claimantName: 'Acme Publishing',
        claimantType: 'PUBLISHER',
        claimantIsAuthorized: true,
        bookVersionId: versionId,
        descriptionRu: 'Правообладатель требует удалить текст.',
        goodFaithStatement: true,
      })
      .expect(201);

    claimId = created.body.id as string;
    expect(created.body.claimNumber).toMatch(/^CLM-\d{4}-\d{6}$/);
    expect(created.body.isOpen).toBe(true);
    expect(created.body.blocksPublication).toBe(true);
    expect(created.body.events.some((e: { eventType: string }) => e.eventType === 'CREATED')).toBe(
      true,
    );

    // An open blocking claim stops publication on its own, before any access block exists.
    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({})
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe('RIGHTS_PUBLICATION_BLOCKED');
        expect(
          body.blockingReasons.some((r: { code: string }) => r.code === 'ACTIVE_RIGHTS_CLAIM'),
        ).toBe(true);
      });
  });

  it('answers 451 BLOCKED_BY_RIGHTS_CLAIM on the public chapter endpoint', async () => {
    const blocks = await request(http())
      .post(`/admin/rights/claims/${claimId}/blocks`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        scope: 'LANGUAGE_EDITION',
        reasonRu: 'Контент снят до выяснения обстоятельств.',
      })
      .expect(201);

    expect(blocks.body).toHaveLength(1);
    expect(blocks.body[0].countryCode).toBeNull();
    expect(blocks.body[0].effectiveStatus).toBe('ACTIVE');
    worldwideBlockId = blocks.body[0].id as string;

    const assertBlockedBody = ({ body }: { body: Record<string, unknown> }): void => {
      expect(body.code).toBe('BLOCKED_BY_RIGHTS_CLAIM');
      // The public body must never leak claim internals.
      expect(body.claimId).toBeUndefined();
      expect(body.claimNumber).toBeUndefined();
      expect(body.claimantName).toBeUndefined();
    };

    // A worldwide block fires for a known country…
    await request(http())
      .get(`/chapters/${chapterId}`)
      .set('X-Geo-Country', 'US')
      .expect(451)
      .expect(assertBlockedBody);

    // …and for an unknown one, unlike a country-scoped restriction.
    await request(http()).get(`/chapters/${chapterId}`).expect(451).expect(assertBlockedBody);
  });

  it('applies a country-scoped block only in the listed country', async () => {
    await request(http())
      .post(`/admin/rights/claims/${claimId}/blocks/${worldwideBlockId}/lift`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ liftReasonRu: 'Заменяем на страновую блокировку.' })
      .expect(201)
      .expect(({ body }) => {
        expect(body.status).toBe('LIFTED');
      });

    const blocks = await request(http())
      .post(`/admin/rights/claims/${claimId}/blocks`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        scope: 'TEXT_READER',
        countryCodes: ['DE'],
        reasonRu: 'Ограничение только для Германии.',
      })
      .expect(201);

    expect(blocks.body).toHaveLength(1);
    expect(blocks.body[0].countryCode).toBe('DE');
    countryBlockId = blocks.body[0].id as string;

    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'DE').expect(451);
    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'US').expect(200);
    // An unknown country is not blocked by a country-scoped restriction (Phase 12 policy).
    await request(http()).get(`/chapters/${chapterId}`).expect(200);
  });

  it('restores access after resolving the claim with liftActiveBlocks', async () => {
    await request(http())
      .post(`/admin/rights/claims/${claimId}/resolve`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        resolution: 'INVALID_REJECTED',
        resolutionNotesRu: 'Произведение в общественном достоянии.',
        liftActiveBlocks: true,
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.status).toBe('RESOLVED_INVALID');
        expect(body.isOpen).toBe(false);
        expect(body.activeBlocksCount).toBe(0);
        expect(body.accessBlocks.find((b: { id: string }) => b.id === countryBlockId).status).toBe(
          'LIFTED',
        );
        expect(body.events.some((e: { eventType: string }) => e.eventType === 'RESOLVED')).toBe(
          true,
        );
      });

    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'DE').expect(200);

    await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(
          body.blockingReasons.some((r: { code: string }) => r.code === 'ACTIVE_RIGHTS_CLAIM'),
        ).toBe(false);
        expect(body.blockingClaimsCount).toBe(0);
        expect(body.activeClaimsCount).toBe(0);
      });
  });

  it('exposes claims on the navigation endpoints and never deletes them', async () => {
    await request(http())
      .get(`/admin/versions/${versionId}/rights-claims`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.some((c: { id: string }) => c.id === claimId)).toBe(true);
      });

    await request(http())
      .get(`/admin/books/${bookId}/rights-claims`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.some((c: { id: string }) => c.id === claimId)).toBe(true);
      });

    // There is no delete route for claims — closing is the only terminal operation.
    await request(http())
      .delete(`/admin/rights/claims/${claimId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(404);
  });

  // Runs last: it takes the version out of publication for the rest of the suite.
  it('takes the version out of publication when unpublishVersion is requested', async () => {
    const created = await request(http())
      .post('/admin/rights/claims')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        claimType: 'COPYRIGHT_INFRINGEMENT',
        severity: 'CRITICAL',
        claimantName: 'Second Claimant',
        bookVersionId: versionId,
        descriptionRu: 'Вторая претензия с немедленным снятием с публикации.',
      })
      .expect(201);
    const secondClaimId = created.body.id as string;
    expect(created.body.status).toBe('RECEIVED');

    // The auto-advance on block only fires for transitions the matrix allows, and
    // RECEIVED → CONTENT_REMOVED is not one of them — the claim has to be triaged first.
    await request(http())
      .post(`/admin/rights/claims/${secondClaimId}/status`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'UNDER_REVIEW' })
      .expect(201);

    await request(http())
      .post(`/admin/rights/claims/${secondClaimId}/blocks`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        scope: 'LANGUAGE_EDITION',
        reasonRu: 'Немедленное снятие контента.',
        unpublishVersion: true,
      })
      .expect(201);

    await request(http())
      .get(`/admin/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('draft');
        expect(body.rightsClaimBlockActive).toBe(true);
      });

    await request(http())
      .get(`/admin/rights/claims/${secondClaimId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        // A worldwide edition-wide block advances a triaged claim to CONTENT_REMOVED.
        expect(body.status).toBe('CONTENT_REMOVED');
        expect(
          body.events.some((e: { eventType: string }) => e.eventType === 'VERSION_UNPUBLISHED'),
        ).toBe(true);
      });

    // An unpublished version is not served publicly at all, so the answer is 404, not 451.
    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'US').expect(404);
  });
});
