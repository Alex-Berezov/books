/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 19 lawyer workflow e2e. Requires a live database, so it is NOT part of the local unit
 * run — execute on the VPS/CI with `yarn test:e2e:serial`.
 *
 * The full path exercised here:
 *   intake → report import → risk assessment says HIGH → approve is refused (409) →
 *   legal review requested → lawyer assigned → opinion attached → APPROVED_WITH_CONDITIONS →
 *   approve now passes but publication is still blocked by the unmet condition →
 *   condition satisfied → publication passes.
 *
 * The report is deliberately LOW-confidence: that is the deterministic way to push
 * `computeRiskAssessment` to HIGH without depending on claims or territory data.
 */
describe('Rights lawyer workflow e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let intakeId: string;
  let profileId: string;
  let reviewId: string;
  let lawyerId: string;
  let lawyerReviewId: string;
  let conditionId: string;
  let bookId: string;
  let versionId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const auth = (): [string, string] => ['Authorization', `Bearer ${adminAccess}`];

  const report = (): Record<string, unknown> => ({
    schemaVersion: '1.0',
    intakeId,
    overallStatus: 'PUBLISHABLE',
    publicationGate: 'ALLOW',
    summaryRu: 'Пригодно к публикации, но уверенность низкая',
    conclusionRu: 'Требуется юридическая проверка',
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
        confidence: 'LOW',
      },
    ],
    territoryDecisions: [
      {
        countryCode: 'US',
        finalStatus: 'ALLOWED',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
        reasonRu: 'Public domain',
        confidence: 'LOW',
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
    // LOW profile confidence is the risk factor this suite relies on.
    confidence: 'LOW',
    nextReviewAt: '2028-01-01T00:00:00.000Z',
  });

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.RIGHTS_LAWYER_WORKFLOW_ENABLED = '1';
    process.env.RIGHTS_LAWYER_BLOCK_APPROVAL_ON_HIGH_RISK = '1';
    process.env.RIGHTS_LAWYER_MIN_RISK_LEVEL = 'HIGH';
    // Phase 18 scheduler off: it must not interfere with the assertions below.
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
  });

  afterAll(async () => {
    if (bookId) {
      await prisma.book.delete({ where: { id: bookId } }).catch(() => undefined);
    }
    if (intakeId) {
      await prisma.rightsIntake.delete({ where: { id: intakeId } }).catch(() => undefined);
    }
    if (lawyerId) {
      await prisma
        .$executeRawUnsafe('DELETE FROM "RightsLawyer" WHERE id = $1', lawyerId)
        .catch(() => undefined);
    }
    await app.close();
  });

  it('creates an intake and materialises a LOW-confidence report', async () => {
    const created = await request(http())
      .post('/admin/rights/intakes')
      .set(...auth())
      .send({
        candidateTitle: 'Lawyer workflow e2e',
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
      .set(...auth())
      .send({ status: 'READY_FOR_AGENT' })
      .expect(200);

    const imported = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports`)
      .set(...auth())
      .send({ reportJson: report() })
      .expect(201);

    const materialized = await request(http())
      .post(`/admin/rights/review-imports/${imported.body.id as string}/materialize`)
      .set(...auth())
      .expect(201);

    profileId = materialized.body.id as string;
    reviewId = materialized.body.reviews[0].id as string;
  });

  it('assesses the risk as HIGH and marks a lawyer as required', async () => {
    const assessment = await request(http())
      .get(`/admin/rights/profiles/${profileId}/risk-assessment`)
      .set(...auth())
      .expect(200);

    expect(assessment.body.riskLevel).toBe('HIGH');
    expect(assessment.body.lawyerReviewRequired).toBe(true);
    expect(assessment.body.factors.map((factor: { code: string }) => factor.code)).toContain(
      'CONFIDENCE_LOW',
    );
  });

  it('refuses the ordinary approval with LAWYER_APPROVAL_REQUIRED', async () => {
    const response = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/reviews/${reviewId}/approve`)
      .set(...auth())
      .send({ notesRu: 'попытка утвердить без юриста' })
      .expect(409);

    expect(response.body.code).toBe('LAWYER_APPROVAL_REQUIRED');
    expect(response.body.details.riskLevel).toBe('HIGH');
  });

  it('opens a legal review and moves the intake to LAWYER_REVIEW_REQUIRED', async () => {
    const created = await request(http())
      .post(`/admin/rights/profiles/${profileId}/require-lawyer-review`)
      .set(...auth())
      .send({ questionRu: 'Можно ли публиковать это издание в США?' })
      .expect(201);

    lawyerReviewId = created.body.id as string;
    expect(created.body.blocksApproval).toBe(true);
    expect(created.body.status).toBe('PENDING');

    const intake = await request(http())
      .get(`/admin/rights/intakes/${intakeId}`)
      .set(...auth())
      .expect(200);
    expect(intake.body.workflowStatus).toBe('LAWYER_REVIEW_REQUIRED');
  });

  it('creates a lawyer and assigns the review to them', async () => {
    const lawyer = await request(http())
      .post('/admin/rights/lawyers')
      .set(...auth())
      .send({
        fullName: 'Иванова Анна Сергеевна',
        lawyerType: 'EXTERNAL_COUNSEL',
        organization: 'Юридическое бюро «Право»',
        jurisdictionCodes: ['US', 'RU'],
      })
      .expect(201);

    lawyerId = lawyer.body.id as string;

    const assigned = await request(http())
      .post(`/admin/rights/lawyer-reviews/${lawyerReviewId}/assign`)
      .set(...auth())
      .send({ lawyerId })
      .expect(201);

    expect(assigned.body.assignedLawyerId).toBe(lawyerId);
  });

  it('attaches a legal opinion and creates LEGAL_OPINION evidence', async () => {
    const opinion = await request(http())
      .post(`/admin/rights/lawyer-reviews/${lawyerReviewId}/opinions`)
      .set(...auth())
      .send({
        kind: 'EXTERNAL_COUNSEL_MEMO',
        titleRu: 'Меморандум о правах',
        bodyRu: 'Произведение перешло в общественное достояние в США.',
        lawyerId,
        jurisdictionCodes: ['US'],
      })
      .expect(201);

    expect(opinion.body.rightsEvidenceId).toBeTruthy();
    expect(opinion.body.lawyerNameSnapshot).toBe('Иванова Анна Сергеевна');

    const profile = await request(http())
      .get(`/admin/rights/profiles/${profileId}`)
      .set(...auth())
      .expect(200);

    expect(
      profile.body.evidence.some(
        (item: { evidenceType: string }) => item.evidenceType === 'LEGAL_OPINION',
      ),
    ).toBe(true);
  });

  it('records an APPROVED_WITH_CONDITIONS decision with the lawyer name snapshot', async () => {
    const decided = await request(http())
      .post(`/admin/rights/lawyer-reviews/${lawyerReviewId}/decide`)
      .set(...auth())
      .send({
        decision: 'APPROVED_WITH_CONDITIONS',
        lawyerId,
        opinionSummaryRu: 'Публикация допустима при выполнении одного условия.',
        conditions: [
          { code: 'ATTRIBUTION_TEXT', textRu: 'Указать источник издания', isBlocking: true },
        ],
      })
      .expect(201);

    expect(decided.body.status).toBe('APPROVED_WITH_CONDITIONS');
    expect(decided.body.lawyerNameSnapshot).toBe('Иванова Анна Сергеевна');
    expect(decided.body.conditions).toHaveLength(1);
    conditionId = decided.body.conditions[0].id as string;

    const intake = await request(http())
      .get(`/admin/rights/intakes/${intakeId}`)
      .set(...auth())
      .expect(200);
    // The lawyer unblocks the editor but never approves the intake themselves.
    expect(intake.body.workflowStatus).toBe('HUMAN_REVIEW_REQUIRED');
  });

  it('renaming the lawyer does not rewrite the snapshot in the decision', async () => {
    await request(http())
      .patch(`/admin/rights/lawyers/${lawyerId}`)
      .set(...auth())
      .send({ fullName: 'Петрова Анна Сергеевна' })
      .expect(200);

    const review = await request(http())
      .get(`/admin/rights/lawyer-reviews/${lawyerReviewId}`)
      .set(...auth())
      .expect(200);

    expect(review.body.lawyerNameSnapshot).toBe('Иванова Анна Сергеевна');
    expect(review.body.assignedLawyerName).toBe('Петрова Анна Сергеевна');
  });

  it('now allows the ordinary approval and creates the book', async () => {
    await request(http())
      .post(`/admin/rights/intakes/${intakeId}/reviews/${reviewId}/approve`)
      .set(...auth())
      .send({ notesRu: 'юрист согласовал' })
      .expect(201);

    // `versions[]` is required (min 1) and the response is `{ book, versions, … }` —
    // the book id lives under `body.book.id`, not `body.id`.
    const book = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/create-book`)
      .set(...auth())
      .send({
        slug: `lawyer-e2e-${Date.now()}`,
        versions: [
          {
            language: 'en',
            title: 'Lawyer workflow e2e',
            author: 'Test Author',
            description: 'Книга для e2e-проверки юридического workflow.',
            coverImageUrl: 'https://example.com/cover.jpg',
            type: 'text',
            isFree: true,
          },
        ],
      })
      .expect(201);

    bookId = book.body.book.id as string;
    versionId = book.body.versions[0].id as string;
  });

  it('still blocks publication while the condition is unmet', async () => {
    const gate = await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set(...auth())
      .expect(200);

    expect(gate.body.canPublish).toBe(false);
    expect(
      gate.body.blockingReasons.some(
        (reason: { code: string }) => reason.code === 'LAWYER_CONDITIONS_UNMET',
      ),
    ).toBe(true);
    expect(gate.body.pendingLawyerConditionsCount).toBe(1);
  });

  it('unblocks publication once the condition is satisfied', async () => {
    await request(http())
      .post(`/admin/rights/lawyer-reviews/${lawyerReviewId}/conditions/${conditionId}/satisfy`)
      .set(...auth())
      .send({ notesRu: 'атрибуция добавлена' })
      .expect(201);

    const gate = await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set(...auth())
      .expect(200);

    expect(
      gate.body.blockingReasons.some((reason: { code: string }) =>
        reason.code.startsWith('LAWYER_'),
      ),
    ).toBe(false);
    expect(
      gate.body.warnings.some(
        (reason: { code: string }) => reason.code === 'LAWYER_APPROVED_WITH_CONDITIONS',
      ),
    ).toBe(true);
    expect(gate.body.lawyerApproved).toBe(true);
  });

  it('never writes approvedReviewId or publishes on any Phase 19 path', async () => {
    const reviews = await request(http())
      .get(`/admin/rights/intakes/${intakeId}/lawyer-reviews`)
      .set(...auth())
      .expect(200);

    expect(reviews.body.items).toHaveLength(1);

    const version = await prisma.bookVersion.findUnique({ where: { id: versionId } });
    // Phase 19 never publishes: the version created from the clearance stays a draft.
    expect(version?.status).toBe('draft');
  });
});
