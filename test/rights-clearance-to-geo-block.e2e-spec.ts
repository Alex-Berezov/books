/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Приёмочный сквозной сценарий продукта: **редактор записал результат проверки прав —
 * и чтение книги закрылось в тех странах, которые проверка назвала закрытыми.**
 *
 * Это единственная пара требований, ради которой существует вся система прав, и до
 * 02.08.2026 она не была покрыта целиком ни одним тестом: `rights-actions.e2e-spec.ts`
 * доводит цепочку до публикации, `geo-block.e2e-spec.ts` проверяет 451 на правилах,
 * созданных руками прямо в базе. Стык между ними — «решение по стране из отчёта
 * действительно превращается в правило рантайма» — не проверял никто, а именно там
 * ревью нашло больше половины серьёзных находок (R5-02, R5-03, R6-01).
 *
 * Трассировка: HTTP-импорт отчёта → материализация → утверждение → создание книги →
 * генерация geo-правил → верификация → публикация → публичный запрос из закрытой страны.
 *
 * Требует живой БД — локально `yarn test:e2e`, в CI job «Tests & Quality Checks».
 */
describe('Rights clearance to geo-block e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let intakeId: string;
  let profileId: string;
  let reviewId: string;
  let bookId: string;
  let versionId: string;
  let chapterId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  /**
   * Отчёт проверки в терминах ТЗ «Проверка авторских прав книги для публикации в Bibliaris»:
   * текст в общественном достоянии в США, но охраняется в Великобритании — итог
   * «🟠 можно публиковать с географическими ограничениями».
   *
   * `geoBlockRequired: true` у GB — это и есть ответ на вопрос ТЗ «нужна ли геоблокировка».
   */
  const report = (): Record<string, unknown> => ({
    schemaVersion: '1.0',
    intakeId,
    overallStatus: 'PUBLISHABLE_WITH_GEO_RESTRICTIONS',
    publicationGate: 'ALLOW_AFTER_GEO_CONFIGURATION',
    summaryRu: 'Текст свободен в США, охраняется в Великобритании',
    conclusionRu: 'Публиковать с блокировкой Великобритании',
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
        requiresGeoBlock: true,
      },
    ],
    componentAssessments: [],
    territoryDecisions: [
      {
        countryCode: 'US',
        finalStatus: 'ALLOWED',
        accessPolicy: 'ALLOW',
        reasonRu: 'Произведение в общественном достоянии в США',
        confidence: 'HIGH',
        geoBlockRequired: false,
      },
      {
        countryCode: 'GB',
        finalStatus: 'BLOCKED',
        accessPolicy: 'BLOCK',
        reasonRu: 'Срок охраны в Великобритании не истёк',
        confidence: 'HIGH',
        geoBlockRequired: true,
        geoBlockScope: 'LANGUAGE_EDITION',
      },
    ],
    requiredActions: [],
    evidence: [
      {
        evidenceType: 'GUTENBERG_PAGE',
        sourceLevel: 'PRIMARY',
        title: 'Project Gutenberg book page',
        authority: 'Project Gutenberg',
        summaryRu: 'Страница книги на Project Gutenberg',
      },
    ],
  });

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.ENABLE_GEO_TEST_HEADERS = 'true';
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
        candidateTitle: 'Clearance to geo-block e2e',
        candidateAuthor: 'Test Author',
        sourceProvider: 'PROJECT_GUTENBERG',
        sourceTextType: 'ORIGINAL_TEXT',
        targetLanguages: ['en'],
        targetCountryCodes: ['US', 'GB'],
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
    if (bookId) {
      await prisma.book.delete({ where: { id: bookId } }).catch(() => undefined);
    }
    if (intakeId) {
      await prisma.rightsIntake.delete({ where: { id: intakeId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('accepts the recorded check result and turns the closed market into a country decision', async () => {
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

    const decisions = await prisma.territoryDecision.findMany({
      where: { rightsProfileId: profileId },
      orderBy: { countryCode: 'asc' },
    });

    expect(decisions.map((d) => d.countryCode)).toEqual(['GB', 'US']);
    const gb = decisions.find((d) => d.countryCode === 'GB');
    expect(gb?.finalStatus).toBe('BLOCKED');
    expect(gb?.geoBlockRequired).toBe(true);
  });

  it('creates the book from the approved clearance with the closed market in its snapshot', async () => {
    const profile = await prisma.rightsProfile.findUnique({
      where: { id: profileId },
      include: { reviews: true },
    });
    reviewId = profile!.reviews[0].id;

    await request(http())
      .post(`/admin/rights/intakes/${intakeId}/reviews/${reviewId}/approve`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ notesRu: 'Проверка принята' })
      .expect(201);

    const createdBook = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/create-book`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        slug: `clearance-geo-block-e2e-${Date.now()}`,
        versions: [
          {
            language: 'en',
            title: 'Clearance to geo-block e2e',
            author: 'Test Author',
            description: 'Publishable with geo restrictions',
            coverImageUrl: 'https://example.com/cover.jpg',
            type: 'text',
            isFree: true,
          },
        ],
      })
      .expect(201);

    bookId = createdBook.body.book.id as string;
    versionId = (createdBook.body.versions as Array<{ id: string }>)[0].id;

    const version = await prisma.bookVersion.findUnique({ where: { id: versionId } });
    expect(version?.rightsBlockedCountryCodes).toContain('GB');
    expect(version?.rightsGeoBlockRequired).toBe(true);
  });

  it('refuses to publish while the closed market has no runtime rule', async () => {
    const gate = await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(
      (gate.body.blockingReasons as Array<{ code: string }>).some((reason) =>
        ['GEO_BLOCK_RULES_MISSING', 'BLOCKED_COUNTRIES_REQUIRE_GEO_BLOCK'].includes(reason.code),
      ),
    ).toBe(true);

    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400);
  });

  it('projects the country decision into a runtime rule of a sufficient scope', async () => {
    const generated = await request(http())
      .post(`/admin/versions/${versionId}/geo-block-rules/generate`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(201);

    const rules = generated.body.rules as Array<{
      countryCode: string;
      scope: string;
      isActive: boolean;
      accessPolicy: string;
    }>;
    const gbRule = rules.find((rule) => rule.countryCode === 'GB');

    expect(gbRule).toBeTruthy();
    expect(gbRule?.isActive).toBe(true);
    expect(gbRule?.accessPolicy).toBe('BLOCK');
    // WP-3.1: частичный скоуп для закрытой целиком страны гейт не принимает.
    expect(['ENTIRE_BOOK', 'LANGUAGE_EDITION']).toContain(gbRule?.scope);
    expect(rules.some((rule) => rule.countryCode === 'US' && rule.isActive)).toBe(false);
  });

  it('publishes once the rules are generated and verified', async () => {
    await request(http())
      .post(`/admin/versions/${versionId}/geo-block-rules/verify`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ verified: true, notesRu: 'Проверены сценарии GB и US' })
      .expect(201);

    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    const chapter = await prisma.chapter.create({
      data: {
        bookVersionId: versionId,
        number: 1,
        title: 'Chapter one',
        content: 'Text of the first chapter',
      },
    });
    chapterId = chapter.id;
  });

  /**
   * Цель №2 продукта целиком: из закрытой проверкой страны читать нельзя,
   * из разрешённой — можно. Проверяются все точки входа читалки.
   */
  it('blocks reading from the closed market and keeps it open elsewhere', async () => {
    await request(http())
      .get(`/versions/${versionId}/chapters`)
      .set('X-Geo-Country', 'GB')
      .expect(451)
      .expect(({ body }) => {
        expect(body.code).toBe('GEO_BLOCKED_BY_RIGHTS');
      });

    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'GB').expect(451);

    await request(http())
      .get(`/versions/${versionId}/chapters`)
      .set('X-Geo-Country', 'US')
      .expect(200);

    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'US').expect(200);
  });

  /**
   * Продуктовое решение от 30.07.2026 (ADR-012): блокируются только чтение и
   * прослушивание, карточка книги остаётся видимой из любой страны.
   */
  it('keeps the book card visible from the closed market', async () => {
    const book = await prisma.book.findUnique({ where: { id: bookId } });

    await request(http()).get(`/books/slug/${book!.slug}`).set('X-Geo-Country', 'GB').expect(200);

    await request(http())
      .get(`/books/${book!.slug}/overview`)
      .set('X-Geo-Country', 'GB')
      .expect(200);

    await request(http()).get(`/books/${bookId}/versions`).set('X-Geo-Country', 'GB').expect(200);
  });

  /**
   * Публичное тело 451 не раскрывает внутренний `reasonRu`: он написан редактором
   * и регулярно содержит имена и детали (W1-01, фаза 16).
   */
  it('does not leak the internal reason to the blocked reader', async () => {
    const response = await request(http())
      .get(`/versions/${versionId}/chapters`)
      .set('X-Geo-Country', 'GB')
      .expect(451);

    expect(JSON.stringify(response.body)).not.toContain('Срок охраны');
  });
});
