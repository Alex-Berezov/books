/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * WP-5 — жизненный цикл `RightsAction`, сквозная трассировка от HTTP-входа до эффекта в БД.
 *
 * До WP-5 этот путь не существовал: блокирующее действие мог закрыть только агент своим
 * отчётом (R3-03), человек — никогда (R3-02), поэтому интейк с таким действием было
 * невозможно ни утвердить, ни превратить в книгу, ни опубликовать.
 *
 * Требует живой БД — локально `yarn test:e2e`, в CI job «Tests & Quality Checks».
 */
describe('Rights actions lifecycle e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let intakeId: string;
  let profileId: string;
  let blockingActionId: string;
  let removalActionId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  /**
   * `RightsActionEvent` читается через delegate-interface (ADR-011): сгенерированный
   * Prisma-клиент обновляется только после `prisma generate`, который локально запрещён,
   * поэтому статическая типизация модели здесь недоступна — как и в продуктовом коде.
   */
  const actionEvents = () =>
    (prisma as unknown as Record<string, unknown>)['rightsActionEvent'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };

  /**
   * Отчёт агента, в котором он пытается закрыть собственные действия: `suggestedStatus`
   * у обоих — `WAIVED`. Плюс иллюстрация, которую агент обещает удалить и которая
   * закрывает рынок GB.
   */
  const report = (): Record<string, unknown> => ({
    schemaVersion: '1.0',
    intakeId,
    overallStatus: 'PUBLISHABLE',
    publicationGate: 'ALLOW',
    summaryRu: 'Пригодно к публикации после удаления иллюстраций',
    conclusionRu: 'Текст в общественном достоянии, иллюстрации под охраной',
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
        territoryAssessments: [
          {
            countryCode: 'GB',
            status: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            reasonRu: 'Public domain in GB',
            confidence: 'HIGH',
          },
        ],
      },
      {
        componentType: 'ILLUSTRATION',
        titleRu: 'Иллюстрации',
        status: 'COPYRIGHTED',
        requiredAction: 'REMOVE',
        confidence: 'HIGH',
        territoryAssessments: [
          {
            countryCode: 'GB',
            status: 'BLOCKED',
            accessPolicy: 'BLOCK',
            geoBlockRequired: true,
            reasonRu: 'Иллюстрации под охраной в GB',
            confidence: 'HIGH',
          },
        ],
      },
    ],
    territoryDecisions: [],
    requiredActions: [
      {
        actionType: 'REPLACE_ILLUSTRATIONS',
        descriptionRu: 'Заменить иллюстрации на собственные',
        affectedCountryCodes: ['GB'],
        isBlocking: false,
        suggestedStatus: 'WAIVED',
      },
      {
        actionType: 'OBTAIN_LICENSE',
        descriptionRu: 'Получить лицензию на обложку',
        affectedCountryCodes: ['GB'],
        isBlocking: true,
        suggestedStatus: 'WAIVED',
      },
    ],
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
        candidateTitle: 'Rights actions e2e',
        candidateAuthor: 'Test Author',
        sourceProvider: 'PROJECT_GUTENBERG',
        sourceTextType: 'ORIGINAL_TEXT',
        targetLanguages: ['en'],
        targetCountryCodes: ['GB'],
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

  // R3-03: агент присылает свои действия уже закрытыми и снимает собственный блокер.
  it('materializes the report with every agent-suggested action left open', async () => {
    const imported = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ reportJson: report() })
      .expect(201);

    expect(imported.body.importStatus).toBe('VALIDATED');

    const materialized = await request(http())
      .post(`/admin/rights/review-imports/${imported.body.id}/materialize`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(201);

    profileId = materialized.body.id as string;

    const actions = materialized.body.actions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => action.status === 'PENDING')).toBe(true);
    expect(actions.every((action) => action.isResolved === false)).toBe(true);

    blockingActionId = actions.find((action) => action.isBlocking === true)!.id as string;
    removalActionId = actions.find((action) => action.actionType === 'REPLACE_ILLUSTRATIONS')!
      .id as string;
  });

  // R6-06: страна не может быть объявлена открытой на основании обещания удалить компонент.
  it('keeps the market closed while the removal is only promised', async () => {
    const decision = await prisma.territoryDecision.findFirst({
      where: { rightsProfileId: profileId, countryCode: 'GB' },
    });

    expect(decision?.finalStatus).toBe('BLOCKED');
    expect(decision?.accessPolicy).toBe('BLOCK');
    expect(decision?.reasonRu).toContain('Иллюстрации');
  });

  // R3-02: до WP-5 интейк с блокирующим действием было невозможно утвердить вообще.
  it('refuses to approve the review while the blocking action is open', async () => {
    const profile = await prisma.rightsProfile.findUnique({
      where: { id: profileId },
      include: { reviews: true },
    });
    const reviewId = profile!.reviews[0].id;

    await request(http())
      .post(`/admin/rights/intakes/${intakeId}/reviews/${reviewId}/approve`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ notesRu: 'Проверено' })
      .expect(400);
  });

  it('refuses to waive an action without a comment', async () => {
    await request(http())
      .patch(`/admin/rights/actions/${blockingActionId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'WAIVED' })
      .expect(400);

    const untouched = await prisma.rightsAction.findUnique({ where: { id: blockingActionId } });
    expect(untouched?.status).toBe('PENDING');
  });

  it('lets an editor close the blocking action and records who did it', async () => {
    const closed = await request(http())
      .patch(`/admin/rights/actions/${blockingActionId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'COMPLETED', completionNotesRu: 'Лицензия на обложку получена.' })
      .expect(200);

    expect(closed.body.status).toBe('COMPLETED');
    expect(closed.body.isResolved).toBe(true);
    expect(closed.body.completedAt).toBeTruthy();
    expect(closed.body.completedByUserId).toBeTruthy();

    const events = await actionEvents().findMany({
      where: { rightsActionId: blockingActionId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]['eventType']).toBe('STATUS_CHANGED');
    expect(events[0]['fromStatus']).toBe('PENDING');
    expect(events[0]['toStatus']).toBe('COMPLETED');
    expect(events[0]['createdByUserId']).toBeTruthy();
  });

  // WP-5.5: закрытие действия на удаление — единственное подтверждение факта удаления.
  it('reopens the market once the removal action is closed', async () => {
    await request(http())
      .patch(`/admin/rights/actions/${removalActionId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'COMPLETED', completionNotesRu: 'Иллюстрации заменены собственными.' })
      .expect(200);

    const decision = await prisma.territoryDecision.findFirst({
      where: { rightsProfileId: profileId, countryCode: 'GB' },
    });

    expect(decision?.finalStatus).toBe('ALLOWED');
    expect(decision?.accessPolicy).toBe('ALLOW');
    expect(decision?.geoBlockRequired).toBe(false);
  });

  it('approves the review and creates the book once every blocking action is closed', async () => {
    const profile = await prisma.rightsProfile.findUnique({
      where: { id: profileId },
      include: { reviews: true },
    });
    const reviewId = profile!.reviews[0].id;

    await request(http())
      .post(`/admin/rights/intakes/${intakeId}/reviews/${reviewId}/approve`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ notesRu: 'Все обязательные действия выполнены' })
      .expect(201);

    const createdBook = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/create-book`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        slug: `rights-actions-e2e-${Date.now()}`,
        versions: [
          {
            language: 'en',
            title: 'Rights actions e2e',
            author: 'Test Author',
            description: 'Book created after every blocking action was closed',
            coverImageUrl: 'https://example.com/cover.jpg',
            type: 'text',
            isFree: true,
          },
        ],
      })
      .expect(201);

    expect(createdBook.body.book.id).toBeTruthy();

    const versionId = (createdBook.body.versions as Array<{ id: string }>)[0].id;
    const gate = await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(
      (gate.body.blockingReasons as Array<{ code: string }>).some(
        (reason) => reason.code === 'UNRESOLVED_BLOCKING_RIGHTS_ACTION',
      ),
    ).toBe(false);

    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
  });

  // Возврат из терминального статуса разрешён и строго ужесточает состояние.
  it('reopening a closed action makes it block publication again', async () => {
    const reopened = await request(http())
      .patch(`/admin/rights/actions/${blockingActionId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'PENDING' })
      .expect(200);

    expect(reopened.body.status).toBe('PENDING');
    expect(reopened.body.isResolved).toBe(false);
    expect(reopened.body.completedAt).toBeNull();
    expect(reopened.body.completedByUserId).toBeNull();
  });
});
