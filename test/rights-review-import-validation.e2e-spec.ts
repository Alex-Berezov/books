/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * WP-6 — валидация импорта: наличие полей (R4-01) и диагностика сбоя материализации (R9-02).
 * Сквозная трассировка от HTTP-входа до эффекта в БД.
 *
 * До WP-6 отчёт без обязательного поля проходил как `VALIDATED`, переводил интейк в
 * `REVIEW_IMPORTED` и ронял `POST .../materialize` голой 500-й: интейк оставался в тупике,
 * кнопка Build Rights Profile всегда отвечала ошибкой без объяснения.
 *
 * Требует живой БД — локально `yarn test:e2e`, в CI job «Tests & Quality Checks».
 */
describe('Rights review import validation e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let intakeId: string;
  let importId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const completeReport = (): Record<string, unknown> => ({
    schemaVersion: '1.0',
    intakeId,
    overallStatus: 'PUBLISHABLE',
    publicationGate: 'ALLOW',
    summaryRu: 'Пригодно к публикации',
    conclusionRu: 'Текст в общественном достоянии',
    confidence: 'HIGH',
    nextReviewAt: '2027-01-01T00:00:00.000Z',
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
        reasonRu: 'Public domain in US',
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
  });

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
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

    const created = await request(http())
      .post('/admin/rights/intakes')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        candidateTitle: 'Import validation e2e',
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
      .patch(`/admin/rights/intakes/${intakeId}/status`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'READY_FOR_AGENT' })
      .expect(200);
  });

  afterAll(async () => {
    if (intakeId) {
      await prisma.rightsIntake.delete({ where: { id: intakeId } }).catch(() => undefined);
    }
    await app.close();
  });

  // R4-01: отчёт без полей, которые NOT NULL в схеме, до WP-6.1 проходил валидацию.
  it('rejects a report whose nested blocks miss required fields and leaves the intake untouched', async () => {
    const report = completeReport();
    delete (report.territoryDecisions as Array<Record<string, unknown>>)[0].reasonRu;
    delete (report.componentAssessments as Array<Record<string, unknown>>)[0].requiredAction;
    delete (report.evidence as Array<Record<string, unknown>>)[0].authority;

    const rejected = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ reportJson: report })
      .expect(201);

    expect(rejected.body.importStatus).toBe('VALIDATION_FAILED');
    expect(rejected.body.isCurrent).toBe(false);

    const errors = rejected.body.validationErrors as Array<Record<string, string>>;
    const missing = errors.filter((issue) => issue.code === 'MISSING_FIELD').map((i) => i.path);
    expect(missing).toEqual(
      expect.arrayContaining([
        'territoryDecisions[0].reasonRu',
        'componentAssessments[0].requiredAction',
        'evidence[0].authority',
      ]),
    );

    const intake = await prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    expect(intake?.workflowStatus).toBe('READY_FOR_AGENT');
  });

  it('accepts the corrected report and materializes it', async () => {
    const imported = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ reportJson: completeReport() })
      .expect(201);

    expect(imported.body.importStatus).toBe('VALIDATED');
    importId = imported.body.id as string;

    const intake = await prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    expect(intake?.workflowStatus).toBe('REVIEW_IMPORTED');
  });

  /**
   * R9-02: сбой материализации в ручном канале. Импорт портится напрямую в БД — так
   * воспроизводится состояние, которое до WP-6.1 создавал сам валидатор: запись `VALIDATED`
   * и `isCurrent`, которую невозможно разложить в модель прав.
   */
  it('answers 422 with a diagnosis instead of a bare 500 when a validated import cannot be materialized', async () => {
    const record = await prisma.rightsReviewImport.findUnique({ where: { id: importId } });
    const broken = record!.reportJson as unknown as Record<string, unknown>;
    delete (broken.territoryDecisions as Array<Record<string, unknown>>)[0].reasonRu;

    await prisma.rightsReviewImport.update({
      where: { id: importId },
      data: { reportJson: broken as never },
    });

    const failed = await request(http())
      .post(`/admin/rights/review-imports/${importId}/materialize`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(422);

    expect(failed.body.code).toBe('REPORT_NOT_MATERIALIZABLE');
    expect(failed.body.importId).toBe(importId);
    expect(String(failed.body.reason)).toBeTruthy();

    // Уведомление — вторая половина R9-02: раньше его писал только агентский канал.
    const notifications = await prisma.rightsNotification.findMany({
      where: { rightsReviewImportId: importId, type: 'AGENT_REPORT_MATERIALIZATION_FAILED' },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].agentSubmissionId).toBeNull();
    expect(notifications[0].messageRu).toContain('Import validation e2e');

    const profile = await prisma.rightsProfile.findFirst({ where: { rightsIntakeId: intakeId } });
    expect(profile).toBeNull();
  });

  it('materializes the repaired import and leaves no further failure notifications', async () => {
    await prisma.rightsReviewImport.update({
      where: { id: importId },
      data: { reportJson: completeReport() as never },
    });

    const materialized = await request(http())
      .post(`/admin/rights/review-imports/${importId}/materialize`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(201);

    expect(materialized.body.id).toBeTruthy();

    const decision = await prisma.territoryDecision.findFirst({
      where: { rightsProfileId: materialized.body.id as string, countryCode: 'US' },
    });
    expect(decision?.reasonRu).toBe('Public domain in US');

    const notifications = await prisma.rightsNotification.findMany({
      where: { rightsReviewImportId: importId, type: 'AGENT_REPORT_MATERIALIZATION_FAILED' },
    });
    expect(notifications).toHaveLength(1);
  });
});
