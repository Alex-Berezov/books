/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 18 automatic recheck e2e. Requires a live database, so it is NOT part of the local
 * unit run — execute on the VPS/CI with `yarn test:e2e:serial`.
 *
 * The scheduler is disabled for this suite (`RIGHTS_RECHECK_SCHEDULER_ENABLED=0`): the scan
 * is triggered explicitly through the admin endpoint so the assertions stay deterministic.
 */
describe('Rights recheck e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let intakeId: string;
  let profileId: string;
  let reviewId: string;
  let bookId: string;
  let versionId: string;
  let taskId: string;
  let legalChangeId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const auth = (): [string, string] => ['Authorization', `Bearer ${adminAccess}`];

  const report = (): Record<string, unknown> => ({
    schemaVersion: '1.0',
    intakeId,
    overallStatus: 'PUBLISHABLE',
    publicationGate: 'ALLOW',
    summaryRu: 'Пригодно к публикации',
    conclusionRu: 'Все целевые страны разрешены',
    sourceAssessment: {
      provider: 'PROJECT_GUTENBERG',
      status: 'ALLOWED',
      sourceTextType: 'ORIGINAL_TEXT',
    },
    languageAssessments: [
      {
        languageCode: 'en',
        status: 'ALLOWED',
        translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
        requiresGeoBlock: false,
      },
    ],
    componentAssessments: [
      {
        componentType: 'ORIGINAL_TEXT',
        titleRu: 'Текст',
        status: 'PUBLIC_DOMAIN',
        requiredAction: 'KEEP',
        confidence: 'HIGH',
      },
    ],
    territoryDecisions: [
      {
        countryCode: 'US',
        finalStatus: 'ALLOWED',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
        reasonRu: 'Public domain',
        confidence: 'HIGH',
      },
      {
        countryCode: 'DE',
        finalStatus: 'ALLOWED',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
        reasonRu: 'Public domain',
        confidence: 'HIGH',
      },
    ],
    requiredActions: [],
    evidence: [
      {
        evidenceType: 'GUTENBERG_PAGE',
        sourceLevel: 'PRIMARY',
        title: 'PG page',
        authority: 'Project Gutenberg',
        summaryRu: 'Страница PG',
      },
    ],
    confidence: 'HIGH',
    nextReviewAt: '2027-01-01T00:00:00.000Z',
  });

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    // Deterministic runs: only the explicit admin scan triggers the workflow.
    process.env.RIGHTS_RECHECK_SCHEDULER_ENABLED = '0';
    process.env.RIGHTS_RECHECK_BLOCK_PUBLISH_ON_OVERDUE = '1';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const password = 'password123';
    const registration = await request(http())
      .post('/auth/register')
      .send({ email: 'admin@example.com', password });
    if (registration.status === 201) {
      adminAccess = registration.body.accessToken as string;
    } else {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: 'admin@example.com', password })
        .expect(200);
      adminAccess = login.body.accessToken as string;
    }
  });

  afterAll(async () => {
    if (legalChangeId) {
      await prisma
        .$executeRawUnsafe('DELETE FROM "RightsLegalChangeEvent" WHERE id = $1', legalChangeId)
        .catch(() => undefined);
    }
    if (intakeId) {
      await prisma.rightsIntake.delete({ where: { id: intakeId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('creates an intake, imports a report and approves the review', async () => {
    const created = await request(http())
      .post('/admin/rights/intakes')
      .set(...auth())
      .send({
        candidateTitle: 'Recheck e2e',
        candidateAuthor: 'Test Author',
        sourceProvider: 'PROJECT_GUTENBERG',
        sourceTextType: 'ORIGINAL_TEXT',
        targetLanguages: ['en'],
        targetCountryCodes: ['US', 'DE'],
        plannedContentTypes: ['text'],
      })
      .expect(201);

    intakeId = created.body.id as string;

    await request(http())
      .patch(`/admin/rights/intakes/${intakeId}/status`)
      .set(...auth())
      .send({ status: 'READY_FOR_AGENT' })
      .expect(200);

    const imported = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports`)
      .set(...auth())
      .send({ reportJson: report() })
      .expect(201);

    const importId = imported.body.id as string;

    const materialized = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports/${importId}/materialize`)
      .set(...auth())
      .expect(201);

    profileId = materialized.body.id as string;
    reviewId = materialized.body.reviews[0].id as string;

    // Phase 18: the first review of an intake roots its own chain.
    expect(materialized.body.reviews[0].revisionNumber).toBe(1);
    expect(materialized.body.reviews[0].previousReviewId).toBeNull();

    await request(http())
      .post(`/admin/rights/reviews/${reviewId}/approve`)
      .set(...auth())
      .send({ notesRu: 'Утверждено для e2e' })
      .expect(201);
  });

  it('creates a book from the approved clearance without opening a false LANGUAGE_ADDED task', async () => {
    const book = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/create-book`)
      .set(...auth())
      .send({ slug: `recheck-e2e-${Date.now()}` })
      .expect(201);

    bookId = book.body.id as string;

    const versions = await request(http())
      .get(`/admin/books/${bookId}/versions`)
      .set(...auth())
      .expect(200);

    versionId = versions.body[0].id as string;

    const tasks = await request(http())
      .get(`/admin/rights/recheck/tasks?rightsIntakeId=${intakeId}`)
      .set(...auth())
      .expect(200);

    expect(tasks.body.items.some((t: { reason: string }) => t.reason === 'LANGUAGE_ADDED')).toBe(
      false,
    );
  });

  it('opens a SCHEDULED_DUE task for an overdue planned date and notifies the editor', async () => {
    await request(http())
      .patch(`/admin/rights/profiles/${profileId}/recheck-schedule`)
      .set(...auth())
      .send({ nextReviewAt: '2020-01-01T00:00:00.000Z' })
      .expect(200);

    const scan = await request(http())
      .post('/admin/rights/recheck/scan')
      .set(...auth())
      .expect(201);

    expect(scan.body.status).toBe('SUCCEEDED');

    const overdue = await request(http())
      .get('/admin/rights/recheck/tasks?overdueOnly=true')
      .set(...auth())
      .expect(200);

    const overdueItems = overdue.body.items as {
      id: string;
      reason: string;
      rightsProfileId: string;
      isOverdue: boolean;
      effectiveSeverity: string;
    }[];
    const scheduled = overdueItems.find(
      (t) => t.reason === 'SCHEDULED_DUE' && t.rightsProfileId === profileId,
    );
    expect(scheduled).toBeDefined();
    expect(scheduled.isOverdue).toBe(true);
    expect(scheduled.effectiveSeverity).toBe('BLOCKING');
    taskId = scheduled.id;

    const notifications = await request(http())
      .get('/admin/rights/notifications?limit=100')
      .set(...auth())
      .expect(200);

    const types = (notifications.body.items as { type: string }[]).map((n) => n.type);
    expect(types).toContain('RECHECK_TASK_OPENED');
    expect(types.some((type) => type === 'RECHECK_DUE' || type === 'RECHECK_OVERDUE')).toBe(true);
  });

  it('blocks publication through the gate while the recheck is overdue', async () => {
    const gate = await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set(...auth())
      .expect(200);

    expect(gate.body.canPublish).toBe(false);
    expect(
      gate.body.blockingReasons.some((r: { code: string }) => r.code === 'RIGHTS_RECHECK_OVERDUE'),
    ).toBe(true);
    expect(gate.body.overdueRecheckTasksCount).toBeGreaterThan(0);

    // Existing Phase 8 / 15 / 16 codes must still be reported unchanged.
    expect(gate.body.rightsRecheckRequired).toBe(false);
  });

  it('exposes the version recheck state for the admin UI', async () => {
    const state = await request(http())
      .get(`/admin/versions/${versionId}/recheck`)
      .set(...auth())
      .expect(200);

    expect(state.body.versionId).toBe(versionId);
    expect(state.body.tasks.length).toBeGreaterThan(0);
    expect(state.body.schedule.rightsProfileId).toBe(profileId);
  });

  it('closes the task and clears the gate blocker', async () => {
    await request(http())
      .post(`/admin/rights/recheck/tasks/${taskId}/start`)
      .set(...auth())
      .expect(201);

    const completed = await request(http())
      .post(`/admin/rights/recheck/tasks/${taskId}/complete`)
      .set(...auth())
      .send({ notesRu: 'Проверено, изменений нет', resolution: 'NO_CHANGE_NEEDED' })
      .expect(201);

    expect(completed.body.status).toBe('COMPLETED');
    expect(completed.body.events.map((e: { eventType: string }) => e.eventType)).toEqual(
      expect.arrayContaining(['TASK_CREATED', 'STARTED', 'COMPLETED']),
    );

    // The planned date must move too, otherwise the next scan reopens the same task.
    await request(http())
      .patch(`/admin/rights/profiles/${profileId}/recheck-schedule`)
      .set(...auth())
      .send({ nextReviewAt: '2030-01-01T00:00:00.000Z' })
      .expect(200);

    const gate = await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set(...auth())
      .expect(200);

    expect(
      gate.body.blockingReasons.some((r: { code: string }) => r.code === 'RIGHTS_RECHECK_OVERDUE'),
    ).toBe(false);
  });

  it('applies a legal change and opens LEGAL_CHANGE tasks in bulk', async () => {
    const created = await request(http())
      .post('/admin/rights/legal-changes')
      .set(...auth())
      .send({
        titleRu: 'Продление срока охраны в Германии',
        descriptionRu: 'Изменение срока охраны требует перепроверки затронутых клиренсов.',
        changeType: 'COPYRIGHT_TERM_CHANGE',
        severity: 'WARNING',
        jurisdictionCodes: ['DE'],
      })
      .expect(201);

    legalChangeId = created.body.id as string;
    expect(created.body.status).toBe('DRAFT');

    const applied = await request(http())
      .post(`/admin/rights/legal-changes/${legalChangeId}/apply`)
      .set(...auth())
      .expect(201);

    expect(applied.body.status).toBe('APPLIED');
    expect(applied.body.createdTasksCount).toBeGreaterThan(0);
    expect(applied.body.tasks.some((t: { reason: string }) => t.reason === 'LEGAL_CHANGE')).toBe(
      true,
    );

    // A second apply is refused — the event is no longer a DRAFT.
    await request(http())
      .post(`/admin/rights/legal-changes/${legalChangeId}/apply`)
      .set(...auth())
      .expect(409);

    const notifications = await request(http())
      .get('/admin/rights/notifications?type=LEGAL_CHANGE_APPLIED&limit=100')
      .set(...auth())
      .expect(200);

    // Exactly one summary notification, not one per affected profile.
    expect(notifications.body.items.length).toBe(1);
  });

  it('returns the ordered review chain of the intake', async () => {
    const chain = await request(http())
      .get(`/admin/rights/intakes/${intakeId}/review-chain`)
      .set(...auth())
      .expect(200);

    expect(chain.body.total).toBeGreaterThanOrEqual(1);
    expect(chain.body.items[0].revisionNumber).toBe(1);
    expect(chain.body.items[0].diffFromPrevious).toBeNull();
    expect(chain.body.items[0].id).toBe(reviewId);
  });

  it('records every scan run', async () => {
    const runs = await request(http())
      .get('/admin/rights/recheck/scan-runs?limit=5')
      .set(...auth())
      .expect(200);

    expect(runs.body.items.length).toBeGreaterThan(0);
    expect(runs.body.items[0].source).toBe('MANUAL');
    expect(runs.body.items[0].status).toBe('SUCCEEDED');
  });
});
