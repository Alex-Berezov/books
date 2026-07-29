/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 17 agent/API import automation e2e. Requires a live database, so it is not part of the
 * local unit run — execute on the VPS/CI with `yarn test:e2e:serial`.
 */
describe('Rights agent import e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let intakeId: string;
  let rawToken: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

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
    process.env.RIGHTS_AGENT_UPLOAD_ENABLED = '1';
    process.env.RATE_LIMIT_AGENT_UPLOAD_ENABLED = '0';

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
    if (intakeId) {
      await prisma.rightsIntake.delete({ where: { id: intakeId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('creates an intake and marks it READY_FOR_AGENT', async () => {
    const created = await request(http())
      .post('/admin/rights/intakes')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        candidateTitle: 'Agent automation e2e',
        candidateAuthor: 'Test Author',
        sourceProvider: 'PROJECT_GUTENBERG',
        sourceTextType: 'ORIGINAL_TEXT',
        targetLanguages: ['en'],
        targetCountryCodes: ['US'],
        plannedContentTypes: ['text'],
      })
      .expect(201);

    intakeId = created.body.id as string;

    await request(http())
      .patch(`/admin/rights/intakes/${intakeId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ workflowStatus: 'READY_FOR_AGENT' })
      .expect(200);
  });

  it('issues a one-time upload token and returns the raw value exactly once', async () => {
    const issued = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/agent-tokens`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ labelRu: 'e2e token', ttlHours: 1, maxUses: 1 })
      .expect(201);

    rawToken = issued.body.token as string;
    expect(rawToken.startsWith('brat_')).toBe(true);
    expect(issued.body.isUsable).toBe(true);

    const list = await request(http())
      .get(`/admin/rights/intakes/${intakeId}/agent-tokens`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(JSON.stringify(list.body)).not.toContain(rawToken);
    expect(list.body.items[0].tokenPrefix).toBe(rawToken.slice(0, 12));
  });

  it('serves the versioned report schema publicly', async () => {
    const latest = await request(http()).get('/rights/agent/report-schema').expect(200);
    expect(latest.body.schemaVersion).toBe('1.0');

    const pinned = await request(http()).get('/rights/agent/report-schema/1.0').expect(200);
    expect(pinned.body.$id).toContain('/1.0');

    const unknown = await request(http()).get('/rights/agent/report-schema/9.9').expect(404);
    expect(unknown.body.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('lets the agent fetch its manifest with the token and no JWT', async () => {
    const manifest = await request(http())
      .get('/rights/agent/manifest')
      .set('X-Bibliaris-Agent-Token', rawToken)
      .expect(200);

    expect(manifest.body.intake.id).toBe(intakeId);
    expect(manifest.body.expectedResultSchema.schemaUrl).toContain('/report-schema/1.0');
    expect(manifest.body.expectedResultSchema.submission.method).toBe('POST');
  });

  it('accepts a valid report, materializes it and requires human approval', async () => {
    const submitted = await request(http())
      .post('/rights/agent/submissions')
      .set('X-Bibliaris-Agent-Token', rawToken)
      .send({ intakeId, report: report(), agentName: 'e2e-agent', agentVersion: '1.0' })
      .expect(201);

    expect(submitted.body.status).toBe('VALIDATED');
    expect(submitted.body.humanApprovalRequired).toBe(true);
    expect(submitted.body.materialization).toBe('SUCCEEDED');
    expect(submitted.body.validationErrors).toEqual([]);
    // Nothing internal leaks to the agent.
    expect(submitted.body.rightsProfileId).toBeUndefined();
  });

  it('rejects a second submission with the same token', async () => {
    const second = await request(http())
      .post('/rights/agent/submissions')
      .set('X-Bibliaris-Agent-Token', rawToken)
      .send({ intakeId, report: report() })
      .expect(401);

    expect(second.body.code).toBe('AGENT_TOKEN_EXHAUSTED');
  });

  it('rejects a submission without any token', async () => {
    const anonymous = await request(http())
      .post('/rights/agent/submissions')
      .send({ intakeId, report: report() })
      .expect(401);

    expect(anonymous.body.code).toBe('AGENT_TOKEN_MISSING');
  });

  it('moves the intake to HUMAN_REVIEW_REQUIRED — the agent never approves', async () => {
    const intake = await request(http())
      .get(`/admin/rights/intakes/${intakeId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(intake.body.workflowStatus).toBe('HUMAN_REVIEW_REQUIRED');
    expect(intake.body.approvedReviewId).toBeNull();
  });

  it('notifies the editor in-app about the received report', async () => {
    const notifications = await request(http())
      .get('/admin/rights/notifications')
      .set('Authorization', `Bearer ${adminAccess}`)
      .query({ rightsIntakeId: intakeId, limit: 50 })
      .expect(200);

    const types = (notifications.body.items as { type: string }[]).map((item) => item.type);
    expect(types).toContain('AGENT_REPORT_RECEIVED');
    expect(types).toContain('HUMAN_REVIEW_REQUIRED');

    const unread = await request(http())
      .get('/admin/rights/notifications/unread-count')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(unread.body.unreadCount).toBeGreaterThan(0);
  });

  it('journals every authenticated submission, including the rejected retry', async () => {
    const submissions = await request(http())
      .get(`/admin/rights/intakes/${intakeId}/agent-submissions`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(submissions.body.total).toBeGreaterThanOrEqual(1);
    expect(submissions.body.items[0].tokenPrefix).toBe(rawToken.slice(0, 12));
  });
});
