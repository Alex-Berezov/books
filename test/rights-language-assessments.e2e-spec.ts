/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * WP-7 — языковое измерение модели прав (R2-01, R3-01, R4-03).
 * Сквозная трассировка от HTTP-входа до строк в БД.
 *
 * До WP-7 блок `languageAssessments` требовался манифестом, проверялся валидатором на покрытие
 * каждого целевого языка — и выбрасывался при материализации: `EditionRights` создавалась одна
 * на исходное издание и дословно копировала его `status`/`notesRu`. Вердикт агента по каждому
 * языку, включая предупреждение о промежуточном переводе, не доходил никуда.
 *
 * Требует живой БД — локально `yarn test:e2e`, в CI job «Tests & Quality Checks».
 * Новые колонки читаются через delegate-интерфейс (ADR-011), как и в продуктовом коде.
 */
describe('Rights language assessments e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let intakeId: string;
  let importId: string;
  let profileId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  interface EditionRightsRow {
    id: string;
    sourceEditionId: string;
    languageCode: string;
    status: string;
    notesRu: string | null;
    translationOrigin: string;
    translationSourceLanguage: string | null;
    requiresGeoBlock: boolean;
  }

  interface RightsComponentRow {
    id: string;
    componentType: string;
    languageCode: string | null;
  }

  const editionRightsDelegate = () =>
    (prisma as unknown as Record<string, unknown>)['editionRights'] as {
      findMany: (args: Record<string, unknown>) => Promise<EditionRightsRow[]>;
    };

  const rightsComponentDelegate = () =>
    (prisma as unknown as Record<string, unknown>)['rightsComponent'] as {
      findMany: (args: Record<string, unknown>) => Promise<RightsComponentRow[]>;
    };

  const report = (): Record<string, unknown> => ({
    schemaVersion: '1.0',
    intakeId,
    overallStatus: 'PUBLISHABLE',
    publicationGate: 'ALLOW',
    summaryRu: 'Пригодно к публикации',
    conclusionRu: 'Оригинал в общественном достоянии, русский перевод требует лицензии',
    confidence: 'HIGH',
    nextReviewAt: '2027-01-01T00:00:00.000Z',
    sourceAssessment: {
      provider: 'PROJECT_GUTENBERG',
      status: 'ALLOWED',
      sourceTextType: 'ORIGINAL_TEXT',
      sourceLanguage: 'en',
      notesRu: 'Заметка про исходное издание',
    },
    languageAssessments: [
      {
        languageCode: 'en',
        status: 'ALLOWED',
        translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
        requiresGeoBlock: false,
        notesRu: 'Оригинальный текст',
      },
      {
        languageCode: 'ru',
        status: 'LICENSE_REQUIRED',
        translationOrigin: 'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION',
        translationSourceLanguage: 'fr',
        requiresGeoBlock: true,
        notesRu: 'Перевод сделан с французского перевода',
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
      {
        componentType: 'TRANSLATION',
        titleRu: 'Русский перевод',
        languageCode: 'ru',
        status: 'COPYRIGHTED',
        requiredAction: 'OBTAIN_LICENSE',
        confidence: 'HIGH',
      },
      {
        componentType: 'COVER',
        titleRu: 'Обложка',
        status: 'OWNED',
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
        candidateTitle: 'Language dimension e2e',
        candidateAuthor: 'Test Author',
        sourceProvider: 'PROJECT_GUTENBERG',
        sourceTextType: 'ORIGINAL_TEXT',
        targetLanguages: ['en', 'ru'],
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

  /**
   * WP-7.1: языковой блок стал приёмником модели прав, поэтому его поля обязательны —
   * отчёт без них раньше принимался как `VALIDATED`.
   */
  it('rejects a language block without the fields the rights record needs', async () => {
    const broken = report();
    const assessments = broken.languageAssessments as Array<Record<string, unknown>>;
    delete assessments[0].translationOrigin;
    delete assessments[1].requiresGeoBlock;
    delete assessments[1].translationSourceLanguage;

    const rejected = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ reportJson: broken })
      .expect(201);

    expect(rejected.body.importStatus).toBe('VALIDATION_FAILED');

    const missing = (rejected.body.validationErrors as Array<Record<string, string>>)
      .filter((issue) => issue.code === 'MISSING_FIELD')
      .map((issue) => issue.path);
    expect(missing).toEqual(
      expect.arrayContaining([
        'languageAssessments[0].translationOrigin',
        'languageAssessments[1].requiresGeoBlock',
        'languageAssessments[1].translationSourceLanguage',
      ]),
    );

    const intake = await prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    expect(intake?.workflowStatus).toBe('READY_FOR_AGENT');
  });

  it('accepts the complete report and warns about the intermediate translation', async () => {
    const imported = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ reportJson: report() })
      .expect(201);

    expect(imported.body.importStatus).toBe('VALIDATED');
    importId = imported.body.id as string;

    const warnings = (imported.body.validationWarnings ?? []) as Array<Record<string, string>>;
    expect(warnings.some((w) => w.code === 'INTERMEDIATE_TRANSLATION')).toBe(true);
  });

  /**
   * WP-7.3: главная трассировка пакета — вердикт агента по каждому языку доезжает до строки
   * в БД, а не растворяется в копии исходного издания.
   */
  it('materializes one EditionRights row per assessed language', async () => {
    const materialized = await request(http())
      .post(`/admin/rights/review-imports/${importId}/materialize`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(201);

    profileId = materialized.body.id as string;

    const sourceEdition = await prisma.sourceEdition.findFirst({
      where: { rightsProfileId: profileId },
    });
    expect(sourceEdition).not.toBeNull();

    const rows = await editionRightsDelegate().findMany({
      where: { sourceEditionId: sourceEdition!.id },
      orderBy: { languageCode: 'asc' },
    });

    expect(rows.map((r) => r.languageCode)).toEqual(['en', 'ru']);

    const [en, ru] = rows;
    expect(en).toEqual(
      expect.objectContaining({
        status: 'ALLOWED',
        translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
        translationSourceLanguage: null,
        requiresGeoBlock: false,
        notesRu: 'Оригинальный текст',
      }),
    );
    expect(ru).toEqual(
      expect.objectContaining({
        status: 'LICENSE_REQUIRED',
        translationOrigin: 'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION',
        translationSourceLanguage: 'fr',
        requiresGeoBlock: true,
      }),
    );

    // Статус языка больше не копия статуса издания: источник ALLOWED, русский — LICENSE_REQUIRED.
    expect(sourceEdition!.status).toBe('ALLOWED');
    expect(ru.status).not.toBe(sourceEdition!.status);
  });

  // WP-7.2: компонент несёт язык, а общий для всех языков компонент — не несёт.
  it('stores the language of a translated component and leaves a shared component languageless', async () => {
    const components = await rightsComponentDelegate().findMany({
      where: { rightsProfileId: profileId },
    });

    const byType = new Map(components.map((c) => [c.componentType, c.languageCode]));
    expect(byType.get('TRANSLATION')).toBe('ru');
    expect(byType.get('COVER')).toBeNull();
    expect(byType.get('ORIGINAL_TEXT')).toBeNull();
  });

  // WP-7.4 берёт языковой срез именно отсюда.
  it('serves the language slice through the rights profile endpoint', async () => {
    const detail = await request(http())
      .get(`/admin/rights/profiles/${profileId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    const editionRights = detail.body.sourceEdition.editionRights as Array<Record<string, unknown>>;
    expect(Array.isArray(editionRights)).toBe(true);
    expect(editionRights).toHaveLength(2);
    expect(editionRights[1]).toEqual(
      expect.objectContaining({
        languageCode: 'ru',
        status: 'LICENSE_REQUIRED',
        translationOrigin: 'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION',
        translationSourceLanguage: 'fr',
        requiresGeoBlock: true,
      }),
    );

    const translation = (detail.body.components as Array<Record<string, unknown>>).find(
      (c) => c.componentType === 'TRANSLATION',
    );
    expect(translation?.languageCode).toBe('ru');
  });
});
