/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType, RightsPublicationGate } from '@prisma/client';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';
import { RightsContentHashService } from '../src/modules/rights-intake/rights-content-hash.service';
import { createBookFixture } from './helpers/book-fixture';

describe('BookVersion Publication Gate (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rightsContentHashService: RightsContentHashService;
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
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    rightsContentHashService = moduleRef.get(RightsContentHashService);
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
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = reg.body.accessToken as string;
    } else if (reg.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = login.body.accessToken as string;
    } else {
      throw new Error(`Admin register unexpected status ${reg.status}`);
    }

    // Create a draft version
    const createRes = await request(http())
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
    await request(http()).get(`/admin/versions/${versionId}/publication-gate`).expect(401);
  });

  // content manager/admin gets gate result
  it('returns gate result for admin', async () => {
    const res = await request(http())
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
    const res = await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.status).toBe('published');
  });

  // version without rights cannot publish
  it('version without rights cannot publish', async () => {
    const noRightsSlug = `no-rights-${Date.now()}`;
    const noRightsBook = await createBookFixture(prisma, noRightsSlug);
    createdSlugs.push(noRightsSlug);

    // Cannot even create a version for a book without an intake
    await request(http())
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

    const createRes = await request(http())
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

    const gateRes = await request(http())
      .get(`/admin/versions/${blockedVersionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(gateRes.body.canPublish).toBe(false);
    expect(gateRes.body.blockingReasons.some((r: any) => r.code === 'PUBLICATION_GATE_BLOCK')).toBe(
      true,
    );

    await request(http())
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
        affectedCountryCodes: [],
        isBlocking: true,
      },
    });

    const createRes = await request(http())
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

    const gateRes = await request(http())
      .get(`/admin/versions/${actionVersionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(gateRes.body.canPublish).toBe(false);
    expect(
      gateRes.body.blockingReasons.some((r: any) => r.code === 'UNRESOLVED_BLOCKING_RIGHTS_ACTION'),
    ).toBe(true);

    await request(http())
      .patch(`/versions/${actionVersionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  // Deprecated PATCH wrapper verifies generated Phase 12 rules
  it('generates and verifies geo-block rules through the compatibility wrapper', async () => {
    const geoSlug = `geo-${Date.now()}`;
    const geoRights = await createBookWithRights(prisma, geoSlug);
    createdSlugs.push(geoSlug);

    const createRes = await request(http())
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

    // Mark geo-block required and blocked countries (changes rights snapshot)
    await prisma.bookVersion.update({
      where: { id: geoVersionId },
      data: { rightsGeoBlockRequired: true, rightsBlockedCountryCodes: ['RU'] },
    });
    await prisma.territoryDecision.create({
      data: {
        rightsProfileId: geoRights.profile.id,
        countryCode: 'RU',
        finalStatus: 'BLOCKED',
        accessPolicy: 'BLOCK',
        geoBlockRequired: true,
        geoBlockScope: 'LANGUAGE_EDITION',
        reasonRu: 'Blocked for the publication gate E2E scenario',
        confidence: 'HIGH',
      },
    });

    // Re-create baseline after manual rights change (simulates fresh clearance)
    await rightsContentHashService.initializeVersionBaseline(
      geoVersionId,
      'INITIAL_VERSION_SNAPSHOT',
      null,
    );

    // Gate should block (geo-block not configured)
    const gateBefore = await request(http())
      .get(`/admin/versions/${geoVersionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(gateBefore.body.canPublish).toBe(false);

    // Generate the runtime projection, then verify it through the deprecated wrapper.
    await request(http())
      .post(`/admin/versions/${geoVersionId}/geo-block-rules/generate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    await request(http())
      .patch(`/admin/versions/${geoVersionId}/rights-geo-block`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ configured: true, notesRu: 'Configured for testing' })
      .expect(200);

    // Gate should now allow (if no other blockers)
    const gateAfter = await request(http())
      .get(`/admin/versions/${geoVersionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(gateAfter.body.canPublish).toBe(true);
  });

  // WP-2: the clearance in force, not the snapshot the version was created with.
  describe('clearance moves on after publication', () => {
    /** Book + published version, ready to be left behind by a newer clearance. */
    const arrangePublishedVersion = async (prefix: string, language: Language) => {
      const bookSlug = `${prefix}-${Date.now()}`;
      const rights = await createBookWithRights(prisma, bookSlug);
      createdSlugs.push(bookSlug);

      const createRes = await request(http())
        .post(`/books/${rights.book.id}/versions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          language,
          title: 'Clearance Drift',
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/cover.jpg',
          type: BookType.text,
          isFree: true,
        })
        .expect(201);

      return { rights, bookSlug, versionId: createRes.body.id as string };
    };

    const gateOf = async (id: string) =>
      request(http())
        .get(`/admin/versions/${id}/publication-gate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

    it('blocks a version left on the review the intake no longer points at', async () => {
      const {
        rights,
        bookSlug,
        versionId: driftVersionId,
      } = await arrangePublishedVersion('review-drift', Language.en);

      expect((await gateOf(driftVersionId)).body.canPublish).toBe(true);

      // A re-check of the same profile: new review approved, intake repointed. Nothing writes to
      // Book or BookVersion — that is exactly the gap WP-2 closes.
      const newerImport = await prisma.rightsReviewImport.create({
        data: {
          id: `test-import2-${bookSlug}`,
          rightsIntakeId: rights.intake.id,
          importStatus: 'VALIDATED',
          isCurrent: true,
          reportJson: { source: 'test-helper-recheck' },
        },
      });
      const newerReview = await prisma.rightsReview.create({
        data: {
          id: `test-review2-${bookSlug}`,
          rightsProfileId: rights.profile.id,
          rightsReviewImportId: newerImport.id,
          status: 'HUMAN_APPROVED',
          reviewerType: 'HUMAN',
          overallStatus: 'PUBLISHABLE',
          publicationGate: 'ALLOW',
          confidence: 'HIGH',
          summaryRu: 'Повторная проверка',
          conclusionRu: 'Утверждено',
          approvedAt: new Date(),
        },
      });
      await prisma.rightsIntake.update({
        where: { id: rights.intake.id },
        data: { approvedReviewId: newerReview.id },
      });

      const gate = await gateOf(driftVersionId);
      const blockers = gate.body.blockingReasons as Array<{ code: string; details?: unknown }>;
      const reason = blockers.find((r) => r.code === 'RIGHTS_REVIEW_SNAPSHOT_OUTDATED');

      expect(gate.body.canPublish).toBe(false);
      expect(reason).toBeDefined();
      expect(reason?.details).toEqual({
        versionReviewId: rights.review.id,
        effectiveReviewId: newerReview.id,
      });

      await request(http())
        .patch(`/versions/${driftVersionId}/publish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('requires geo-block for a market only the new clearance closed', async () => {
      const {
        rights,
        bookSlug,
        versionId: driftVersionId,
      } = await arrangePublishedVersion('market-drift', Language.es);

      expect((await gateOf(driftVersionId)).body.canPublish).toBe(true);

      // A new report materialises a new current profile that closes RU.
      await prisma.rightsProfile.update({
        where: { id: rights.profile.id },
        data: { isCurrent: false, status: 'SUPERSEDED', supersededAt: new Date() },
      });
      const newerProfile = await prisma.rightsProfile.create({
        data: {
          id: `test-profile2-${bookSlug}`,
          rightsIntakeId: rights.intake.id,
          status: 'APPROVED',
          isCurrent: true,
          overallStatus: 'PUBLISHABLE',
          publicationGate: 'ALLOW',
          confidence: 'HIGH',
          summaryRu: 'Новый профиль',
          conclusionRu: 'Рынок RU закрыт',
        },
      });
      await prisma.territoryDecision.create({
        data: {
          rightsProfileId: newerProfile.id,
          countryCode: 'RU',
          finalStatus: 'BLOCKED',
          accessPolicy: 'BLOCK',
          geoBlockRequired: true,
          geoBlockScope: 'LANGUAGE_EDITION',
          reasonRu: 'Рынок закрыт новой проверкой',
          confidence: 'HIGH',
        },
      });

      const gate = await gateOf(driftVersionId);
      const storedSnapshot = await prisma.bookVersion.findUnique({
        where: { id: driftVersionId },
        select: { rightsBlockedCountryCodes: true, rightsProfileId: true },
      });

      expect(
        gate.body.blockingReasons.some(
          (r: any) => r.code === 'BLOCKED_COUNTRIES_REQUIRE_GEO_BLOCK',
        ),
      ).toBe(true);
      // The audit snapshot is untouched: the requirement was resolved, not rewritten.
      expect(storedSnapshot?.rightsBlockedCountryCodes ?? []).toEqual([]);
      expect(storedSnapshot?.rightsProfileId).toBe(rights.profile.id);
    });
  });

  // WP-3: "the market is closed" and "the rule closes the market" must agree (R5-02, R6-01).
  describe('scope of the block matches the verdict', () => {
    /** Book + version whose clearance closes RU with the given scope, rules generated and verified. */
    const arrangeClosedMarket = async (
      prefix: string,
      language: Language,
      geoBlockScope: string,
    ) => {
      const bookSlug = `${prefix}-${Date.now()}`;
      const rights = await createBookWithRights(prisma, bookSlug);
      createdSlugs.push(bookSlug);

      const createRes = await request(http())
        .post(`/books/${rights.book.id}/versions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          language,
          title: 'Scope Test',
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/cover.jpg',
          type: BookType.text,
          isFree: true,
        })
        .expect(201);
      const scopeVersionId = createRes.body.id as string;

      await prisma.bookVersion.update({
        where: { id: scopeVersionId },
        data: { rightsGeoBlockRequired: true },
      });
      await prisma.territoryDecision.create({
        data: {
          rightsProfileId: rights.profile.id,
          countryCode: 'RU',
          finalStatus: 'BLOCKED',
          accessPolicy: 'BLOCK',
          geoBlockRequired: true,
          geoBlockScope,
          reasonRu: 'Рынок закрыт целиком',
          confidence: 'HIGH',
        },
      });
      await rightsContentHashService.initializeVersionBaseline(
        scopeVersionId,
        'INITIAL_VERSION_SNAPSHOT',
        null,
      );

      await request(http())
        .post(`/admin/versions/${scopeVersionId}/geo-block-rules/generate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      await request(http())
        .patch(`/admin/versions/${scopeVersionId}/rights-geo-block`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ configured: true, notesRu: 'Configured for testing' })
        .expect(200);

      return scopeVersionId;
    };

    const gateOf = async (id: string) =>
      request(http())
        .get(`/admin/versions/${id}/publication-gate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

    const accessCheck = async (id: string, scope: string) =>
      request(http())
        .post(`/admin/versions/${id}/geo-block-check`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ countryCode: 'RU', scope })
        .expect(201);

    it('refuses to publish a closed market covered only by a text rule', async () => {
      const partialVersionId = await arrangeClosedMarket(
        'scope-partial',
        Language.en,
        'TEXT_READER',
      );

      const gate = await gateOf(partialVersionId);
      const reason = (
        gate.body.blockingReasons as Array<{ code: string; details?: Record<string, unknown> }>
      ).find((item) => item.code === 'GEO_BLOCK_SCOPE_INSUFFICIENT');

      expect(gate.body.canPublish).toBe(false);
      expect(reason?.details).toEqual({
        countryCodes: ['RU'],
        scopesByCountry: { RU: ['TEXT_READER'] },
        requiredScopes: ['ENTIRE_BOOK', 'LANGUAGE_EDITION'],
      });

      // The blocker is not bookkeeping: the audio edition of the forbidden text really is open.
      expect((await accessCheck(partialVersionId, 'AUDIO')).body.allowed).toBe(true);

      await request(http())
        .patch(`/versions/${partialVersionId}/publish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('turns a SPECIFIC_ASSET decision into a rule that actually blocks', async () => {
      const assetVersionId = await arrangeClosedMarket(
        'scope-asset',
        Language.es,
        'SPECIFIC_ASSET',
      );

      const rules = await request(http())
        .get(`/admin/versions/${assetVersionId}/geo-block-rules`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const activeScopes = (rules.body.rules as Array<{ isActive: boolean; scope: string }>)
        .filter((rule) => rule.isActive)
        .map((rule) => rule.scope);

      expect(activeScopes).toEqual(['LANGUAGE_EDITION']);
      expect((await accessCheck(assetVersionId, 'AUDIO')).body.allowed).toBe(false);
      expect((await accessCheck(assetVersionId, 'TEXT_READER')).body.allowed).toBe(false);

      const gate = await gateOf(assetVersionId);

      expect(
        (gate.body.blockingReasons as Array<{ code: string }>).some(
          (item) => item.code === 'GEO_BLOCK_SCOPE_INSUFFICIENT',
        ),
      ).toBe(false);
      expect(gate.body.canPublish).toBe(true);
    });
  });

  // WP-4: the whole license path, from "this market needs a license" to a published version.
  // Both ways the scenario used to be lost meet here: the country arrives as LICENSE_REQUIRED with
  // access closed (R8-01), which is also what the component aggregation now produces (R6-02).
  describe('a market that may only be published under a license', () => {
    const gateOf = async (id: string) =>
      request(http())
        .get(`/admin/versions/${id}/publication-gate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

    const blockerCodes = (gate: { body: { blockingReasons: Array<{ code: string }> } }) =>
      gate.body.blockingReasons.map((reason) => reason.code);

    it('blocks until a valid license covers the country, language and format', async () => {
      const bookSlug = `license-path-${Date.now()}`;
      const rights = await createBookWithRights(prisma, bookSlug);
      createdSlugs.push(bookSlug);

      const createRes = await request(http())
        .post(`/books/${rights.book.id}/versions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          language: Language.fr,
          title: 'Licensed Path',
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/cover.jpg',
          type: BookType.text,
          isFree: true,
        })
        .expect(201);
      const licenseVersionId = createRes.body.id as string;

      // "A license is needed, and until it is bought the market stays closed" — the pair that
      // used to be swallowed by the blocked list, where coverage never looked.
      await prisma.territoryDecision.create({
        data: {
          rightsProfileId: rights.profile.id,
          countryCode: 'DE',
          finalStatus: 'LICENSE_REQUIRED',
          accessPolicy: 'BLOCK',
          geoBlockRequired: false,
          reasonRu: 'Права на немецкое издание у стороннего правообладателя.',
          confidence: 'HIGH',
        },
      });
      await rightsContentHashService.initializeVersionBaseline(
        licenseVersionId,
        'INITIAL_VERSION_SNAPSHOT',
        null,
      );

      const before = await gateOf(licenseVersionId);

      expect(before.body.licenseRequiredCountryCodes).toEqual(['DE']);
      expect(before.body.licenseCoverageStatus).toBe('NOT_COVERED');
      expect(blockerCodes(before)).toContain('LICENSE_MISSING_FOR_COUNTRY');
      // The country is a license question, not a geo-block one: demanding geo-block for it is
      // what made the license irrelevant.
      expect(blockerCodes(before)).not.toContain('BLOCKED_COUNTRIES_REQUIRE_GEO_BLOCK');
      expect(before.body.canPublish).toBe(false);

      await request(http())
        .patch(`/versions/${licenseVersionId}/publish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);

      // A license that does not reach the published language changes nothing.
      const wrongLanguage = await request(http())
        .post('/admin/rights/licenses')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          licenseKey: `license:wrong-lang-${Date.now()}`,
          title: 'Лицензия на испанское издание',
          licensor: 'Test Licensor',
          status: 'ACTIVE',
          territoryScope: 'COUNTRY_LIST',
          countryCodes: ['DE'],
          languageCodes: ['es'],
          mediaFormats: ['TEXT_ONLINE'],
          isPerpetual: true,
        })
        .expect(201);
      await request(http())
        .post(`/admin/rights/licenses/${wrongLanguage.body.id as string}/links`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ linkType: 'RIGHTS_PROFILE', rightsProfileId: rights.profile.id })
        .expect(201);

      const stillBlocked = await gateOf(licenseVersionId);
      expect(blockerCodes(stillBlocked)).toContain('LICENSE_SCOPE_LANGUAGE_MISMATCH');
      expect(stillBlocked.body.canPublish).toBe(false);

      // The right license: country, language and media format all covered.
      const license = await request(http())
        .post('/admin/rights/licenses')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          licenseKey: `license:de-fr-${Date.now()}`,
          title: 'Лицензия на французское издание в Германии',
          licensor: 'Test Licensor',
          status: 'ACTIVE',
          territoryScope: 'COUNTRY_LIST',
          countryCodes: ['DE'],
          languageCodes: ['fr'],
          mediaFormats: ['TEXT_ONLINE'],
          isPerpetual: true,
        })
        .expect(201);
      const licenseId = license.body.id as string;
      await request(http())
        .post(`/admin/rights/licenses/${licenseId}/links`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ linkType: 'RIGHTS_PROFILE', rightsProfileId: rights.profile.id })
        .expect(201);

      const covered = await gateOf(licenseVersionId);

      expect(covered.body.licenseCoverageStatus).toBe('COVERED');
      expect(covered.body.licenseCoveredCountryCodes).toEqual(['DE']);
      expect(covered.body.licenseIds).toContain(licenseId);
      expect(covered.body.canPublish).toBe(true);

      await request(http())
        .patch(`/versions/${licenseVersionId}/publish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // The license going away closes the market again — coverage is evaluated on read.
      await request(http())
        .post(`/admin/rights/licenses/${licenseId}/revoke`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reasonRu: 'Договор расторгнут.' })
        .expect(201);

      const revoked = await gateOf(licenseVersionId);

      expect(revoked.body.licenseCoverageStatus).toBe('NOT_COVERED');
      expect(blockerCodes(revoked)).toContain('LICENSE_REVOKED');
      expect(revoked.body.canPublish).toBe(false);
    });
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

    const createRes = await request(http())
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
    await request(http())
      .patch(`/versions/${unblockVersionId}/unpublish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
