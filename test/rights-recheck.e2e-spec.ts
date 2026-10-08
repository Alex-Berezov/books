/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * Phase 18 recheck e2e. Requires a live database, so it is NOT part of the local
 * unit run — execute on the VPS/CI with `yarn test:e2e:serial`.
 *
 * Решение владельца 27.09.2026: автоматических перепроверок нет. Скан, новая языковая версия
 * и изменение законодательства задач не открывают; задачу заводит только редактор руками,
 * и ни одна задача — даже просроченная — публикацию не блокирует.
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
    // Deterministic runs: only the explicit admin scan triggers the workflow.
    process.env.RIGHTS_RECHECK_SCHEDULER_ENABLED = '0';

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
    await grantStaffRoles(app, 'admin@example.com');
  });

  afterAll(async () => {
    if (legalChangeId) {
      await prisma
        .$executeRawUnsafe('DELETE FROM "RightsLegalChangeEvent" WHERE id = $1', legalChangeId)
        .catch(() => undefined);
    }
    // Book first: deleting the intake only nulls Book.rightsIntakeId, it does not remove the book.
    if (bookId) {
      await prisma.book.delete({ where: { id: bookId } }).catch(() => undefined);
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

    // Materialization lives on RightsProfileController, not nested under the intake.
    const materialized = await request(http())
      .post(`/admin/rights/review-imports/${importId}/materialize`)
      .set(...auth())
      .expect(201);

    profileId = materialized.body.id as string;
    reviewId = materialized.body.reviews[0].id as string;

    // Phase 18: the first review of an intake roots its own chain.
    expect(materialized.body.reviews[0].revisionNumber).toBe(1);
    expect(materialized.body.reviews[0].previousReviewId).toBeNull();
    expect(materialized.body.reviews[0].chainRootReviewId).toBe(reviewId);

    await request(http())
      .post(`/admin/rights/intakes/${intakeId}/reviews/${reviewId}/approve`)
      .set(...auth())
      .send({ notesRu: 'Утверждено для e2e' })
      .expect(201);
  });

  it('creates a book from the approved clearance without opening a LANGUAGE_ADDED task', async () => {
    // `versions[]` is mandatory: the endpoint creates the book and its versions in one call
    // and returns both, so no separate version lookup is needed.
    const book = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/create-book`)
      .set(...auth())
      .send({
        slug: `recheck-e2e-${Date.now()}`,
        versions: [
          {
            language: 'en',
            title: 'Recheck e2e',
            author: 'Test Author',
            description: 'Книга для e2e-проверки перепроверок прав.',
            coverImageUrl: 'https://example.com/cover.jpg',
            type: 'text',
            isFree: true,
          },
        ],
      })
      .expect(201);

    bookId = book.body.book.id as string;
    versionId = book.body.versions[0].id as string;

    const tasks = await request(http())
      .get(`/admin/rights/recheck/tasks?rightsIntakeId=${intakeId}`)
      .set(...auth())
      .expect(200);

    // LANGUAGE_ADDED не открывается больше ни одним путём (решение владельца 27.09.2026);
    // исходные версии к тому же создаёт RightsBookCreationService, а не BookVersionService.create.
    expect(tasks.body.items.some((t: { reason: string }) => t.reason === 'LANGUAGE_ADDED')).toBe(
      false,
    );
  });

  it('scan opens no SCHEDULED_DUE task for an overdue planned date (owner decision 27.09.2026)', async () => {
    // Ровно тот вход, на котором прежний шаг A открывал SCHEDULED_DUE: политика, которая
    // наследует дату отчёта, и плановая дата давно в прошлом.
    await request(http())
      .patch(`/admin/rights/profiles/${profileId}/recheck-schedule`)
      .set(...auth())
      .send({ recheckPolicy: 'INHERIT_REPORT', nextReviewAt: '2020-01-01T00:00:00.000Z' })
      .expect(200);

    const scan = await request(http())
      .post('/admin/rights/recheck/scan')
      .set(...auth())
      .expect(201);

    expect(scan.body.status).toBe('SUCCEEDED');
    expect(scan.body.tasksCreated).toBe(0);

    const tasks = await request(http())
      .get(`/admin/rights/recheck/tasks?rightsProfileId=${profileId}&limit=100`)
      .set(...auth())
      .expect(200);

    expect(tasks.body.items).toEqual([]);
  });

  it('lets the editor open an overdue recheck task by hand', async () => {
    const created = await request(http())
      .post('/admin/rights/recheck/tasks')
      .set(...auth())
      .send({
        rightsProfileId: profileId,
        bookVersionId: versionId,
        titleRu: 'Ручная перепроверка прав',
        descriptionRu: 'Редактор завёл перепроверку сам.',
        dueAt: '2020-01-01T00:00:00.000Z',
        severity: 'BLOCKING',
      })
      .expect(201);

    expect(created.body.reason).toBe('MANUAL_REQUEST');
    expect(created.body.source).toBe('MANUAL');
    expect(created.body.isOverdue).toBe(true);
    expect(created.body.effectiveSeverity).toBe('BLOCKING');
    taskId = created.body.id as string;

    const notifications = await request(http())
      .get('/admin/rights/notifications?limit=100')
      .set(...auth())
      .expect(200);

    const types = (notifications.body.items as { type: string }[]).map((n) => n.type);
    expect(types).toContain('RECHECK_TASK_OPENED');
  });

  it('combines an explicit status with overdueOnly via AND instead of overwriting it (LEGACY-406)', async () => {
    // Открытая, но не просроченная задача: без неё `overdueOnly` неотличим от «любая открытая».
    const future = await prisma.rightsRecheckTask.create({
      data: {
        reason: 'MANUAL_REQUEST',
        source: 'MANUAL',
        rightsProfileId: profileId,
        titleRu: 'Ручная задача со сроком в будущем',
        descriptionRu: 'Не просрочена',
        dueAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });

    try {
      const contradictory = await request(http())
        .get(
          `/admin/rights/recheck/tasks?rightsProfileId=${profileId}&limit=100&status=COMPLETED&overdueOnly=true`,
        )
        .set(...auth())
        .expect(200);
      const contradictoryItems = contradictory.body.items as { id: string }[];
      expect(contradictoryItems.some((t) => t.id === taskId)).toBe(false);

      const consistent = await request(http())
        .get(
          `/admin/rights/recheck/tasks?rightsProfileId=${profileId}&limit=100&status=PENDING&overdueOnly=true`,
        )
        .set(...auth())
        .expect(200);
      const consistentItems = consistent.body.items as { id: string }[];
      expect(consistentItems.some((t) => t.id === taskId)).toBe(true);
      // Срок в будущем — задача открыта, но под `overdueOnly` не подпадает.
      expect(consistentItems.some((t) => t.id === future.id)).toBe(false);

      // Пара флагов различает сложение и `else if` только по структуре `where` (это сверяет юнит):
      // просроченное всегда внутри окна `dueWithinDays`, поэтому набор строк у обеих форм один.
      // Здесь проверяется другое — что пара не теряет `overdueOnly` и не расширяет выдачу окном.
      const bothFlags = await request(http())
        .get(
          `/admin/rights/recheck/tasks?rightsProfileId=${profileId}&limit=100&overdueOnly=true&dueWithinDays=180`,
        )
        .set(...auth())
        .expect(200);
      const bothFlagsItems = bothFlags.body.items as { id: string }[];
      expect(bothFlagsItems.some((t) => t.id === taskId)).toBe(true);
      expect(bothFlagsItems.some((t) => t.id === future.id)).toBe(false);

      const windowOnly = await request(http())
        .get(`/admin/rights/recheck/tasks?rightsProfileId=${profileId}&limit=100&dueWithinDays=180`)
        .set(...auth())
        .expect(200);
      const windowOnlyItems = windowOnly.body.items as { id: string }[];
      expect(windowOnlyItems.some((t) => t.id === future.id)).toBe(true);
    } finally {
      await prisma.rightsRecheckTask.delete({ where: { id: future.id } });
    }
  });

  it('does not block publication while the recheck is overdue, only warns', async () => {
    const gate = await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set(...auth())
      .expect(200);

    expect(
      gate.body.blockingReasons.some((r: { code: string }) => r.code.startsWith('RIGHTS_RECHECK_')),
    ).toBe(false);
    expect(
      gate.body.warnings.some((r: { code: string }) => r.code === 'RIGHTS_RECHECK_OVERDUE'),
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

  it('closes the task and clears the gate warning', async () => {
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

    const gate = await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set(...auth())
      .expect(200);

    expect(
      gate.body.blockingReasons.some((r: { code: string }) => r.code === 'RIGHTS_RECHECK_OVERDUE'),
    ).toBe(false);
    expect(
      gate.body.warnings.some((r: { code: string }) => r.code === 'RIGHTS_RECHECK_OVERDUE'),
    ).toBe(false);
  });

  it('applies a legal change as a record and opens no LEGAL_CHANGE task', async () => {
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
    expect(applied.body.appliedAt).not.toBeNull();
    // Профиль этой книги решал по DE — он затронут, но задачи перепроверки не открыты.
    expect(applied.body.affectedProfilesCount).toBeGreaterThan(0);
    expect(applied.body.createdTasksCount).toBe(0);
    expect(applied.body.tasksCount).toBe(0);
    expect(applied.body.tasks).toEqual([]);

    const legalTasks = await request(http())
      .get(`/admin/rights/recheck/tasks?reason=LEGAL_CHANGE&rightsProfileId=${profileId}`)
      .set(...auth())
      .expect(200);
    expect(legalTasks.body.items).toEqual([]);

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

    // `LEGACY-177`: цепочка отдаётся одной страницей в единой обёртке.
    const chainBody = chain.body as {
      items: unknown[];
      pagination: { total: number; totalPages: number };
    };
    expect(Object.keys(chainBody).sort()).toEqual(['items', 'pagination']);
    expect(chainBody.pagination.total).toBeGreaterThanOrEqual(1);
    expect(chainBody.pagination.totalPages).toBe(1);
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
