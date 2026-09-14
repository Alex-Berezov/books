/* eslint-disable @typescript-eslint/no-unsafe-member-access -- тела ответов supertest типизированы как any, и обращение к их полям иначе краснит в каждой строке проверок; тот же приём в соседних e2e правового контура */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Сквозной прогон кейса По в строгом режиме: чистый public-domain материал проходит путь
 * от интейка до опубликованной версии, а требование юридического заключения этот путь
 * останавливает, пока заключения нет.
 *
 * 🔴 Этот набор намеренно **не выставляет ни одной переменной `RIGHTS_*`** и прогоняется
 * на умолчаниях кода: заключение юриста требуется с риска `HIGH`
 * (`rights-risk-assessment.service.ts`, дефолт `RightsRiskLevel.HIGH`), блокировка утверждения
 * включена, просроченная перепроверка блокирует публикацию (`rights-recheck.service.ts`,
 * дефолт `'1'`). Соседние наборы свои значения `RIGHTS_*` ставят, а при `--runInBand` все они
 * живут в одном процессе — поэтому `beforeAll` эти переменные снимает, иначе набор проверял бы
 * чужую настройку вместо умолчания. Единственное исключение — `RIGHTS_RECHECK_SCHEDULER_ENABLED`:
 * она выключает фоновый скан, в утверждениях набора не участвует и выставляется явно (решение
 * арбитра 14.09.2026, `books-app-docs/ai-context/decisions-log.md`).
 *
 * Чем он ценен: ослабление любого из умолчаний в самом коде (возврат временного обхода,
 * снятого в проде 14.09.2026) краснит именно здесь. Пинить пороги внутри набора нельзя —
 * закреплённый порог переживёт ослабление дефолта и проверка станет бессмысленной.
 *
 * Требует живой базы: запускать вместе с остальными e2e (`yarn test:e2e:serial`).
 */
describe('Rights clearance in strict mode e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;

  const createdIntakeIds: string[] = [];
  const createdBookIds: string[] = [];
  const createdLawyerIds: string[] = [];

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const auth = (): [string, string] => ['Authorization', `Bearer ${adminAccess}`];

  /** Чистый public-domain отчёт: ни одного фактора риска выше LOW. */
  const cleanReport = (intakeId: string): Record<string, unknown> => ({
    schemaVersion: '1.0',
    intakeId,
    overallStatus: 'PUBLISHABLE',
    publicationGate: 'ALLOW',
    summaryRu: 'Текст в общественном достоянии',
    conclusionRu: 'Публикация допустима во всех целевых странах',
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
        titleRu: 'Текст произведения',
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
        title: 'Project Gutenberg page',
        authority: 'Project Gutenberg',
        summaryRu: 'Страница издания на Project Gutenberg',
      },
    ],
    confidence: 'HIGH',
    nextReviewAt: '2030-01-01T00:00:00.000Z',
  });

  /**
   * Тот же материал, но с сохраняемым компонентом `UNCERTAIN` — фактор риска уровня `HIGH`
   * (`rights-risk.util.ts`, блок `UNCERTAIN_COMPONENT`). Ровно на этом и проверяется, что порог
   * вызова юриста берётся из умолчания, а не из снятой переменной окружения.
   */
  const riskyReport = (intakeId: string): Record<string, unknown> => ({
    ...cleanReport(intakeId),
    summaryRu: 'Текст свободен, но по иллюстрациям издания ясности нет',
    conclusionRu: 'Нужна оценка юриста по иллюстрациям',
    componentAssessments: [
      {
        componentType: 'ORIGINAL_TEXT',
        titleRu: 'Текст произведения',
        status: 'PUBLIC_DOMAIN',
        requiredAction: 'KEEP',
        confidence: 'HIGH',
      },
      {
        componentType: 'ILLUSTRATION',
        titleRu: 'Иллюстрации издания',
        status: 'UNCERTAIN',
        requiredAction: 'KEEP',
        confidence: 'LOW',
      },
    ],
  });

  /**
   * Заводит интейк, импортирует отчёт и материализует его. Возвращает профиль и его проверку.
   * Отчёт приходит построителем, а не зашит внутри: тело `POST /admin/rights/intakes` за этап
   * смягчения менялось трижды, и вторая копия этой цепочки отстала бы от первой молча.
   */
  const runClearance = async (
    title: string,
    buildReport: (intakeId: string) => Record<string, unknown> = cleanReport,
  ): Promise<{ intakeId: string; profileId: string; reviewId: string }> => {
    const created = await request(http())
      .post('/admin/rights/intakes')
      .set(...auth())
      .send({
        candidateTitle: title,
        candidateAuthor: 'Edgar Allan Poe',
        sourceProvider: 'PROJECT_GUTENBERG',
        sourceTextType: 'ORIGINAL_TEXT',
        targetLanguages: ['en'],
        targetCountryCodes: ['US'],
        plannedContentTypes: ['text'],
      })
      .expect(201);

    const intakeId = created.body.id as string;
    createdIntakeIds.push(intakeId);

    await request(http())
      .patch(`/admin/rights/intakes/${intakeId}/status`)
      .set(...auth())
      .send({ status: 'READY_FOR_AGENT' })
      .expect(200);

    const imported = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports`)
      .set(...auth())
      .send({ reportJson: buildReport(intakeId) })
      .expect(201);

    expect(imported.body.importStatus).toBe('VALIDATED');

    const materialized = await request(http())
      .post(`/admin/rights/review-imports/${imported.body.id as string}/materialize`)
      .set(...auth())
      .expect(201);

    return {
      intakeId,
      profileId: materialized.body.id as string,
      reviewId: materialized.body.reviews[0].id as string,
    };
  };

  /**
   * Утверждает проверку и создаёт книгу с одной версией. Возвращает идентификатор версии.
   * Имя называет оба шага нарочно: утверждение здесь — правовой шаг, и кейсу, которому нужна
   * версия без него, этот помощник не подходит.
   */
  const approveAndCreateVersion = async (
    intakeId: string,
    reviewId: string,
    slug: string,
  ): Promise<string> => {
    await request(http())
      .post(`/admin/rights/intakes/${intakeId}/reviews/${reviewId}/approve`)
      .set(...auth())
      .send({ notesRu: 'Проверка принята' })
      .expect(201);

    const book = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/create-book`)
      .set(...auth())
      .send({
        slug,
        versions: [
          {
            language: 'en',
            title: 'The Raven',
            author: 'Edgar Allan Poe',
            description: 'Издание в общественном достоянии, заведённое для e2e строгого режима.',
            coverImageUrl: 'https://example.com/cover.jpg',
            type: 'text',
            isFree: true,
          },
        ],
      })
      .expect(201);

    createdBookIds.push(book.body.book.id as string);

    return book.body.versions[0].id as string;
  };

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';

    // Умолчания кода — предмет этого набора, поэтому чужие значения снимаются, а свои не ставятся.
    delete process.env.RIGHTS_LAWYER_MIN_RISK_LEVEL;
    delete process.env.RIGHTS_LAWYER_WORKFLOW_ENABLED;
    delete process.env.RIGHTS_LAWYER_BLOCK_APPROVAL_ON_HIGH_RISK;
    delete process.env.RIGHTS_RECHECK_BLOCK_PUBLISH_ON_OVERDUE;
    // Фоновый скан — единственная `RIGHTS_*`, которую набор выставляет, и это решение арбитра
    // от 14.09.2026 (`decisions-log.md`): в утверждениях он не участвует — задачу перепроверки
    // набор заводит сам вызовом `POST /admin/rights/recheck/scan`. На умолчании «включён» первый
    // автоскан идёт через 60 с (`rights-recheck.constants.ts`) и отбирает у набора его же ручной
    // запуск отказом 409 `RECHECK_SCAN_ALREADY_RUNNING`, то есть кейс краснел бы от длительности
    // прогона, а не от регрессии. Явное значение заодно снимает зависимость от порядка файлов.
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
    // Книги удаляются отдельно: `Book.rightsIntakeId` объявлен `onDelete: SetNull`
    // (`prisma/schema.prisma`), поэтому удаление интейка оставило бы в базе воркера
    // опубликованную книгу без правовой цепочки — ровно то состояние, которое ищут
    // соседние проверки утечки черновиков.
    for (const bookId of createdBookIds) {
      await prisma.book.delete({ where: { id: bookId } }).catch(() => undefined);
    }
    for (const intakeId of createdIntakeIds) {
      await prisma.rightsIntake.delete({ where: { id: intakeId } }).catch(() => undefined);
    }
    for (const lawyerId of createdLawyerIds) {
      await prisma.rightsLawyer.delete({ where: { id: lawyerId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('держит умолчания правового контура: четыре предохранителя не заданы, скан выключен', () => {
    expect(process.env.RIGHTS_LAWYER_MIN_RISK_LEVEL).toBeUndefined();
    expect(process.env.RIGHTS_LAWYER_WORKFLOW_ENABLED).toBeUndefined();
    expect(process.env.RIGHTS_LAWYER_BLOCK_APPROVAL_ON_HIGH_RISK).toBeUndefined();
    expect(process.env.RIGHTS_RECHECK_BLOCK_PUBLISH_ON_OVERDUE).toBeUndefined();
    expect(process.env.RIGHTS_RECHECK_SCHEDULER_ENABLED).toBe('0');
  });

  describe('чистый public-domain кейс доходит до опубликованной версии', () => {
    let intakeId: string;
    let profileId: string;
    let reviewId: string;
    let versionId: string;

    it('материализует отчёт агента без требования юриста', async () => {
      ({ intakeId, profileId, reviewId } = await runClearance('Poe strict-mode e2e'));

      const assessment = await request(http())
        .get(`/admin/rights/profiles/${profileId}/risk-assessment`)
        .set(...auth())
        .expect(200);

      // Порог берётся из умолчания (HIGH): чистый кейс до него не дотягивает.
      expect(assessment.body.minRiskLevel).toBe('HIGH');
      expect(assessment.body.riskLevel).toBe('LOW');
      expect(assessment.body.lawyerReviewRequired).toBe(false);
    });

    it('утверждает проверку и создаёт книгу', async () => {
      versionId = await approveAndCreateVersion(
        intakeId,
        reviewId,
        `poe-strict-mode-e2e-${Date.now()}`,
      );

      const version = await prisma.bookVersion.findUnique({ where: { id: versionId } });
      expect(version?.status).toBe('draft');
    });

    it('публикационный гейт зелёный и не держит ни одной правовой причины', async () => {
      const gate = await request(http())
        .get(`/admin/versions/${versionId}/publication-gate`)
        .set(...auth())
        .expect(200);

      expect(gate.body.blockingReasons).toEqual([]);
      expect(gate.body.canPublish).toBe(true);
      expect(gate.body.lawyerReviewRequired).toBe(false);
      expect(gate.body.blockingRecheckTasksCount).toBe(0);
    });

    it('публикует версию', async () => {
      await request(http())
        .patch(`/versions/${versionId}/publish`)
        .set(...auth())
        .expect(200);

      const version = await prisma.bookVersion.findUnique({ where: { id: versionId } });
      expect(version?.status).toBe('published');
    });

    /**
     * Второе умолчание строгого режима: `blockPublishOnOverdue` (`rights-recheck.service.ts`,
     * дефолт `'1'`). Соседний набор `rights-recheck.e2e-spec.ts` его проверяет, но пинит
     * переменную на `'1'` в `beforeAll`, поэтому ослабление самого дефолта переживает —
     * здесь переменной нет, и та же ветка стережёт умолчание.
     */
    it('просроченная перепроверка закрывает публикационный гейт', async () => {
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

      const gate = await request(http())
        .get(`/admin/versions/${versionId}/publication-gate`)
        .set(...auth())
        .expect(200);

      expect(gate.body.canPublish).toBe(false);
      expect(
        (gate.body.blockingReasons as Array<{ code: string }>).some(
          (reason) => reason.code === 'RIGHTS_RECHECK_OVERDUE',
        ),
      ).toBe(true);
      expect(gate.body.overdueRecheckTasksCount).toBeGreaterThan(0);

      // Гейт закрывается на будущее, а уже опубликованная версия с витрины не снимается:
      // это работа претензий и задач перепроверки, а не самого гейта.
      const version = await prisma.bookVersion.findUnique({ where: { id: versionId } });
      expect(version?.status).toBe('published');
    });
  });

  describe('риск HIGH не пускает материал дальше без заключения юриста', () => {
    let intakeId: string;
    let profileId: string;
    let reviewId: string;
    let versionId: string;
    let lawyerReviewId: string;
    let lawyerId: string;

    it('материализует рискованный отчёт и требует юриста по умолчанию порога', async () => {
      ({ intakeId, profileId, reviewId } = await runClearance(
        'Poe strict-mode lawyer e2e',
        riskyReport,
      ));

      const assessment = await request(http())
        .get(`/admin/rights/profiles/${profileId}/risk-assessment`)
        .set(...auth())
        .expect(200);

      // Порог не задан переменной — работает умолчание HIGH, и оно срабатывает.
      expect(assessment.body.minRiskLevel).toBe('HIGH');
      expect(assessment.body.riskLevel).toBe('HIGH');
      expect(assessment.body.lawyerReviewRequired).toBe(true);
    });

    it('отказывает в обычном утверждении с LAWYER_APPROVAL_REQUIRED', async () => {
      const refused = await request(http())
        .post(`/admin/rights/intakes/${intakeId}/reviews/${reviewId}/approve`)
        .set(...auth())
        .send({ notesRu: 'попытка утвердить без юриста' })
        .expect(409);

      expect(refused.body.code).toBe('LAWYER_APPROVAL_REQUIRED');
      expect(refused.body.details.riskLevel).toBe('HIGH');
    });

    it('открытая проверка блокирует утверждение, пока заключения нет', async () => {
      const required = await request(http())
        .post(`/admin/rights/profiles/${profileId}/require-lawyer-review`)
        .set(...auth())
        .send({ questionRu: 'Подтвердить общественное достояние для США?' })
        .expect(201);

      lawyerReviewId = required.body.id as string;
      expect(required.body.blocksApproval).toBe(true);
      expect(required.body.status).toBe('PENDING');

      // Интейк ушёл в `LAWYER_REVIEW_REQUIRED`, и утверждение из этого статуса отвергается
      // раньше правовой проверки — отказ здесь 400, а не 409 предыдущего шага.
      const refused = await request(http())
        .post(`/admin/rights/intakes/${intakeId}/reviews/${reviewId}/approve`)
        .set(...auth())
        .send({ notesRu: 'вторая попытка, проверка ещё открыта' })
        .expect(400);

      // Отказ именно от белого списка статусов (`APPROVABLE_INTAKE_STATUSES`), а не от
      // `ValidationPipe`: тот же 400 от проверки тела оставил бы кейс зелёным впустую.
      expect(String(refused.body.message)).toContain('LAWYER_REVIEW_REQUIRED');

      const intake = await request(http())
        .get(`/admin/rights/intakes/${intakeId}`)
        .set(...auth())
        .expect(200);

      expect(intake.body.workflowStatus).toBe('LAWYER_REVIEW_REQUIRED');
    });

    it('после положительного заключения путь открывается и версия публикуется', async () => {
      const lawyer = await request(http())
        .post('/admin/rights/lawyers')
        .set(...auth())
        .send({
          fullName: 'Проверяющий Юрист Строгого Режима',
          lawyerType: 'EXTERNAL_COUNSEL',
          organization: 'Юридическое бюро',
          jurisdictionCodes: ['US'],
        })
        .expect(201);

      lawyerId = lawyer.body.id as string;
      createdLawyerIds.push(lawyerId);

      await request(http())
        .post(`/admin/rights/lawyer-reviews/${lawyerReviewId}/assign`)
        .set(...auth())
        .send({ lawyerId })
        .expect(201);

      const decided = await request(http())
        .post(`/admin/rights/lawyer-reviews/${lawyerReviewId}/decide`)
        .set(...auth())
        .send({
          decision: 'APPROVED',
          lawyerId,
          opinionSummaryRu: 'Произведение в общественном достоянии, публикация допустима.',
        })
        .expect(201);

      expect(decided.body.status).toBe('APPROVED');

      versionId = await approveAndCreateVersion(
        intakeId,
        reviewId,
        `poe-strict-lawyer-e2e-${Date.now()}`,
      );

      const gate = await request(http())
        .get(`/admin/versions/${versionId}/publication-gate`)
        .set(...auth())
        .expect(200);

      expect(
        (gate.body.blockingReasons as Array<{ code: string }>).some((reason) =>
          reason.code.startsWith('LAWYER_'),
        ),
      ).toBe(false);
      expect(gate.body.canPublish).toBe(true);

      await request(http())
        .patch(`/versions/${versionId}/publish`)
        .set(...auth())
        .expect(200);
    });

    /**
     * Тот самый блокер `LAWYER_REVIEW_REQUIRED_NOT_APPROVED`
     * (`rights-lawyer-review.service.ts`): риск требует заключения, а действующего заключения
     * нет. До сих пор он жил только в юнитах на моках. Отзыв переводит проверку в `WITHDRAWN` —
     * статус терминальный и не открытый, поэтому `LAWYER_REVIEW_PENDING` не появляется и код
     * виден отдельно.
     */
    it('отзыв заключения возвращает блокер LAWYER_REVIEW_REQUIRED_NOT_APPROVED', async () => {
      await request(http())
        .post(`/admin/rights/lawyer-reviews/${lawyerReviewId}/withdraw`)
        .set(...auth())
        .send({ reasonRu: 'Заключение отозвано для проверки строгого режима' })
        .expect(201);

      const gate = await request(http())
        .get(`/admin/versions/${versionId}/publication-gate`)
        .set(...auth())
        .expect(200);

      expect(gate.body.canPublish).toBe(false);
      expect(gate.body.lawyerReviewRequired).toBe(true);
      expect(gate.body.lawyerApproved).toBe(false);
      expect(
        (gate.body.blockingReasons as Array<{ code: string }>).some(
          (reason) => reason.code === 'LAWYER_REVIEW_REQUIRED_NOT_APPROVED',
        ),
      ).toBe(true);
    });
  });
});
