/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType, RightsPublicationGate } from '@prisma/client';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';

describe('BookVersion Publication Gate (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let versionId: string;
  let bookWithRights: {
    book: { id: string };
    intake: { id: string };
    profile: { id: string };
    review: { id: string };
  };
  const slug = `gate-${Date.now()}`;
  const createdSlugs: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin-gate@example.com';
    bookWithRights = await createBookWithRights(prisma, slug);
    createdSlugs.push(slug);

    const email = 'admin-gate@example.com';
    const password = 'password123';
    const reg = await request(app.getHttpServer()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = reg.body.accessToken as string;
    } else if (reg.status === 409) {
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
      adminToken = login.body.accessToken as string;
    } else {
      throw new Error(`Admin register unexpected status ${reg.status}`);
    }

    // Create a draft version
    const createRes = await request(app.getHttpServer())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Gate Test EN',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    versionId = createRes.body.id as string;
  });

  afterAll(async () => {
    for (const s of createdSlugs) {
      await cleanupBookWithRights(prisma, s);
    }
    await app.close();
  });

  // GET /admin/versions/:id/publication-gate requires auth
  it('GET /admin/versions/:id/publication-gate requires auth', async () => {
    await request(app.getHttpServer())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .expect(401);
  });

  // content manager/admin gets gate result
  it('returns gate result for admin', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.versionId).toBe(versionId);
    expect(res.body.canPublish).toBe(true);
    expect(res.body.blockingReasons).toEqual([]);
    expect(res.body.rightsProfileId).toBeTruthy();
    expect(res.body.approvedRightsReviewId).toBeTruthy();
  });

  // version with rights can publish
  it('version with approved rights can publish', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.status).toBe('published');
  });

  // version without rights cannot publish
  it('version without rights cannot publish', async () => {
    const noRightsSlug = `no-rights-${Date.now()}`;
    const noRightsBook = await prisma.book.create({ data: { slug: noRightsSlug } });
    createdSlugs.push(noRightsSlug);

    // Cannot even create a version for a book without an intake
    await request(app.getHttpServer())
      .post(`/books/${noRightsBook.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.fr,
        title: 'No Rights',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(400);
  });

  // version with publicationGate = BLOCK cannot publish
  it('version with BLOCK gate cannot publish', async () => {
    // Create a book with BLOCK gate
    const blockSlug = `block-${Date.now()}`;
    const blockRights = await createBookWithRights(prisma, blockSlug);
    createdSlugs.push(blockSlug);

    // Set profile gate to BLOCK
    await prisma.rightsProfile.update({
      where: { id: blockRights.profile.id },
      data: { publicationGate: RightsPublicationGate.BLOCK },
    });

    const createRes = await request(app.getHttpServer())
      .post(`/books/${blockRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.es,
        title: 'Blocked',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    const blockedVersionId = createRes.body.id as string;

    const gateRes = await request(app.getHttpServer())
      .get(`/admin/versions/${blockedVersionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(gateRes.body.canPublish).toBe(false);
    expect(gateRes.body.blockingReasons.some((r: any) => r.code === 'PUBLICATION_GATE_BLOCK')).toBe(
      true,
    );

    await request(app.getHttpServer())
      .patch(`/versions/${blockedVersionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  // version with unresolved blocking action cannot publish
  it('version with unresolved blocking action cannot publish', async () => {
    const actionSlug = `action-${Date.now()}`;
    const actionRights = await createBookWithRights(prisma, actionSlug);
    createdSlugs.push(actionSlug);

    // Add a blocking action
    await prisma.rightsAction.create({
      data: {
        rightsProfileId: actionRights.profile.id,
        actionType: 'REMOVE_COMPONENT',
        status: 'PENDING',
        descriptionRu: 'Test blocking action',
        isBlocking: true,
      },
    });

    const createRes = await request(app.getHttpServer())
      .post(`/books/${actionRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.fr,
        title: 'Action Blocked',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    const actionVersionId = createRes.body.id as string;

    const gateRes = await request(app.getHttpServer())
      .get(`/admin/versions/${actionVersionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(gateRes.body.canPublish).toBe(false);
    expect(
      gateRes.body.blockingReasons.some((r: any) => r.code === 'UNRESOLVED_BLOCKING_RIGHTS_ACTION'),
    ).toBe(true);

    await request(app.getHttpServer())
      .patch(`/versions/${actionVersionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  // PATCH /admin/versions/:id/rights-geo-block works
  it('marks geo-block as configured', async () => {
    const geoSlug = `geo-${Date.now()}`;
    const geoRights = await createBookWithRights(prisma, geoSlug);
    createdSlugs.push(geoSlug);

    const createRes = await request(app.getHttpServer())
      .post(`/books/${geoRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.ru,
        title: 'Geo Test',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    const geoVersionId = createRes.body.id as string;

    // Mark geo-block required
    await prisma.bookVersion.update({
      where: { id: geoVersionId },
      data: { rightsGeoBlockRequired: true, rightsBlockedCountryCodes: ['RU'] },
    });

    // Gate should block
    const gateBefore = await request(app.getHttpServer())
      .get(`/admin/versions/${geoVersionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(gateBefore.body.canPublish).toBe(false);

    // Mark geo-block as configured via API
    await request(app.getHttpServer())
      .patch(`/admin/versions/${geoVersionId}/rights-geo-block`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ configured: true, notesRu: 'Configured for testing' })
      .expect(200);

    // Gate should now allow (if no other blockers)
    const gateAfter = await request(app.getHttpServer())
      .get(`/admin/versions/${geoVersionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(gateAfter.body.canPublish).toBe(true);
  });

  // unpublish works regardless of gate
  it('unpublish works regardless of rights gate', async () => {
    // Create a version with BLOCK gate
    const unblockSlug = `unblock-${Date.now()}`;
    const unblockRights = await createBookWithRights(prisma, unblockSlug);
    createdSlugs.push(unblockSlug);

    // Set profile gate to BLOCK
    await prisma.rightsProfile.update({
      where: { id: unblockRights.profile.id },
      data: { publicationGate: RightsPublicationGate.BLOCK },
    });

    const createRes = await request(app.getHttpServer())
      .post(`/books/${unblockRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.pt,
        title: 'Unpub Test',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    const unblockVersionId = createRes.body.id as string;

    // unpublish should work fine even though gate is BLOCK
    await request(app.getHttpServer())
      .patch(`/versions/${unblockVersionId}/unpublish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
