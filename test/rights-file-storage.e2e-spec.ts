/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * WP-9 — файловое хранение системы прав: сквозная трассировка от HTTP-входа до эффекта в БД.
 *
 * До WP-9 в системе прав не было файлов вообще: PDF-отчёт (требование roadmap фазы 3) положить
 * было некуда, манифест, отданный агенту, нигде не сохранялся — восстановить, под какое задание
 * написан принятый отчёт, было невозможно, — а доказательство существовало как один `url`,
 * который завтра отдаёт 404 вместе с обоснованием блокировки страны.
 *
 * Проверяется настоящий multipart-вход, настоящее приватное хранилище и настоящая запись в БД:
 * контрольную сумму считает сервер (правило WP-8.2), замена уже загруженного файла запрещена
 * во всех трёх путях, публичного URL у юридического файла нет — только скачивание под ролью.
 *
 * Требует живой БД — локально `yarn test:e2e`, в CI job «Tests & Quality Checks».
 */
describe('Rights file storage e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let intakeId: string;
  /** Импорт, у которого PDF-отчёт есть: на нём проверяются загрузка, отдача и запрет замены. */
  let importId: string;
  /** Импорт, у которого PDF-отчёта нет: на нём проверяются 415 и 404. */
  let pdfLessImportId: string;
  let profileId: string;
  let evidenceId: string;

  const runId = Date.now();

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const reportPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'utf-8',
  );
  const reportPdfSha256 = createHash('sha256').update(reportPdf).digest('hex');

  /** Сигнатура PNG: сервер MIME не «нюхает», но файл должен быть настоящими байтами. */
  const evidencePng = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('rights evidence archive copy e2e', 'utf-8'),
  ]);
  const evidencePngSha256 = createHash('sha256').update(evidencePng).digest('hex');

  /**
   * Колонки WP-9 добавлены той же задачей, что и этот тест, поэтому сгенерированный
   * Prisma-клиент про них не знает: `prisma generate` агенту запрещён (ADR-011), а без него
   * клиент не умеет ни выбирать новые поля, ни возвращать их. Читаем строку сырым SQL —
   * он идёт мимо схемы клиента и показывает то, что действительно лежит в базе.
   */
  const rawRow = async (
    sql: string,
    ...params: unknown[]
  ): Promise<Record<string, unknown> | undefined> => {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params);
    return rows[0];
  };

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
        url: 'https://www.gutenberg.org/ebooks/1342',
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
        candidateTitle: `Rights file storage e2e ${runId}`,
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

  it('publishes the upload limits the UI validates against', async () => {
    const limits = await request(http())
      .get('/admin/rights/files/limits')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(limits.body.maxSizeMb).toBeGreaterThan(0);
    expect(limits.body.allowedContentTypes.reportPdf).toEqual(['application/pdf']);
    expect(limits.body.allowedContentTypes.evidence).toContain('image/png');
  });

  /**
   * WP-9.1 (essence §15): манифест собирается на лету и несёт `generatedAt`, поэтому повторный
   * GET даёт другие байты. Если его не сохранить в момент выдачи, восстановить задним числом,
   * что именно получил агент, невозможно — а импорт обязан унести снимок задания с собой.
   */
  it('archives the manifest handed to the agent and copies its snapshot into the import', async () => {
    await request(http())
      .get(`/admin/rights/intakes/${intakeId}/agent-manifest`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    const intake = await rawRow(
      'SELECT "manifestStorageKey", "manifestSha256", "manifestVersion", "manifestGeneratedAt" FROM "RightsIntake" WHERE id = $1',
      intakeId,
    );
    expect(intake?.manifestStorageKey).toEqual(expect.stringContaining('input-manifest/'));
    expect(String(intake?.manifestSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(intake?.manifestVersion).toBeTruthy();
    expect(intake?.manifestGeneratedAt).toBeTruthy();

    const imported = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ reportJson: completeReport(), agentModel: 'e2e-agent-model' })
      .expect(201);

    expect(imported.body.importStatus).toBe('VALIDATED');
    importId = imported.body.id as string;

    const record = await rawRow(
      'SELECT "inputManifestStorageKey", "inputManifestSha256", "inputManifestVersion", "promptVersion", "agentModel", "reportJsonStorageKey" FROM "RightsReviewImport" WHERE id = $1',
      importId,
    );
    expect(record?.inputManifestSha256).toBe(intake?.manifestSha256);
    expect(record?.inputManifestStorageKey).toBe(intake?.manifestStorageKey);
    expect(record?.inputManifestVersion).toBe(intake?.manifestVersion);
    expect(record?.promptVersion).toBe(intake?.manifestVersion);
    expect(record?.agentModel).toBe('e2e-agent-model');
    expect(record?.reportJsonStorageKey).toEqual(expect.stringContaining('report-json/'));
  });

  // WP-9.2 (R4-02): контрольную сумму считает сервер — источник суммы, по которой сверяется
  // юридический артефакт, не может быть на стороне клиента.
  it('stores the uploaded report PDF and records the checksum computed by the server', async () => {
    const uploaded = await request(http())
      .post(`/admin/rights/review-imports/${importId}/report-pdf`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .attach('file', reportPdf, {
        filename: 'rights-report.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(uploaded.body.sha256).toBe(reportPdfSha256);
    expect(uploaded.body.sizeBytes).toBe(reportPdf.length);
    expect(uploaded.body.contentType).toBe('application/pdf');
    expect(uploaded.body.fileName).toBe('rights-report.pdf');
    expect(uploaded.body.storageKey).toEqual(expect.stringContaining('report-pdf/'));
    // Публичного URL у юридического файла нет и быть не должно.
    expect(uploaded.body.url).toBeUndefined();

    const record = await rawRow(
      'SELECT "reportPdfStorageKey", "reportPdfSha256", "reportPdfFileName", "reportPdfContentType", "reportPdfSizeBytes", "reportPdfUploadedAt", "reportPdfUploadedByUserId" FROM "RightsReviewImport" WHERE id = $1',
      importId,
    );
    expect(record?.reportPdfStorageKey).toBe(uploaded.body.storageKey);
    expect(record?.reportPdfSha256).toBe(reportPdfSha256);
    expect(record?.reportPdfFileName).toBe('rights-report.pdf');
    expect(record?.reportPdfContentType).toBe('application/pdf');
    expect(Number(record?.reportPdfSizeBytes)).toBe(reportPdf.length);
    expect(record?.reportPdfUploadedAt).toBeTruthy();
    expect(record?.reportPdfUploadedByUserId).toBeTruthy();
  });

  // Замена запрещена: объект в хранилище не удаляется (ADR-009), а перезапись ключа в БД
  // потеряла бы указатель на предыдущий файл. Исправленный отчёт — это новый импорт.
  it('refuses to replace an already uploaded report PDF and leaves the stored one intact', async () => {
    const before = await rawRow(
      'SELECT "reportPdfStorageKey", "reportPdfSha256" FROM "RightsReviewImport" WHERE id = $1',
      importId,
    );

    const rejected = await request(http())
      .post(`/admin/rights/review-imports/${importId}/report-pdf`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .attach('file', Buffer.from('%PDF-1.4\nsecond upload\n%%EOF\n', 'utf-8'), {
        filename: 'another.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);

    expect(rejected.body.code).toBe('REPORT_PDF_ALREADY_UPLOADED');

    const after = await rawRow(
      'SELECT "reportPdfStorageKey", "reportPdfSha256" FROM "RightsReviewImport" WHERE id = $1',
      importId,
    );
    expect(after?.reportPdfStorageKey).toBe(before?.reportPdfStorageKey);
    expect(after?.reportPdfSha256).toBe(reportPdfSha256);
  });

  it('rejects a non-PDF upload into the report-pdf slot with 415 and stores nothing', async () => {
    // Проверка типа стоит после проверки «уже загружен», поэтому нужен импорт без файла.
    const second = await request(http())
      .post(`/admin/rights/intakes/${intakeId}/review-imports`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ reportJson: completeReport() })
      .expect(201);

    expect(second.body.importStatus).toBe('VALIDATED');
    pdfLessImportId = second.body.id as string;

    await request(http())
      .post(`/admin/rights/review-imports/${pdfLessImportId}/report-pdf`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .attach('file', evidencePng, { filename: 'scan.png', contentType: 'image/png' })
      .expect(415);

    const record = await rawRow(
      'SELECT "reportPdfStorageKey", "reportPdfSha256" FROM "RightsReviewImport" WHERE id = $1',
      pdfLessImportId,
    );
    expect(record?.reportPdfStorageKey).toBeNull();
    expect(record?.reportPdfSha256).toBeNull();
  });

  it('returns exactly the uploaded bytes as a private attachment', async () => {
    const downloaded = await request(http())
      .get(`/admin/rights/review-imports/${importId}/report-pdf`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .responseType('blob')
      .expect(200);

    const body = downloaded.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.equals(reportPdf)).toBe(true);
    expect(createHash('sha256').update(body).digest('hex')).toBe(reportPdfSha256);

    expect(downloaded.headers['content-type']).toContain('application/pdf');
    expect(downloaded.headers['content-disposition']).toContain('attachment');
    expect(downloaded.headers['content-disposition']).toContain('rights-report.pdf');
    expect(downloaded.headers['cache-control']).toContain('private');
  });

  it('answers 404 with a diagnosis when the import has no report PDF', async () => {
    const missing = await request(http())
      .get(`/admin/rights/review-imports/${pdfLessImportId}/report-pdf`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(404);

    expect(missing.body.code).toBe('REPORT_PDF_NOT_UPLOADED');
  });

  /**
   * WP-9.3 (R3-08): доказательство хранилось одним внешним URL. Копию загружает редактор —
   * сервер по внешним адресам не ходит.
   */
  it('stores an archived copy of the evidence and marks the row as archived', async () => {
    const materialized = await request(http())
      .post(`/admin/rights/review-imports/${pdfLessImportId}/materialize`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(201);

    profileId = materialized.body.id as string;

    const evidence = await prisma.rightsEvidence.findFirst({
      where: { rightsProfileId: profileId },
      select: { id: true },
    });
    expect(evidence).not.toBeNull();
    evidenceId = evidence!.id;

    const uploaded = await request(http())
      .post(`/admin/rights/evidence/${evidenceId}/archive-copy`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .attach('file', evidencePng, { filename: 'pg-page.png', contentType: 'image/png' })
      .expect(201);

    expect(uploaded.body.sha256).toBe(evidencePngSha256);
    expect(uploaded.body.sizeBytes).toBe(evidencePng.length);
    expect(uploaded.body.storageKey).toEqual(expect.stringContaining('evidence/'));

    const record = await rawRow(
      'SELECT "storageKey", "fileSha256", "fileName", "contentType", "sizeBytes", "isArchivedCopy", "archivedAt", "archivedByUserId", "isCurrent", "supersededById" FROM "RightsEvidence" WHERE id = $1',
      evidenceId,
    );
    expect(record?.storageKey).toBe(uploaded.body.storageKey);
    expect(record?.fileSha256).toBe(evidencePngSha256);
    expect(record?.fileName).toBe('pg-page.png');
    expect(record?.contentType).toBe('image/png');
    expect(Number(record?.sizeBytes)).toBe(evidencePng.length);
    expect(record?.isArchivedCopy).toBe(true);
    expect(record?.archivedAt).toBeTruthy();
    expect(record?.archivedByUserId).toBeTruthy();
    // Загрузка копии не трогает действительность доказательства.
    expect(record?.isCurrent).toBe(true);
    expect(record?.supersededById).toBeNull();
  });

  it('returns exactly the uploaded evidence bytes and refuses to replace them', async () => {
    const downloaded = await request(http())
      .get(`/admin/rights/evidence/${evidenceId}/archive-copy`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .responseType('blob')
      .expect(200);

    expect((downloaded.body as Buffer).equals(evidencePng)).toBe(true);
    expect(downloaded.headers['content-disposition']).toContain('attachment');

    const rejected = await request(http())
      .post(`/admin/rights/evidence/${evidenceId}/archive-copy`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .attach('file', Buffer.from('another copy', 'utf-8'), {
        filename: 'other.png',
        contentType: 'image/png',
      })
      .expect(400);

    expect(rejected.body.code).toBe('EVIDENCE_ARCHIVE_ALREADY_UPLOADED');

    const record = await rawRow(
      'SELECT "fileSha256" FROM "RightsEvidence" WHERE id = $1',
      evidenceId,
    );
    expect(record?.fileSha256).toBe(evidencePngSha256);
  });

  // Удалить доказательство нельзя (ADR-009), поэтому «оно больше не действует» выражается
  // ссылкой на преемника — и ссылка на самого себя такой заменой не является.
  it('refuses to let an evidence supersede itself', async () => {
    const rejected = await request(http())
      .patch(`/admin/rights/evidence/${evidenceId}/supersede`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ supersededById: evidenceId })
      .expect(400);

    expect(rejected.body.code).toBe('EVIDENCE_SELF_SUPERSESSION');

    const record = await rawRow(
      'SELECT "isCurrent", "supersededById" FROM "RightsEvidence" WHERE id = $1',
      evidenceId,
    );
    expect(record?.isCurrent).toBe(true);
    expect(record?.supersededById).toBeNull();
  });
});
