/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookType, Language } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';

/**
 * WP-8.1 (R1-01) — участники в content hash, сквозная трассировка «HTTP-вход → эффект в БД».
 *
 * Сценарий отказа из отчёта ревью: книга проходит клиренс с переводчиком, умершим в 1940
 * (перевод в public domain), редактор меняет данные участника на переводчика, умершего
 * в 1990 (перевод под охраной) — и до WP-8 хеш не менялся, stale не выставлялся, гейт
 * разрешал публикацию под клиренсом для другого правового основания.
 *
 * Требует живой БД — локально `yarn test:e2e`, в CI job «Tests & Quality Checks».
 */
describe('Rights content hash — contributors (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let versionId: string;
  let personId: string;
  let bookWithRights: Awaited<ReturnType<typeof createBookWithRights>>;

  const slug = `hash-contributors-${Date.now()}`;
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const versionRow = async () =>
    prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: {
        rightsContentHash: true,
        rightsRecheckRequired: true,
        rightsStaleReasonCode: true,
        rightsStaleDetectedAt: true,
      },
    });

  /**
   * Возврат версии в «проверенное» состояние: WP-8 проверяет реакцию на каждое изменение
   * по отдельности, а один раз выставленный stale держится до новой проверки прав.
   */
  const rebaseline = async () => {
    const fresh = await request(http())
      .get(`/admin/versions/${versionId}/rights-content-hash`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await prisma.bookVersion.update({
      where: { id: versionId },
      data: {
        rightsContentHash: fresh.body.currentHash as string,
        rightsRecheckRequired: false,
        rightsStaleDetectedAt: null,
        rightsStaleReasonCode: null,
        rightsStaleReasonRu: null,
      },
    });
    await prisma.rightsReview.update({
      where: { id: bookWithRights.review.id },
      data: { status: 'HUMAN_APPROVED', staleDetectedAt: null, staleReasonCode: null },
    });
    await prisma.rightsProfile.update({
      where: { id: bookWithRights.profile.id },
      data: { status: 'APPROVED', staleDetectedAt: null, staleReasonCode: null },
    });
  };

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin-hash-contributors@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const email = 'admin-hash-contributors@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = reg.body.accessToken as string;
    } else {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = login.body.accessToken as string;
    }

    bookWithRights = await createBookWithRights(prisma, slug);

    const created = await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Contributors hash EN',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    versionId = created.body.id as string;

    const person = await request(http())
      .post('/admin/persons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        canonicalName: `Переводчик ${Date.now()}`,
        birthYear: 1870,
        deathYear: 1940,
        publicDomainFromYear: 2011,
      })
      .expect(201);
    personId = person.body.id as string;
  });

  afterAll(async () => {
    await prisma.bookVersionContributor.deleteMany({ where: { bookVersionId: versionId } });
    await cleanupBookWithRights(prisma, slug);
    await prisma.person.deleteMany({ where: { id: personId } });
    await app.close();
  });

  it('marks the clearance stale when a translator is added to the version', async () => {
    const before = await versionRow();
    expect(before?.rightsRecheckRequired).toBe(false);

    await request(http())
      .post(`/admin/versions/${versionId}/contributors`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ personId, role: 'TRANSLATOR' })
      .expect(201);

    const after = await versionRow();
    expect(after?.rightsRecheckRequired).toBe(true);
    expect(after?.rightsStaleReasonCode).toBe('VERSION_CONTRIBUTOR_CHANGED');
    // Baseline не переписывается: он и есть снимок «под чем проверяли».
    expect(after?.rightsContentHash).toBe(before?.rightsContentHash);

    // Клиренс уходит в STALE целиком — не только версия.
    const review = await prisma.rightsReview.findUnique({
      where: { id: bookWithRights.review.id },
      select: { status: true },
    });
    expect(review?.status).toBe('STALE');

    // Событие аудита: значение enum'а — существующее, точная причина в reasonCode (WP-8.1).
    const events = await prisma.rightsContentHashEvent.findMany({
      where: { bookVersionId: versionId, reasonCode: 'VERSION_CONTRIBUTOR_CHANGED' },
      select: { trigger: true, staleMarked: true, previousHash: true, currentHash: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0].trigger).toBe('RIGHTS_SNAPSHOT_CHANGED');
    expect(events[0].staleMarked).toBe(true);
    expect(events[0].previousHash).toBe(before?.rightsContentHash);
    expect(events[0].currentHash).not.toBe(events[0].previousHash);
  });

  it('marks the clearance stale when the death year of the translator changes', async () => {
    await rebaseline();
    const before = await versionRow();
    expect(before?.rightsRecheckRequired).toBe(false);

    await request(http())
      .patch(`/admin/persons/${personId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ deathYear: 1990, publicDomainFromYear: 2061 })
      .expect(200);

    const after = await versionRow();
    expect(after?.rightsRecheckRequired).toBe(true);
    expect(after?.rightsStaleReasonCode).toBe('CONTRIBUTOR_PERSON_CHANGED');

    const events = await prisma.rightsContentHashEvent.findMany({
      where: { bookVersionId: versionId, reasonCode: 'CONTRIBUTOR_PERSON_CHANGED' },
      select: { staleMarked: true, previousHash: true, currentHash: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0].staleMarked).toBe(true);
    expect(events[0].previousHash).toBe(before?.rightsContentHash);
    expect(events[0].currentHash).not.toBe(events[0].previousHash);
  });

  it('blocks publication of the version whose translator changed', async () => {
    const gate = await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const codes = (gate.body.blockingReasons as Array<{ code: string }>).map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['RIGHTS_RECHECK_REQUIRED']));

    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('leaves the clearance alone when only editorial fields of the person change', async () => {
    await rebaseline();
    const eventsBefore = await prisma.rightsContentHashEvent.count({
      where: { bookVersionId: versionId },
    });

    await request(http())
      .patch(`/admin/persons/${personId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notesRu: 'Уточнён источник даты смерти' })
      .expect(200);

    const after = await versionRow();
    expect(after?.rightsRecheckRequired).toBe(false);
    expect(after?.rightsStaleReasonCode).toBeNull();

    const hash = await request(http())
      .get(`/admin/versions/${versionId}/rights-content-hash`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(hash.body.matchesBaseline).toBe(true);

    // Ни правки версии, ни записи в аудит: правовые поля персоны не менялись.
    await expect(
      prisma.rightsContentHashEvent.count({ where: { bookVersionId: versionId } }),
    ).resolves.toBe(eventsBefore);
  });
});
